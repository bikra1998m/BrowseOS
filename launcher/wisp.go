package main

import (
	"bufio"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	wispInitialBuffer = 64
	maxWispClients    = 32
	maxWispStreams    = 128
)

const (
	wispConnect  = byte(0x01)
	wispData     = byte(0x02)
	wispContinue = byte(0x03)
	wispClose    = byte(0x04)
)

type wispClient struct {
	conn net.Conn
	r    *bufio.Reader

	writeMu sync.Mutex
	mu      sync.Mutex
	streams map[uint32]*wispStream
	closed  chan struct{}
	once    sync.Once
}

type wispStream struct {
	id     uint32
	client *wispClient
	send   chan []byte
	done   chan struct{}
	once   sync.Once

	mu       sync.Mutex
	conn     net.Conn
	received int
}

var wispClientCount atomic.Int32

func wispCanAccept() bool {
	return wispClientCount.Load() < maxWispClients
}

func (c *wispClient) sendPacket(kind byte, id uint32, payload []byte) error {
	packet := make([]byte, 5+len(payload))
	packet[0] = kind
	binary.LittleEndian.PutUint32(packet[1:5], id)
	copy(packet[5:], payload)

	c.writeMu.Lock()
	defer c.writeMu.Unlock()

	header := []byte{0x82}
	switch n := len(packet); {
	case n < 126:
		header = append(header, byte(n))
	case n < 65536:
		header = append(header, 126, byte(n>>8), byte(n))
	default:
		header = append(header, 127, 0, 0, 0, 0, byte(n>>24), byte(n>>16), byte(n>>8), byte(n))
	}
	_ = c.conn.SetWriteDeadline(time.Now().Add(30 * time.Second))
	_, err := c.conn.Write(append(header, packet...))
	_ = c.conn.SetWriteDeadline(time.Time{})
	return err
}

func (c *wispClient) sendContinue(id uint32) error {
	var payload [4]byte
	binary.LittleEndian.PutUint32(payload[:], wispInitialBuffer)
	return c.sendPacket(wispContinue, id, payload[:])
}

func (c *wispClient) sendClose(id uint32, reason byte) {
	_ = c.sendPacket(wispClose, id, []byte{reason})
}

func (c *wispClient) close() {
	c.once.Do(func() {
		close(c.closed)
		_ = c.conn.Close()
		c.mu.Lock()
		streams := make([]*wispStream, 0, len(c.streams))
		for _, stream := range c.streams {
			streams = append(streams, stream)
		}
		c.streams = make(map[uint32]*wispStream)
		c.mu.Unlock()
		for _, stream := range streams {
			stream.close()
		}
	})
}

func (c *wispClient) removeStream(id uint32, stream *wispStream) {
	c.mu.Lock()
	if c.streams[id] == stream {
		delete(c.streams, id)
	}
	c.mu.Unlock()
}

func (s *wispStream) setConn(conn net.Conn) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	select {
	case <-s.done:
		return false
	default:
		s.conn = conn
		return true
	}
}

func (s *wispStream) close() {
	s.once.Do(func() {
		close(s.done)
		s.mu.Lock()
		if s.conn != nil {
			_ = s.conn.Close()
		}
		s.mu.Unlock()
	})
}

func (s *wispStream) run(conn net.Conn) {
	if !s.setConn(conn) {
		_ = conn.Close()
		return
	}

	go func() {
		buffer := make([]byte, 32*1024)
		for {
			n, err := conn.Read(buffer)
			if n > 0 {
				if sendErr := s.client.sendPacket(wispData, s.id, buffer[:n]); sendErr != nil {
					s.client.close()
					return
				}
			}
			if err != nil {
				reason := byte(0x02)
				if !errors.Is(err, io.EOF) && !errors.Is(err, net.ErrClosed) {
					reason = 0x03
				}
				s.client.removeStream(s.id, s)
				s.close()
				s.client.sendClose(s.id, reason)
				return
			}
		}
	}()

	for {
		select {
		case data := <-s.send:
			_ = conn.SetWriteDeadline(time.Now().Add(30 * time.Second))
			_, err := conn.Write(data)
			_ = conn.SetWriteDeadline(time.Time{})
			if err != nil {
				s.client.removeStream(s.id, s)
				s.close()
				s.client.sendClose(s.id, 0x03)
				return
			}
		case <-s.done:
			return
		case <-s.client.closed:
			return
		}
	}
}

func wispDialCloseReason(err error) byte {
	var dnsErr *net.DNSError
	if errors.As(err, &dnsErr) {
		return 0x42
	}
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return 0x43
	}
	if strings.Contains(strings.ToLower(err.Error()), "refused") {
		return 0x44
	}
	return 0x03
}

func (c *wispClient) connect(packet []byte) {
	if len(packet) < 8 {
		if len(packet) >= 5 {
			c.sendClose(binary.LittleEndian.Uint32(packet[1:5]), 0x41)
		}
		return
	}
	id := binary.LittleEndian.Uint32(packet[1:5])
	streamType := packet[5]
	port := binary.LittleEndian.Uint16(packet[6:8])
	host := string(packet[8:])
	if id == 0 || streamType != 0x01 || port == 0 || host == "" ||
		len(host) > 253 || strings.IndexByte(host, 0) >= 0 {
		c.sendClose(id, 0x41)
		return
	}

	c.mu.Lock()
	if len(c.streams) >= maxWispStreams || c.streams[id] != nil {
		c.mu.Unlock()
		c.sendClose(id, 0x49)
		return
	}
	stream := &wispStream{
		id:     id,
		client: c,
		send:   make(chan []byte, wispInitialBuffer),
		done:   make(chan struct{}),
	}
	c.streams[id] = stream
	c.mu.Unlock()

	go func() {
		dialer := net.Dialer{Timeout: 15 * time.Second, KeepAlive: 30 * time.Second}
		conn, err := dialer.Dial("tcp", net.JoinHostPort(host, fmt.Sprint(port)))
		if err != nil {
			c.removeStream(id, stream)
			stream.close()
			c.sendClose(id, wispDialCloseReason(err))
			return
		}
		stream.run(conn)
	}()
}

func (c *wispClient) data(packet []byte) {
	if len(packet) < 5 {
		return
	}
	id := binary.LittleEndian.Uint32(packet[1:5])
	c.mu.Lock()
	stream := c.streams[id]
	c.mu.Unlock()
	if stream == nil {
		c.sendClose(id, 0x41)
		return
	}

	data := append([]byte(nil), packet[5:]...)
	select {
	case stream.send <- data:
		stream.mu.Lock()
		stream.received++
		refresh := stream.received%32 == 0
		stream.mu.Unlock()
		if refresh {
			_ = c.sendContinue(id)
		}
	case <-stream.done:
	case <-c.closed:
	}
}

func (c *wispClient) closeStream(packet []byte) {
	if len(packet) < 5 {
		return
	}
	id := binary.LittleEndian.Uint32(packet[1:5])
	c.mu.Lock()
	stream := c.streams[id]
	if stream != nil {
		delete(c.streams, id)
	}
	c.mu.Unlock()
	if stream != nil {
		stream.close()
	}
}

func wispHandleConn(conn net.Conn, r *bufio.Reader, key string) {
	_, err := conn.Write([]byte(
		"HTTP/1.1 101 Switching Protocols\r\n" +
			"Upgrade: websocket\r\n" +
			"Connection: Upgrade\r\n" +
			"Sec-WebSocket-Accept: " + rAccept(key) + "\r\n\r\n",
	))
	if err != nil {
		_ = conn.Close()
		return
	}

	wispClientCount.Add(1)
	client := &wispClient{
		conn:    conn,
		r:       r,
		streams: make(map[uint32]*wispStream),
		closed:  make(chan struct{}),
	}
	defer func() {
		client.close()
		wispClientCount.Add(-1)
	}()

	if err := client.sendContinue(0); err != nil {
		return
	}
	for {
		packet, err := rRead(client.r)
		if err != nil {
			return
		}
		if len(packet) < 5 {
			continue
		}
		switch packet[0] {
		case wispConnect:
			client.connect(packet)
		case wispData:
			client.data(packet)
		case wispClose:
			client.closeStream(packet)
		}
	}
}
