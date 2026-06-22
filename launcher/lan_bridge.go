package main

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"hash/fnv"
	"net"
	"sync"
	"time"
)

const maxLANBridgeClients = 32

type lanPacketPort interface {
	ReadPacket() ([]byte, error)
	WritePacket([]byte) error
	Close()
}

type lanHostConfig struct {
	Interface  string
	Device     string
	HostIP     net.IP
	Prefix     int
	Gateway    net.IP
	GatewayMAC net.HardwareAddr
	DNS        []net.IP
	MAC        net.HardwareAddr
}

type lanBridgeCapability struct {
	Path      string `json:"path"`
	Interface string `json:"interface"`
	Host      string `json:"host"`
	Subnet    string `json:"subnet"`
	Gateway   string `json:"gateway"`
}

type launcherCapabilities struct {
	WISP   string               `json:"wisp"`
	Relay  string               `json:"relay"`
	Bridge *lanBridgeCapability `json:"bridge"`
}

type lanBridgeClient struct {
	manager *lanBridgeManager
	conn    net.Conn
	vmID    string
	ip      net.IP
	mac     net.HardwareAddr
	sendMu  sync.Mutex
}

type lanBridgeManager struct {
	port   lanPacketPort
	config lanHostConfig

	mu          sync.Mutex
	clients     map[*lanBridgeClient]bool
	byIP        map[uint32]*lanBridgeClient
	allocations map[string]uint32
	reserved    map[uint32]bool
	seen        map[uint32]time.Time
	done        chan struct{}
	closeOnce   sync.Once
}

var lanBridge *lanBridgeManager

func capabilitiesPayload() []byte {
	capabilities := launcherCapabilities{
		WISP:  "/wisp/",
		Relay: "/relay",
	}
	if lanBridge != nil {
		network := networkIP(lanBridge.config.HostIP, lanBridge.config.Prefix)
		capabilities.Bridge = &lanBridgeCapability{
			Path:      "/bridge",
			Interface: lanBridge.config.Interface,
			Host:      lanBridge.config.HostIP.String(),
			Subnet:    fmt.Sprintf("%s/%d", network, lanBridge.config.Prefix),
			Gateway:   lanBridge.config.Gateway.String(),
		}
	}
	payload, _ := json.Marshal(capabilities)
	return payload
}

func initLANBridge() string {
	port, config, err := openLANPacketPort()
	if err != nil {
		return "LAN bridge unavailable: " + err.Error()
	}
	manager := &lanBridgeManager{
		port:        port,
		config:      config,
		clients:     make(map[*lanBridgeClient]bool),
		byIP:        make(map[uint32]*lanBridgeClient),
		allocations: make(map[string]uint32),
		reserved:    make(map[uint32]bool),
		seen:        make(map[uint32]time.Time),
		done:        make(chan struct{}),
	}
	manager.reserved[ipUint32(config.HostIP)] = true
	manager.reserved[ipUint32(config.Gateway)] = true
	manager.reserved[ipUint32(networkIP(config.HostIP, config.Prefix))] = true
	manager.reserved[ipUint32(broadcastIP(config.HostIP, config.Prefix))] = true
	lanBridge = manager
	go manager.captureLoop()
	return fmt.Sprintf(
		"LAN bridge ON (%s, %s/%d)",
		config.Interface,
		config.HostIP,
		config.Prefix,
	)
}

func shutdownLANBridge() {
	if lanBridge == nil {
		return
	}
	lanBridge.closeOnce.Do(func() {
		close(lanBridge.done)
		lanBridge.port.Close()
		lanBridge.mu.Lock()
		clients := make([]*lanBridgeClient, 0, len(lanBridge.clients))
		for client := range lanBridge.clients {
			clients = append(clients, client)
		}
		lanBridge.mu.Unlock()
		for _, client := range clients {
			_ = client.conn.Close()
		}
	})
}

func lanBridgeCanAccept() bool {
	if lanBridge == nil {
		return false
	}
	lanBridge.mu.Lock()
	defer lanBridge.mu.Unlock()
	return len(lanBridge.clients) < maxLANBridgeClients
}

func (client *lanBridgeClient) send(frame []byte) {
	client.sendMu.Lock()
	defer client.sendMu.Unlock()
	header := []byte{0x82}
	switch n := len(frame); {
	case n < 126:
		header = append(header, byte(n))
	case n < 65536:
		header = append(header, 126, byte(n>>8), byte(n))
	default:
		header = append(header, 127, 0, 0, 0, 0, byte(n>>24), byte(n>>16), byte(n>>8), byte(n))
	}
	_ = client.conn.SetWriteDeadline(time.Now().Add(2 * time.Second))
	_, err := client.conn.Write(append(header, frame...))
	_ = client.conn.SetWriteDeadline(time.Time{})
	if err != nil {
		_ = client.conn.Close()
	}
}

func (manager *lanBridgeManager) captureLoop() {
	for {
		frame, err := manager.port.ReadPacket()
		if err != nil {
			select {
			case <-manager.done:
				return
			default:
				time.Sleep(100 * time.Millisecond)
				continue
			}
		}
		manager.handleLANFrame(frame)
	}
}

func (manager *lanBridgeManager) markSeen(ip net.IP, mac net.HardwareAddr) {
	if ip == nil || len(mac) != 6 || bytes.Equal(mac, manager.config.MAC) {
		return
	}
	manager.mu.Lock()
	manager.seen[ipUint32(ip)] = time.Now()
	manager.mu.Unlock()
}

func (manager *lanBridgeManager) handleLANFrame(frame []byte) {
	if len(frame) < 14 {
		return
	}
	switch binary.BigEndian.Uint16(frame[12:14]) {
	case 0x0806:
		manager.handleLANARP(frame)
	case 0x0800:
		manager.handleLANIPv4(frame)
	}
}

func (manager *lanBridgeManager) handleLANARP(frame []byte) {
	if len(frame) < 42 {
		return
	}
	operation := binary.BigEndian.Uint16(frame[20:22])
	senderMAC := net.HardwareAddr(append([]byte(nil), frame[22:28]...))
	senderIP := net.IP(append([]byte(nil), frame[28:32]...))
	targetIP := net.IP(append([]byte(nil), frame[38:42]...))
	manager.markSeen(senderIP, senderMAC)

	manager.mu.Lock()
	client := manager.byIP[ipUint32(targetIP)]
	manager.mu.Unlock()
	if client == nil {
		return
	}
	if operation == 1 {
		// Tell the LAN that the VM's IP is reachable through the host Wi-Fi MAC.
		reply := make([]byte, 42)
		copy(reply[0:6], senderMAC)
		copy(reply[6:12], manager.config.MAC)
		binary.BigEndian.PutUint16(reply[12:14], 0x0806)
		binary.BigEndian.PutUint16(reply[14:16], 1)
		binary.BigEndian.PutUint16(reply[16:18], 0x0800)
		reply[18], reply[19] = 6, 4
		binary.BigEndian.PutUint16(reply[20:22], 2)
		copy(reply[22:28], manager.config.MAC)
		copy(reply[28:32], client.ip.To4())
		copy(reply[32:38], senderMAC)
		copy(reply[38:42], senderIP.To4())
		_ = manager.port.WritePacket(reply)
		return
	}
	if operation == 2 && len(client.mac) == 6 {
		out := append([]byte(nil), frame...)
		copy(out[0:6], client.mac)
		copy(out[32:38], client.mac)
		client.send(out)
	}
}

func (manager *lanBridgeManager) handleLANIPv4(frame []byte) {
	if len(frame) < 34 {
		return
	}
	sourceIP := net.IP(append([]byte(nil), frame[26:30]...))
	destIP := net.IP(append([]byte(nil), frame[30:34]...))
	manager.markSeen(sourceIP, net.HardwareAddr(frame[6:12]))

	manager.mu.Lock()
	client := manager.byIP[ipUint32(destIP)]
	manager.mu.Unlock()
	if client == nil || len(client.mac) != 6 {
		return
	}
	// Ignore our own translated outbound frame if Npcap reports sent packets.
	if bytes.Equal(frame[6:12], manager.config.MAC) && ipUint32(sourceIP) == ipUint32(client.ip) {
		return
	}
	out := append([]byte(nil), frame...)
	copy(out[0:6], client.mac)
	client.send(out)
}

func (manager *lanBridgeManager) allocateIP(vmID string) (net.IP, error) {
	manager.mu.Lock()
	if assigned := manager.allocations[vmID]; assigned != 0 {
		manager.mu.Unlock()
		return uint32IP(assigned), nil
	}
	manager.mu.Unlock()

	network := ipUint32(networkIP(manager.config.HostIP, manager.config.Prefix))
	broadcast := ipUint32(broadcastIP(manager.config.HostIP, manager.config.Prefix))
	first, last := network+2, broadcast-1
	if broadcast-network > 64 {
		first = broadcast - 55
		if first < network+2 {
			first = network + 2
		}
		last = broadcast - 6
	}
	if first > last {
		return nil, fmt.Errorf("subnet %s/%d has no assignable bridge addresses",
			networkIP(manager.config.HostIP, manager.config.Prefix), manager.config.Prefix)
	}

	hash := fnv.New32a()
	_, _ = hash.Write([]byte(vmID))
	count := last - first + 1
	start := first + (hash.Sum32() % count)
	for offset := uint32(0); offset < count; offset++ {
		candidate := first + ((start - first + offset) % count)
		manager.mu.Lock()
		busy := manager.reserved[candidate]
		if !busy {
			manager.reserved[candidate] = true
		}
		manager.mu.Unlock()
		if busy {
			continue
		}
		ip := uint32IP(candidate)
		if manager.probeIP(ip) {
			manager.mu.Lock()
			delete(manager.reserved, candidate)
			manager.mu.Unlock()
			continue
		}
		manager.mu.Lock()
		manager.allocations[vmID] = candidate
		manager.mu.Unlock()
		return ip, nil
	}
	return nil, fmt.Errorf("no free address is available on the host LAN")
}

func (manager *lanBridgeManager) probeIP(ip net.IP) bool {
	frame := make([]byte, 42)
	for i := 0; i < 6; i++ {
		frame[i] = 0xff
	}
	copy(frame[6:12], manager.config.MAC)
	binary.BigEndian.PutUint16(frame[12:14], 0x0806)
	binary.BigEndian.PutUint16(frame[14:16], 1)
	binary.BigEndian.PutUint16(frame[16:18], 0x0800)
	frame[18], frame[19] = 6, 4
	binary.BigEndian.PutUint16(frame[20:22], 1)
	copy(frame[22:28], manager.config.MAC)
	copy(frame[28:32], manager.config.HostIP.To4())
	copy(frame[38:42], ip.To4())
	_ = manager.port.WritePacket(frame)
	time.Sleep(300 * time.Millisecond)
	manager.mu.Lock()
	_, found := manager.seen[ipUint32(ip)]
	manager.mu.Unlock()
	return found
}

func (manager *lanBridgeManager) register(client *lanBridgeClient) {
	manager.mu.Lock()
	manager.clients[client] = true
	manager.byIP[ipUint32(client.ip)] = client
	manager.mu.Unlock()
}

func (manager *lanBridgeManager) unregister(client *lanBridgeClient) {
	manager.mu.Lock()
	delete(manager.clients, client)
	if manager.byIP[ipUint32(client.ip)] == client {
		delete(manager.byIP, ipUint32(client.ip))
	}
	manager.mu.Unlock()
}

func (manager *lanBridgeManager) handleGuestFrame(client *lanBridgeClient, frame []byte) {
	if len(frame) < 14 {
		return
	}
	client.mac = append(client.mac[:0], frame[6:12]...)
	if manager.handleDHCP(client, frame) {
		return
	}
	switch binary.BigEndian.Uint16(frame[12:14]) {
	case 0x0806:
		if len(frame) < 42 {
			return
		}
		senderIP := net.IP(frame[28:32])
		if !senderIP.Equal(net.IPv4zero) && !senderIP.Equal(client.ip) {
			return
		}
		targetIP := net.IP(frame[38:42])
		if targetIP.Equal(manager.config.HostIP) {
			manager.sendARPReplyToGuest(client, manager.config.HostIP, manager.config.MAC)
			return
		}
		if targetIP.Equal(manager.config.Gateway) && len(manager.config.GatewayMAC) == 6 {
			manager.sendARPReplyToGuest(client, manager.config.Gateway, manager.config.GatewayMAC)
			return
		}
		out := append([]byte(nil), frame...)
		copy(out[6:12], manager.config.MAC)
		copy(out[22:28], manager.config.MAC)
		_ = manager.port.WritePacket(out)
	case 0x0800:
		if len(frame) < 34 || !net.IP(frame[26:30]).Equal(client.ip) {
			return
		}
		out := append([]byte(nil), frame...)
		copy(out[6:12], manager.config.MAC)
		_ = manager.port.WritePacket(out)
	}
}

func (manager *lanBridgeManager) sendARPReplyToGuest(
	client *lanBridgeClient,
	senderIP net.IP,
	senderMAC net.HardwareAddr,
) {
	if len(client.mac) != 6 {
		return
	}
	reply := make([]byte, 42)
	copy(reply[0:6], client.mac)
	copy(reply[6:12], senderMAC)
	binary.BigEndian.PutUint16(reply[12:14], 0x0806)
	binary.BigEndian.PutUint16(reply[14:16], 1)
	binary.BigEndian.PutUint16(reply[16:18], 0x0800)
	reply[18], reply[19] = 6, 4
	binary.BigEndian.PutUint16(reply[20:22], 2)
	copy(reply[22:28], senderMAC)
	copy(reply[28:32], senderIP.To4())
	copy(reply[32:38], client.mac)
	copy(reply[38:42], client.ip.To4())
	client.send(reply)
}

func (manager *lanBridgeManager) handleDHCP(client *lanBridgeClient, frame []byte) bool {
	if len(frame) < 282 || binary.BigEndian.Uint16(frame[12:14]) != 0x0800 || frame[23] != 17 {
		return false
	}
	ihl := int(frame[14]&0x0f) * 4
	udp := 14 + ihl
	if udp+8 > len(frame) || binary.BigEndian.Uint16(frame[udp+2:udp+4]) != 67 {
		return false
	}
	dhcp := udp + 8
	if dhcp+240 > len(frame) {
		return false
	}
	messageType := byte(0)
	for offset := dhcp + 240; offset < len(frame) && frame[offset] != 255; {
		if frame[offset] == 0 {
			offset++
			continue
		}
		if offset+1 >= len(frame) {
			return false
		}
		length := int(frame[offset+1])
		if offset+2+length > len(frame) {
			return false
		}
		if frame[offset] == 53 && length >= 1 {
			messageType = frame[offset+2]
		}
		offset += 2 + length
	}
	replyType := byte(2)
	if messageType != 1 {
		replyType = 5
	}

	out := make([]byte, 14+20+8+320)
	copy(out[0:6], frame[6:12])
	copy(out[6:12], manager.config.MAC)
	binary.BigEndian.PutUint16(out[12:14], 0x0800)
	out[14] = 0x45
	out[22] = 64
	out[23] = 17
	copy(out[26:30], manager.config.HostIP.To4())
	copy(out[30:34], net.IPv4bcast.To4())
	binary.BigEndian.PutUint16(out[34:36], 67)
	binary.BigEndian.PutUint16(out[36:38], 68)
	d := 42
	out[d], out[d+1], out[d+2] = 2, 1, 6
	copy(out[d+4:d+8], frame[dhcp+4:dhcp+8])
	copy(out[d+16:d+20], client.ip.To4())
	copy(out[d+20:d+24], manager.config.HostIP.To4())
	copy(out[d+28:d+34], frame[dhcp+28:dhcp+34])
	binary.BigEndian.PutUint32(out[d+236:d+240], 0x63825363)
	offset := d + 240
	put := func(code byte, value ...byte) {
		out[offset] = code
		out[offset+1] = byte(len(value))
		offset += 2
		copy(out[offset:], value)
		offset += len(value)
	}
	put(53, replyType)
	put(54, manager.config.HostIP.To4()...)
	put(51, 0, 1, 0x51, 0x80)
	put(1, prefixMask(manager.config.Prefix)...)
	put(3, manager.config.Gateway.To4()...)
	dns := manager.config.Gateway
	if len(manager.config.DNS) > 0 && manager.config.DNS[0].To4() != nil {
		dns = manager.config.DNS[0]
	}
	put(6, dns.To4()...)
	out[offset] = 255
	offset++
	binary.BigEndian.PutUint16(out[38:40], uint16(offset-34))
	binary.BigEndian.PutUint16(out[16:18], uint16(offset-14))
	binary.BigEndian.PutUint16(out[24:26], rCsum(out[14:34]))
	client.send(out[:offset])
	return true
}

func lanBridgeHandleConn(conn net.Conn, reader *bufio.Reader, key, vmID string) {
	if lanBridge == nil {
		_ = conn.Close()
		return
	}
	ip, err := lanBridge.allocateIP(vmID)
	if err != nil {
		_ = conn.Close()
		return
	}
	_, err = conn.Write([]byte(
		"HTTP/1.1 101 Switching Protocols\r\n" +
			"Upgrade: websocket\r\n" +
			"Connection: Upgrade\r\n" +
			"Sec-WebSocket-Accept: " + rAccept(key) + "\r\n\r\n",
	))
	if err != nil {
		_ = conn.Close()
		return
	}
	client := &lanBridgeClient{manager: lanBridge, conn: conn, vmID: vmID, ip: ip}
	lanBridge.register(client)
	defer lanBridge.unregister(client)
	for {
		frame, readErr := rRead(reader)
		if readErr != nil {
			return
		}
		lanBridge.handleGuestFrame(client, frame)
	}
}

func ipUint32(ip net.IP) uint32 {
	value := ip.To4()
	if value == nil {
		return 0
	}
	return binary.BigEndian.Uint32(value)
}

func uint32IP(value uint32) net.IP {
	ip := make(net.IP, 4)
	binary.BigEndian.PutUint32(ip, value)
	return ip
}

func prefixMask(prefix int) []byte {
	mask := net.CIDRMask(prefix, 32)
	return []byte(mask)
}

func networkIP(ip net.IP, prefix int) net.IP {
	return ip.To4().Mask(net.CIDRMask(prefix, 32))
}

func broadcastIP(ip net.IP, prefix int) net.IP {
	network := ipUint32(networkIP(ip, prefix))
	hostBits := uint32(32 - prefix)
	if hostBits == 32 {
		return uint32IP(^uint32(0))
	}
	return uint32IP(network | (1<<hostBits - 1))
}
