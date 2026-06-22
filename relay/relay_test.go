package main

import (
	"bufio"
	"bytes"
	"os"
	"strings"
	"testing"
)

func websocketHandshake(origin, host string) string {
	return "GET / HTTP/1.1\r\n" +
		"Host: " + host + "\r\n" +
		"Origin: " + origin + "\r\n" +
		"Connection: Upgrade\r\n" +
		"Upgrade: websocket\r\n" +
		"Sec-WebSocket-Version: 13\r\n" +
		"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n"
}

func TestStandaloneRelayOriginPolicy(t *testing.T) {
	os.Unsetenv("BROWSEROS_ALLOWED_ORIGINS")
	if !trustedOrigin("http://127.0.0.1:8086", "127.0.0.1:9000", false) {
		t.Fatal("same loopback host with a different port should be trusted")
	}
	if trustedOrigin("http://evil.example", "127.0.0.1:9000", false) {
		t.Fatal("cross-origin host accepted")
	}
	if trustedOrigin("http://192.168.1.20:8086", "192.168.1.20:9000", false) {
		t.Fatal("LAN host accepted without opt-in")
	}
	if !trustedOrigin("http://192.168.1.20:8086", "192.168.1.20:9000", true) {
		t.Fatal("private LAN host rejected after opt-in")
	}

	t.Setenv("BROWSEROS_ALLOWED_ORIGINS", "https://browseros.example")
	if !trustedOrigin("https://browseros.example", "relay.internal:9000", false) {
		t.Fatal("explicit allowed origin rejected")
	}
}

func TestStandaloneRelayHandshakeValidation(t *testing.T) {
	key, err := readHandshake(
		bufio.NewReader(strings.NewReader(websocketHandshake(
			"http://127.0.0.1:8086", "127.0.0.1:9000",
		))),
		false,
	)
	if err != nil || key == "" {
		t.Fatalf("valid handshake rejected: key=%q err=%v", key, err)
	}

	bad := strings.Replace(
		websocketHandshake("http://127.0.0.1:8086", "127.0.0.1:9000"),
		"Origin: http://127.0.0.1:8086\r\n",
		"",
		1,
	)
	if _, err := readHandshake(bufio.NewReader(strings.NewReader(bad)), false); err == nil {
		t.Fatal("handshake without Origin accepted")
	}
}

func TestStandaloneRelayFrameValidation(t *testing.T) {
	// Browser clients must mask frames.
	if _, err := wsRead(bufio.NewReader(bytes.NewReader([]byte{0x82, 0x00}))); err == nil {
		t.Fatal("unmasked client frame accepted")
	}

	// 65,537-byte frame: reject from the header without allocating/reading it.
	oversized := []byte{0x82, 0xff, 0, 0, 0, 0, 0, 1, 0, 1}
	if _, err := wsRead(bufio.NewReader(bytes.NewReader(oversized))); err == nil {
		t.Fatal("oversized frame accepted")
	}
}
