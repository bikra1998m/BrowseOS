// BrowserOS Advanced Relay — Virtual Switch + TUN + NAT (Linux only)
// ===========================================================================
// Full "NAT Network" like VirtualBox: multiple browser-tab VMs get UNIQUE IPs,
// can talk to EACH OTHER, *and* reach the INTERNET — by bridging their
// WebSocket Ethernet frames to a Linux TUN device and letting the kernel NAT.
//
//	VM(tab) --ws--> [relay] <--L2 switch--> other VMs
//	                   |
//	                   +-- (IP packets to outside) --> TUN --> kernel --> iptables MASQUERADE --> internet
//
// REQUIREMENTS (Linux host, root):
//   - /dev/net/tun
//   - IP forwarding + a NAT rule (the helper script sets these up)
//
// Build:  go build -o browseros-relay-nat relay-nat.go
// Setup + run (as root):  sudo ./setup-nat.sh   (then it runs this binary)
//
// This implements: WebSocket server, DHCP, ARP (gateway + VM resolution),
// L2 switching between VMs, and L3 routing of VM<->internet traffic via TUN.
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
	"os/exec"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"
)

const (
	subnet        = "10.5.0"
	gateway       = subnet + ".1"
	tunName       = "browseros0"
	tunMTU        = 1500
	maxFrameSize  = 65536
	maxHeaderSize = 16 << 10
	maxClients    = 64
)

var gwMAC = []byte{0x02, 0x00, 0x00, 0x00, 0x00, 0x01}

// ---------- TUN device (Linux) ----------
const (
	cIFF_TUN   = 0x0001
	cIFF_NO_PI = 0x1000
	cTUNSETIFF = 0x400454ca
)

type ifreq struct {
	name  [16]byte
	flags uint16
	_     [22]byte
}

func openTUN(name string) (*os.File, error) {
	f, err := os.OpenFile("/dev/net/tun", os.O_RDWR, 0)
	if err != nil {
		return nil, err
	}
	var req ifreq
	copy(req.name[:], name)
	req.flags = cIFF_TUN | cIFF_NO_PI
	_, _, errno := syscall.Syscall(syscall.SYS_IOCTL, f.Fd(), uintptr(cTUNSETIFF), uintptr(unsafe.Pointer(&req)))
	if errno != 0 {
		f.Close()
		return nil, fmt.Errorf("TUNSETIFF: %v", errno)
	}
	return f, nil
}

func run(args ...string) {
	out, err := exec.Command(args[0], args[1:]...).CombinedOutput()
	if err != nil {
		fmt.Printf("  [warn] %s: %v %s\n", strings.Join(args, " "), err, out)
	}
}

// ---------- shared switch/DHCP state ----------
type client struct {
	conn net.Conn
	mac  []byte
	ip   string
	mu   sync.Mutex
}

var (
	mu       sync.Mutex
	clients  = map[*client]bool{}
	byMAC    = map[string]*client{} // macStr -> client
	byIP     = map[string]*client{} // ip -> client (for return traffic from TUN)
	nextHost = 2
	tun      *os.File
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
	p := strings.Split(s, ".")
	b := make([]byte, 4)
	for i := 0; i < 4 && i < len(p); i++ {
		var v int
		fmt.Sscanf(p[i], "%d", &v)
		b[i] = byte(v)
	}
	return b
}
func macStr(b []byte) string {
	return fmt.Sprintf("%02x:%02x:%02x:%02x:%02x:%02x", b[0], b[1], b[2], b[3], b[4], b[5])
}
func csum(b []byte) uint16 {
	var s uint32
	for i := 0; i+1 < len(b); i += 2 {
		s += uint32(b[i])<<8 | uint32(b[i+1])
	}
	if len(b)%2 == 1 {
		s += uint32(b[len(b)-1]) << 8
	}
	for s>>16 != 0 {
		s = (s & 0xffff) + (s >> 16)
	}
	return ^uint16(s)
}

// ---------- WebSocket (binary) ----------
func wsAccept(k string) string {
	h := sha1.New()
	h.Write([]byte(k + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))
	return base64.StdEncoding.EncodeToString(h.Sum(nil))
}
func (c *client) send(p []byte) {
	c.mu.Lock()
	defer c.mu.Unlock()
	var h []byte
	n := len(p)
	h = append(h, 0x82)
	switch {
	case n < 126:
		h = append(h, byte(n))
	case n < 65536:
		h = append(h, 126, byte(n>>8), byte(n))
	default:
		h = append(h, 127, 0, 0, 0, 0, byte(n>>24), byte(n>>16), byte(n>>8), byte(n))
	}
	_ = c.conn.SetWriteDeadline(time.Now().Add(2 * time.Second))
	_, err := c.conn.Write(append(h, p...))
	_ = c.conn.SetWriteDeadline(time.Time{})
	if err != nil {
		_ = c.conn.Close()
	}
}
func wsRead(r *bufio.Reader) ([]byte, error) {
	b0, err := r.ReadByte()
	if err != nil {
		return nil, err
	}
	op := b0 & 0x0f
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
		if _, err := readFull(r, e[:]); err != nil {
			return nil, err
		}
		ln = int(binary.BigEndian.Uint16(e[:]))
	} else if ln == 127 {
		var e [8]byte
		if _, err := readFull(r, e[:]); err != nil {
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
	if _, err := readFull(r, mask[:]); err != nil {
		return nil, err
	}
	d := make([]byte, ln)
	if _, err := readFull(r, d); err != nil {
		return nil, err
	}
	for i := range d {
		d[i] ^= mask[i%4]
	}
	switch op {
	case 0x2:
		return d, nil
	case 0x8:
		return nil, fmt.Errorf("close")
	default:
		return nil, fmt.Errorf("unsupported websocket opcode %d", op)
	}
}
func readFull(r *bufio.Reader, p []byte) (int, error) {
	g := 0
	for g < len(p) {
		n, err := r.Read(p[g:])
		g += n
		if err != nil {
			return g, err
		}
	}
	return g, nil
}

// ---------- DHCP / ARP (same as simple relay) ----------
func handleDHCP(c *client, f []byte) bool {
	if len(f) < 42 || f[12] != 8 || f[13] != 0 || f[23] != 17 {
		return false
	}
	ihl := int(f[14]&0x0f) * 4
	udp := 14 + ihl
	if udp+8 > len(f) || int(f[udp+2])<<8|int(f[udp+3]) != 67 {
		return false
	}
	dhcp := udp + 8
	if dhcp+240 > len(f) {
		return false
	}
	xid := f[dhcp+4 : dhcp+8]
	chaddr := f[dhcp+28 : dhcp+34]
	mtype := byte(0)
	for o := dhcp + 240; o < len(f) && f[o] != 255; {
		if f[o] == 0 {
			o++
			continue
		}
		if o+1 >= len(f) {
			return false
		}
		l := int(f[o+1])
		if o+2+l > len(f) {
			return false
		}
		if f[o] == 53 && l >= 1 {
			mtype = f[o+2]
		}
		o += 2 + l
	}
	if c.ip == "" {
		mu.Lock()
		c.ip = allocIP()
		byIP[c.ip] = c
		mu.Unlock()
	}
	reply := byte(2)
	if mtype != 1 {
		reply = 5
	}
	out := make([]byte, 14+20+8+300)
	copy(out[0:], chaddr)
	copy(out[6:], gwMAC)
	out[12] = 8
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
	copy(out[d+16:], ip2b(c.ip))
	copy(out[d+20:], ip2b(gateway))
	copy(out[d+28:], chaddr)
	binary.BigEndian.PutUint32(out[d+236:], 0x63825363)
	o := d + 240
	put := func(code byte, bs ...byte) {
		out[o] = code
		out[o+1] = byte(len(bs))
		o += 2
		copy(out[o:], bs)
		o += len(bs)
	}
	put(53, reply)
	put(54, ip2b(gateway)...)
	put(51, 0, 1, 0x51, 0x80)
	put(1, ip2b("255.255.255.0")...)
	put(3, ip2b(gateway)...)
	put(6, 8, 8, 8, 8) // public DNS so name resolution works
	out[o] = 255
	o++
	binary.BigEndian.PutUint16(out[u+4:], uint16(o-u))
	binary.BigEndian.PutUint16(out[16:], uint16(o-14))
	binary.BigEndian.PutUint16(out[24:], csum(out[14:34]))
	c.send(out[:o])
	fmt.Printf("DHCP -> %s (%s)\n", c.ip, macStr(chaddr))
	return true
}

func handleARP(c *client, f []byte) bool {
	if len(f) < 42 || f[12] != 8 || f[13] != 6 || int(f[20])<<8|int(f[21]) != 1 {
		return false
	}
	target := fmt.Sprintf("%d.%d.%d.%d", f[38], f[39], f[40], f[41])
	if target != gateway {
		return false
	}
	out := make([]byte, 42)
	copy(out[0:], f[22:28])
	copy(out[6:], gwMAC)
	out[12], out[13] = 8, 6
	binary.BigEndian.PutUint16(out[14:], 1)
	binary.BigEndian.PutUint16(out[16:], 0x0800)
	out[18], out[19] = 6, 4
	binary.BigEndian.PutUint16(out[20:], 2)
	copy(out[22:], gwMAC)
	copy(out[28:], ip2b(gateway))
	copy(out[32:], f[22:28])
	copy(out[38:], f[28:32])
	c.send(out)
	return true
}

// ---------- TUN reader: packets from internet -> back to the right VM ----------
func tunToVMs() {
	buf := make([]byte, 65536)
	for {
		n, err := tun.Read(buf)
		if err != nil {
			return
		}
		if n < 20 {
			continue
		}
		pkt := buf[:n]
		dstIP := fmt.Sprintf("%d.%d.%d.%d", pkt[16], pkt[17], pkt[18], pkt[19])
		mu.Lock()
		c := byIP[dstIP]
		mu.Unlock()
		if c == nil || c.mac == nil {
			continue
		}
		// Wrap the IP packet in an Ethernet frame: dst=VM mac, src=gateway mac.
		frame := make([]byte, 14+n)
		copy(frame[0:], c.mac)
		copy(frame[6:], gwMAC)
		frame[12], frame[13] = 0x08, 0x00
		copy(frame[14:], pkt)
		c.send(frame)
	}
}

// ---------- per-connection ----------
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
			continue
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
	conn.Write([]byte("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + wsAccept(key) + "\r\n\r\n"))

	c := &client{conn: conn}
	mu.Lock()
	clients[c] = true
	fmt.Printf("+ VM connected (%d)\n", len(clients))
	mu.Unlock()
	defer func() {
		mu.Lock()
		if c.mac != nil {
			delete(byMAC, macStr(c.mac))
		}
		if c.ip != "" {
			delete(byIP, c.ip)
		}
		delete(clients, c)
		fmt.Printf("- VM disconnected (%d)\n", len(clients))
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
		mu.Lock()
		c.mac = append(c.mac[:0], f[6:12]...)
		byMAC[macStr(f[6:12])] = c
		mu.Unlock()

		if handleARP(c, f) {
			continue
		}
		if handleDHCP(c, f) {
			continue
		}

		dst := macStr(f[0:6])
		// Traffic addressed to the GATEWAY MAC = goes to the outside (via TUN).
		if dst == macStr(gwMAC) && f[12] == 0x08 && f[13] == 0x00 {
			// strip Ethernet header → raw IP packet → TUN → kernel → NAT
			tun.Write(f[14:])
			continue
		}
		// Otherwise switch between VMs (L2).
		bcast := dst == "ff:ff:ff:ff:ff:ff" || f[0]&1 == 1
		mu.Lock()
		if !bcast {
			if t, ok := byMAC[dst]; ok && t != c {
				t.send(f)
				mu.Unlock()
				continue
			}
		}
		for peer := range clients {
			if peer != c {
				peer.send(f)
			}
		}
		mu.Unlock()
	}
}

func main() {
	if os.Geteuid() != 0 {
		fmt.Println("This advanced relay needs root (TUN + iptables). Run with sudo.")
		os.Exit(1)
	}
	port := os.Getenv("PORT")
	if port == "" {
		port = "9000"
	}

	// 1) Create + configure the TUN device.
	var err error
	tun, err = openTUN(tunName)
	if err != nil {
		fmt.Println("openTUN:", err, "(need /dev/net/tun and root)")
		os.Exit(1)
	}
	run("ip", "addr", "add", gateway+"/24", "dev", tunName)
	run("ip", "link", "set", "dev", tunName, "mtu", fmt.Sprint(tunMTU), "up")

	// 2) Enable forwarding + NAT (MASQUERADE) to the host's default interface.
	run("sysctl", "-w", "net.ipv4.ip_forward=1")
	outIf := defaultIface()
	if outIf != "" {
		run("iptables", "-t", "nat", "-A", "POSTROUTING", "-s", subnet+".0/24", "-o", outIf, "-j", "MASQUERADE")
		run("iptables", "-A", "FORWARD", "-i", tunName, "-o", outIf, "-j", "ACCEPT")
		run("iptables", "-A", "FORWARD", "-i", outIf, "-o", tunName, "-m", "state", "--state", "RELATED,ESTABLISHED", "-j", "ACCEPT")
		fmt.Printf("NAT enabled: %s.0/24 -> %s (internet)\n", subnet, outIf)
	} else {
		fmt.Println("[warn] no default interface found — internet NAT may not work")
	}

	go tunToVMs()

	allowLAN := envBool("BROWSEROS_ALLOW_LAN")
	host := "127.0.0.1"
	if allowLAN {
		host = "0.0.0.0"
	}
	ln, err := net.Listen("tcp", net.JoinHostPort(host, port))
	if err != nil {
		fmt.Println("listen:", err)
		os.Exit(1)
	}
	fmt.Printf("BrowserOS NAT relay on ws://%s:%s\n", host, port)
	fmt.Printf("LAN access: %v (set BROWSEROS_ALLOW_LAN=1 to opt in)\n", allowLAN)
	fmt.Printf("Subnet %s.0/24  gateway %s  DNS 8.8.8.8\n", subnet, gateway)
	fmt.Printf("VMs get unique IPs, can reach EACH OTHER and the INTERNET.\n")
	if allowLAN {
		fmt.Printf("In BrowserOS: NAT Network relay = ws://<this-host-private-ip>:%s\n", port)
	} else {
		fmt.Printf("In BrowserOS: NAT Network relay = ws://127.0.0.1:%s\n", port)
	}
	for {
		conn, err := ln.Accept()
		if err == nil {
			go handleConn(conn, allowLAN)
		}
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

// defaultIface returns the interface with the default route (best effort).
func defaultIface() string {
	out, err := exec.Command("sh", "-c", "ip route show default | awk '{print $5; exit}'").Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}
