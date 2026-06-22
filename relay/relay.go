// BrowserOS Virtual Switch Relay (Go, single binary)
// ===========================================================================
// Same as relay.js: a WebSocket virtual L2 switch + DHCP that gives each
// browser-tab VM a UNIQUE IP and forwards Ethernet frames between them so they
// can ping/SSH each other.
//
// Build:  go build -o browseros-relay relay.go
// Run:    ./browseros-relay           (ws://127.0.0.1:9000)
// LAN:    BROWSEROS_ALLOW_LAN=1 ./browseros-relay
// In BrowserOS: Network -> Relay URL = ws://<host-ip>:9000
//
// Uses only the stdlib + a tiny inline WebSocket server (RFC6455, binary
// frames) so there are NO external dependencies.
package main

import (
	"bufio"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"net"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
)

const (
	subnet        = "10.5.0"
	gateway       = subnet + ".1"
	maxFrameSize  = 65536
	maxHeaderSize = 16 << 10
	maxClients    = 64
)

var gwMAC = []byte{0x02, 0x00, 0x00, 0x00, 0x00, 0x01}

type client struct {
	conn net.Conn
	mac  string
	ip   string
	mu   sync.Mutex
}

var (
	mu       sync.Mutex
	clients  = map[*client]bool{}
	macTable = map[string]*client{}
	nextHost = 2
)

func allocIP() string {
	ip := fmt.Sprintf("%s.%d", subnet, nextHost)
	if nextHost >= 250 {
		nextHost = 2
	} else {
		nextHost++
	}
	return ip
}

func ip2b(s string) []byte {
	var b [4]byte
	parts := strings.Split(s, ".")
	for i := 0; i < 4 && i < len(parts); i++ {
		var v int
		fmt.Sscanf(parts[i], "%d", &v)
		b[i] = byte(v)
	}
	return b[:]
}
func macStr(b []byte) string {
	return fmt.Sprintf("%02x:%02x:%02x:%02x:%02x:%02x", b[0], b[1], b[2], b[3], b[4], b[5])
}
func ipChecksum(buf []byte) uint16 {
	var sum uint32
	for i := 0; i+1 < len(buf); i += 2 {
		sum += uint32(buf[i])<<8 | uint32(buf[i+1])
	}
	for sum>>16 != 0 {
		sum = (sum & 0xffff) + (sum >> 16)
	}
	return ^uint16(sum)
}

// ---- minimal WebSocket (server side, binary frames) ----
func wsAccept(key string) string {
	h := sha1.New()
	h.Write([]byte(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))
	return base64.StdEncoding.EncodeToString(h.Sum(nil))
}
func wsWrite(c net.Conn, payload []byte) error {
	var hdr []byte
	n := len(payload)
	hdr = append(hdr, 0x82) // FIN + binary
	switch {
	case n < 126:
		hdr = append(hdr, byte(n))
	case n < 65536:
		hdr = append(hdr, 126, byte(n>>8), byte(n))
	default:
		hdr = append(hdr, 127, 0, 0, 0, 0, byte(n>>24), byte(n>>16), byte(n>>8), byte(n))
	}
	_, err := c.Write(append(hdr, payload...))
	return err
}
func wsRead(r *bufio.Reader) ([]byte, error) {
	b0, err := r.ReadByte()
	if err != nil {
		return nil, err
	}
	opcode := b0 & 0x0f
	if b0&0x80 == 0 {
		return nil, fmt.Errorf("fragmented websocket frames are unsupported")
	}
	b1, err := r.ReadByte()
	if err != nil {
		return nil, err
	}
	masked := b1&0x80 != 0
	if !masked {
		return nil, fmt.Errorf("client websocket frame is not masked")
	}
	ln := int(b1 & 0x7f)
	if ln == 126 {
		var e [2]byte
		if _, err = readFull(r, e[:]); err != nil {
			return nil, err
		}
		ln = int(binary.BigEndian.Uint16(e[:]))
	} else if ln == 127 {
		var e [8]byte
		if _, err = readFull(r, e[:]); err != nil {
			return nil, err
		}
		if e[0]|e[1]|e[2]|e[3] != 0 {
			return nil, fmt.Errorf("websocket frame too large")
		}
		ln = int(binary.BigEndian.Uint64(e[:]))
	}
	if ln > maxFrameSize {
		return nil, fmt.Errorf("websocket frame exceeds %d bytes", maxFrameSize)
	}
	var mask [4]byte
	if _, err = readFull(r, mask[:]); err != nil {
		return nil, err
	}
	data := make([]byte, ln)
	if _, err = readFull(r, data); err != nil {
		return nil, err
	}
	for i := range data {
		data[i] ^= mask[i%4]
	}
	switch opcode {
	case 0x2:
		return data, nil
	case 0x8:
		return nil, fmt.Errorf("close")
	default:
		return nil, fmt.Errorf("unsupported websocket opcode %d", opcode)
	}
}
func readFull(r *bufio.Reader, p []byte) (int, error) {
	got := 0
	for got < len(p) {
		n, err := r.Read(p[got:])
		got += n
		if err != nil {
			return got, err
		}
	}
	return got, nil
}

// ---- DHCP + ARP + switch ----
func (cl *client) send(b []byte) {
	cl.mu.Lock()
	defer cl.mu.Unlock()
	_ = cl.conn.SetWriteDeadline(time.Now().Add(2 * time.Second))
	err := wsWrite(cl.conn, b)
	_ = cl.conn.SetWriteDeadline(time.Time{})
	if err != nil {
		_ = cl.conn.Close()
	}
}

func handleDHCP(cl *client, f []byte) bool {
	if len(f) < 42 || f[12] != 0x08 || f[13] != 0x00 || f[23] != 17 {
		return false
	}
	ihl := int(f[14]&0x0f) * 4
	udp := 14 + ihl
	if udp+8 > len(f) {
		return false
	}
	dstPort := int(f[udp+2])<<8 | int(f[udp+3])
	if dstPort != 67 {
		return false
	}
	dhcp := udp + 8
	if dhcp+240 > len(f) {
		return false
	}
	xid := f[dhcp+4 : dhcp+8]
	chaddr := f[dhcp+28 : dhcp+34]
	msgType := byte(0)
	for o := dhcp + 240; o < len(f) && f[o] != 255; {
		if f[o] == 0 {
			o++
			continue
		}
		if o+1 >= len(f) {
			return false
		}
		code, l := f[o], int(f[o+1])
		if o+2+l > len(f) {
			return false
		}
		if code == 53 && l >= 1 {
			msgType = f[o+2]
		}
		o += 2 + l
	}
	if cl.ip == "" {
		mu.Lock()
		cl.ip = allocIP()
		mu.Unlock()
	}
	reply := byte(2)
	if msgType != 1 {
		reply = 5
	}
	out := make([]byte, 14+20+8+300)
	copy(out[0:], chaddr)
	copy(out[6:], gwMAC)
	out[12], out[13] = 0x08, 0x00
	p := 14
	out[p] = 0x45
	out[p+8] = 64
	out[p+9] = 17
	copy(out[p+12:], ip2b(gateway))
	copy(out[p+16:], []byte{255, 255, 255, 255})
	u := 34
	binary.BigEndian.PutUint16(out[u:], 67)
	binary.BigEndian.PutUint16(out[u+2:], 68)
	d := 42
	out[d], out[d+1], out[d+2] = 2, 1, 6
	copy(out[d+4:], xid)
	copy(out[d+16:], ip2b(cl.ip))
	copy(out[d+20:], ip2b(gateway))
	copy(out[d+28:], chaddr)
	binary.BigEndian.PutUint32(out[d+236:], 0x63825363)
	o := d + 240
	put := func(code byte, bytes ...byte) {
		out[o] = code
		out[o+1] = byte(len(bytes))
		o += 2
		copy(out[o:], bytes)
		o += len(bytes)
	}
	put(53, reply)
	put(54, ip2b(gateway)...)
	put(51, 0, 1, 0x51, 0x80) // ~86400s lease
	put(1, ip2b("255.255.255.0")...)
	put(3, ip2b(gateway)...)
	put(6, ip2b(gateway)...)
	out[o] = 255
	o++
	binary.BigEndian.PutUint16(out[u+4:], uint16(o-u))
	binary.BigEndian.PutUint16(out[16:], uint16(o-14))
	binary.BigEndian.PutUint16(out[24:], ipChecksum(out[14:34]))
	cl.send(out[:o])
	fmt.Printf("DHCP -> %s (%s)\n", cl.ip, macStr(chaddr))
	return true
}

func handleARP(cl *client, f []byte) bool {
	if len(f) < 42 || f[12] != 0x08 || f[13] != 0x06 {
		return false
	}
	if int(f[20])<<8|int(f[21]) != 1 {
		return false
	}
	target := fmt.Sprintf("%d.%d.%d.%d", f[38], f[39], f[40], f[41])
	if target != gateway {
		return false
	}
	out := make([]byte, 42)
	copy(out[0:], f[22:28])
	copy(out[6:], gwMAC)
	out[12], out[13] = 0x08, 0x06
	binary.BigEndian.PutUint16(out[14:], 1)
	binary.BigEndian.PutUint16(out[16:], 0x0800)
	out[18], out[19] = 6, 4
	binary.BigEndian.PutUint16(out[20:], 2)
	copy(out[22:], gwMAC)
	copy(out[28:], ip2b(gateway))
	copy(out[32:], f[22:28])
	copy(out[38:], f[28:32])
	cl.send(out)
	return true
}

func hostName(hostport string) string {
	if h, _, err := net.SplitHostPort(hostport); err == nil {
		return strings.ToLower(strings.Trim(h, "[]"))
	}
	return strings.ToLower(strings.Trim(hostport, "[]"))
}

func explicitlyAllowedOrigin(origin string) bool {
	for _, allowed := range strings.Split(os.Getenv("BROWSEROS_ALLOWED_ORIGINS"), ",") {
		if strings.TrimSpace(allowed) == origin {
			return true
		}
	}
	return false
}

func trustedOrigin(origin, requestHost string, allowLAN bool) bool {
	u, err := url.Parse(origin)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return false
	}
	if explicitlyAllowedOrigin(origin) {
		return true
	}
	if hostName(u.Host) != hostName(requestHost) {
		return false
	}
	host := strings.Trim(u.Hostname(), "[]")
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && (ip.IsLoopback() || (allowLAN && (ip.IsPrivate() || ip.IsLinkLocalUnicast())))
}

func readHandshake(r *bufio.Reader, allowLAN bool) (string, error) {
	var key, host, origin, upgrade, connection, version string
	total := 0
	requestOK := false
	for {
		line, err := r.ReadString('\n')
		if err != nil {
			return "", err
		}
		total += len(line)
		if total > maxHeaderSize {
			return "", fmt.Errorf("websocket headers too large")
		}
		line = strings.TrimRight(line, "\r\n")
		if line == "" {
			break
		}
		if total == len(line)+2 || total == len(line)+1 {
			requestOK = strings.HasPrefix(line, "GET ") && strings.HasSuffix(line, " HTTP/1.1")
		}
		name, value, ok := strings.Cut(line, ":")
		if !ok {
			continue // request line
		}
		switch strings.ToLower(strings.TrimSpace(name)) {
		case "host":
			host = strings.TrimSpace(value)
		case "origin":
			origin = strings.TrimSpace(value)
		case "upgrade":
			upgrade = strings.TrimSpace(value)
		case "connection":
			connection = strings.TrimSpace(value)
		case "sec-websocket-key":
			key = strings.TrimSpace(value)
		case "sec-websocket-version":
			version = strings.TrimSpace(value)
		}
	}
	if !requestOK || key == "" || host == "" || origin == "" || version != "13" ||
		!strings.EqualFold(upgrade, "websocket") ||
		!strings.Contains(strings.ToLower(connection), "upgrade") ||
		!trustedOrigin(origin, host, allowLAN) {
		return "", fmt.Errorf("invalid or untrusted websocket upgrade")
	}
	return key, nil
}

func handleConn(conn net.Conn, allowLAN bool) {
	defer conn.Close()
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	r := bufio.NewReader(conn)
	key, err := readHandshake(r, allowLAN)
	if err != nil {
		conn.Write([]byte("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"))
		return
	}
	mu.Lock()
	full := len(clients) >= maxClients
	mu.Unlock()
	if full {
		conn.Write([]byte("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n"))
		return
	}
	_ = conn.SetReadDeadline(time.Time{})
	resp := "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + wsAccept(key) + "\r\n\r\n"
	conn.Write([]byte(resp))

	cl := &client{conn: conn}
	mu.Lock()
	clients[cl] = true
	fmt.Printf("+ VM connected (%d total)\n", len(clients))
	mu.Unlock()
	defer func() {
		mu.Lock()
		if cl.mac != "" {
			delete(macTable, cl.mac)
		}
		delete(clients, cl)
		fmt.Printf("- VM disconnected (%d total)\n", len(clients))
		mu.Unlock()
	}()

	for {
		f, err := wsRead(r)
		if err != nil {
			return
		}
		if len(f) < 14 {
			continue
		}
		src := macStr(f[6:12])
		mu.Lock()
		macTable[src] = cl
		cl.mac = src
		mu.Unlock()

		if handleARP(cl, f) {
			continue
		}
		if handleDHCP(cl, f) {
			continue
		}

		dst := macStr(f[0:6])
		bcast := dst == "ff:ff:ff:ff:ff:ff" || f[0]&1 == 1
		mu.Lock()
		if !bcast {
			if t, ok := macTable[dst]; ok && t != cl {
				t.send(f)
				mu.Unlock()
				continue
			}
		}
		for peer := range clients {
			if peer != cl {
				peer.send(f)
			}
		}
		mu.Unlock()
	}
}

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "9000"
	}
	allowLAN := envBool("BROWSEROS_ALLOW_LAN")
	host := "127.0.0.1"
	if allowLAN {
		host = "0.0.0.0"
	}
	ln, err := net.Listen("tcp", net.JoinHostPort(host, port))
	if err != nil {
		fmt.Println("listen error:", err)
		os.Exit(1)
	}
	fmt.Printf("BrowserOS virtual-switch relay (Go) on ws://%s:%s\n", host, port)
	fmt.Printf("LAN access: %v (set BROWSEROS_ALLOW_LAN=1 to opt in)\n", allowLAN)
	fmt.Printf("Subnet %s.0/24  gateway %s  (VMs get %s.2, .3, ...)\n", subnet, gateway, subnet)
	if allowLAN {
		fmt.Printf("In BrowserOS: Relay URL = ws://<this-host-private-ip>:%s\n", port)
	} else {
		fmt.Printf("In BrowserOS: Relay URL = ws://127.0.0.1:%s\n", port)
	}
	for {
		conn, err := ln.Accept()
		if err != nil {
			continue
		}
		go handleConn(conn, allowLAN)
	}
}

func envBool(name string) bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(name))) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}
