package main

import (
	"encoding/binary"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strings"
)

const (
	maxRelayFrameSize  = 65536
	maxRelayHeaderSize = 16 << 10
)

func normalizedHost(hostport, scheme string) string {
	host := hostport
	port := ""
	if h, p, err := net.SplitHostPort(hostport); err == nil {
		host, port = h, p
	}
	if port == "" {
		if scheme == "https" || scheme == "wss" {
			port = "443"
		} else {
			port = "80"
		}
	}
	return strings.ToLower(strings.Trim(host, "[]")) + ":" + port
}

func trustedWebSocketOrigin(r *http.Request, allowLAN bool) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return false
	}
	u, err := url.Parse(origin)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return false
	}
	if normalizedHost(u.Host, u.Scheme) != normalizedHost(r.Host, u.Scheme) {
		return false
	}
	host := strings.Trim(u.Hostname(), "[]")
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return false
	}
	return ip.IsLoopback() || (allowLAN && (ip.IsPrivate() || ip.IsLinkLocalUnicast()))
}

func validWebSocketUpgrade(r *http.Request, allowLAN bool) error {
	if !strings.EqualFold(r.Method, http.MethodGet) {
		return fmt.Errorf("websocket upgrade requires GET")
	}
	if !strings.Contains(strings.ToLower(r.Header.Get("Connection")), "upgrade") ||
		!strings.EqualFold(strings.TrimSpace(r.Header.Get("Upgrade")), "websocket") {
		return fmt.Errorf("invalid websocket upgrade headers")
	}
	if strings.TrimSpace(r.Header.Get("Sec-WebSocket-Key")) == "" ||
		strings.TrimSpace(r.Header.Get("Sec-WebSocket-Version")) != "13" {
		return fmt.Errorf("invalid websocket version or key")
	}
	if !trustedWebSocketOrigin(r, allowLAN) {
		return fmt.Errorf("untrusted websocket origin")
	}
	return nil
}

func parseFrameLength(b1 byte, extended []byte) (int, error) {
	code := int(b1 & 0x7f)
	switch code {
	case 126:
		if len(extended) != 2 {
			return 0, fmt.Errorf("invalid 16-bit websocket length")
		}
		code = int(extended[0])<<8 | int(extended[1])
	case 127:
		if len(extended) != 8 {
			return 0, fmt.Errorf("invalid 64-bit websocket length")
		}
		if extended[0]|extended[1]|extended[2]|extended[3] != 0 {
			return 0, fmt.Errorf("websocket frame too large")
		}
		code = int(binary.BigEndian.Uint32(extended[4:]))
	}
	if code > maxRelayFrameSize {
		return 0, fmt.Errorf("websocket frame exceeds %d bytes", maxRelayFrameSize)
	}
	return code, nil
}
