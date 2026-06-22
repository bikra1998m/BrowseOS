// Embedded virtual-switch relay (pure stdlib, no deps) for the BrowserOS
// launcher. Runs in the SAME process as the file server, so running the binary
// gives the user real multi-VM networking automatically — unique IPs + VMs can
// talk to each other — with zero setup. On Linux as root, relay_nat_linux.go
// also enables TUN+iptables NAT so VMs reach the internet (see initRelayNAT).
package main

import (
	"bufio"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	relaySubnet     = "10.5.0"
	relayGateway    = relaySubnet + ".1"
	maxRelayClients = 64
)

var relayGwMAC = []byte{0x02, 0x00, 0x00, 0x00, 0x00, 0x01}

type rclient struct {
	conn net.Conn
	mac  string
	ip   string
	mu   sync.Mutex
}

var (
	rmu      sync.Mutex
	rclients = map[*rclient]bool{}
	rbyMAC   = map[string]*rclient{}
	rNext    = 2
)

func rAlloc() string {
	ip := fmt.Sprintf("%s.%d", relaySubnet, rNext)
	if rNext >= 250 {
		rNext = 2
	} else {
		rNext++
	}
	return ip
}
func rIP2b(s string) []byte {
	p := strings.Split(s, ".")
	b := make([]byte, 4)
	for i := 0; i < 4 && i < len(p); i++ {
		var v int
		fmt.Sscanf(p[i], "%d", &v)
		b[i] = byte(v)
	}
	return b
}
func rMacStr(b []byte) string {
	return fmt.Sprintf("%02x:%02x:%02x:%02x:%02x:%02x", b[0], b[1], b[2], b[3], b[4], b[5])
}
func rMacParse(mac string) []byte {
	parts := strings.Split(mac, ":")
	if len(parts) != 6 {
		return nil
	}
	b := make([]byte, 6)
	for i, p := range parts {
		v, err := strconv.ParseUint(p, 16, 8)
		if err != nil {
			return nil
		}
		b[i] = byte(v)
	}
	return b
}
func rCsum(b []byte) uint16 {
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

func rAccept(k string) string {
	h := sha1.New()
	h.Write([]byte(k + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))
	return base64.StdEncoding.EncodeToString(h.Sum(nil))
}
func (c *rclient) send(p []byte) {
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

func relayCanAccept() bool {
	rmu.Lock()
	defer rmu.Unlock()
	return len(rclients) < maxRelayClients
}
func rRead(r *bufio.Reader) ([]byte, error) {
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
	var ext []byte
	switch b1 & 0x7f {
	case 126:
		var e [2]byte
		if _, err := rFull(r, e[:]); err != nil {
			return nil, err
		}
		ext = e[:]
	case 127:
		var e [8]byte
		if _, err := rFull(r, e[:]); err != nil {
			return nil, err
		}
		ext = e[:]
	}
	ln, err := parseFrameLength(b1, ext)
	if err != nil {
		return nil, err
	}
	var mask [4]byte
	if _, err := rFull(r, mask[:]); err != nil {
		return nil, err
	}
	d := make([]byte, ln)
	if _, err := rFull(r, d); err != nil {
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
func rFull(r *bufio.Reader, p []byte) (int, error) {
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

func rDHCP(c *rclient, f []byte) bool {
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
		rmu.Lock()
		c.ip = rAlloc()
		rmu.Unlock()
		relayNatRegisterIP(c, c.ip)
	}
	reply := byte(2)
	if mtype != 1 {
		reply = 5
	}
	out := make([]byte, 14+20+8+300)
	copy(out[0:], chaddr)
	copy(out[6:], relayGwMAC)
	out[12] = 8
	out[14] = 0x45
	out[22] = 64
	out[23] = 17
	copy(out[26:], rIP2b(relayGateway))
	copy(out[30:], []byte{255, 255, 255, 255})
	binary.BigEndian.PutUint16(out[34:], 67)
	binary.BigEndian.PutUint16(out[36:], 68)
	d := 42
	out[d], out[d+1], out[d+2] = 2, 1, 6
	copy(out[d+4:], xid)
	copy(out[d+16:], rIP2b(c.ip))
	copy(out[d+20:], rIP2b(relayGateway))
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
	put(54, rIP2b(relayGateway)...)
	put(51, 0, 1, 0x51, 0x80)
	put(1, rIP2b("255.255.255.0")...)
	put(3, rIP2b(relayGateway)...)
	put(6, 8, 8, 8, 8)
	out[o] = 255
	o++
	binary.BigEndian.PutUint16(out[38:], uint16(o-34))
	binary.BigEndian.PutUint16(out[16:], uint16(o-14))
	binary.BigEndian.PutUint16(out[24:], rCsum(out[14:34]))
	c.send(out[:o])
	return true
}

func rARP(c *rclient, f []byte) bool {
	if len(f) < 42 || f[12] != 8 || f[13] != 6 || int(f[20])<<8|int(f[21]) != 1 {
		return false
	}
	if fmt.Sprintf("%d.%d.%d.%d", f[38], f[39], f[40], f[41]) != relayGateway {
		return false
	}
	out := make([]byte, 42)
	copy(out[0:], f[22:28])
	copy(out[6:], relayGwMAC)
	out[12], out[13] = 8, 6
	binary.BigEndian.PutUint16(out[14:], 1)
	binary.BigEndian.PutUint16(out[16:], 0x0800)
	out[18], out[19] = 6, 4
	binary.BigEndian.PutUint16(out[20:], 2)
	copy(out[22:], relayGwMAC)
	copy(out[28:], rIP2b(relayGateway))
	copy(out[32:], f[22:28])
	copy(out[38:], f[28:32])
	c.send(out)
	return true
}

func relayHandleConn(conn net.Conn, r *bufio.Reader, key string) {
	conn.Write([]byte("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + rAccept(key) + "\r\n\r\n"))
	c := &rclient{conn: conn}
	rmu.Lock()
	rclients[c] = true
	rmu.Unlock()
	defer func() {
		relayNatUnregister(c)
		rmu.Lock()
		if c.mac != "" {
			delete(rbyMAC, c.mac)
		}
		delete(rclients, c)
		rmu.Unlock()
	}()
	for {
		f, err := rRead(r)
		if err != nil {
			return
		}
		if len(f) < 14 {
			continue
		}
		src := rMacStr(f[6:12])
		rmu.Lock()
		rbyMAC[src] = c
		c.mac = src
		rmu.Unlock()
		if rARP(c, f) {
			continue
		}
		if rDHCP(c, f) {
			continue
		}
		if relayNatTryForward(c, f) {
			continue
		}
		dst := rMacStr(f[0:6])
		bcast := dst == "ff:ff:ff:ff:ff:ff" || f[0]&1 == 1
		rmu.Lock()
		if !bcast {
			if t, ok := rbyMAC[dst]; ok && t != c {
				t.send(f)
				rmu.Unlock()
				continue
			}
		}
		for peer := range rclients {
			if peer != c {
				peer.send(f)
			}
		}
		rmu.Unlock()
	}
}
