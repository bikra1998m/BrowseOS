package main

import (
	"bufio"
	"encoding/binary"
	"io"
	"io/fs"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"testing/fstest"
	"time"
)

func relayRequest(origin, host string) *http.Request {
	req := httptest.NewRequest(http.MethodGet, "http://"+host+"/relay", nil)
	req.Host = host
	req.Header.Set("Connection", "Upgrade")
	req.Header.Set("Upgrade", "websocket")
	req.Header.Set("Sec-WebSocket-Version", "13")
	req.Header.Set("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ==")
	if origin != "" {
		req.Header.Set("Origin", origin)
	}
	return req
}

func TestCapabilitiesAdvertiseBuiltInNetworking(t *testing.T) {
	publicFS := fstest.MapFS{
		"index.html": &fstest.MapFile{Data: []byte("ok"), Mode: fs.FileMode(0o644)},
	}
	req := httptest.NewRequest(http.MethodGet, "/browseros-capabilities.json", nil)
	rec := httptest.NewRecorder()

	newHandler(publicFS, false).ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	if got := rec.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control = %q, want no-store", got)
	}
	if got := strings.TrimSpace(rec.Body.String()); got != `{"wisp":"/wisp/","relay":"/relay"}` {
		t.Fatalf("body = %q", got)
	}
}

func TestStaticResponsesKeepIsolationHeaders(t *testing.T) {
	publicFS := fstest.MapFS{
		"index.html": &fstest.MapFile{Data: []byte("ok"), Mode: fs.FileMode(0o644)},
	}
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()

	newHandler(publicFS, false).ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	for name, want := range map[string]string{
		"Cross-Origin-Opener-Policy":   "same-origin",
		"Cross-Origin-Embedder-Policy": "require-corp",
		"Cross-Origin-Resource-Policy": "cross-origin",
		"Content-Security-Policy":      contentSecurityPolicy,
		"X-Content-Type-Options":       "nosniff",
		"X-Frame-Options":              "DENY",
		"Referrer-Policy":              "no-referrer",
		"Permissions-Policy":           "camera=(), microphone=(), geolocation=(), usb=(), payment=()",
		"Cache-Control":                "no-cache",
	} {
		if got := rec.Header().Get(name); got != want {
			t.Errorf("%s = %q, want %q", name, got, want)
		}
	}
}

func TestVersionedStaticAssetURL(t *testing.T) {
	publicFS := fstest.MapFS{
		"images/linux.iso": &fstest.MapFile{Data: []byte("boot-image"), Mode: fs.FileMode(0o644)},
	}
	req := httptest.NewRequest(http.MethodHead, "/images/linux.iso?v=content-hash", nil)
	rec := httptest.NewRecorder()

	newHandler(publicFS, false).ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	if got := rec.Header().Get("Content-Length"); got != "10" {
		t.Fatalf("Content-Length = %q, want 10", got)
	}
}

func TestWebSocketOriginPolicy(t *testing.T) {
	tests := []struct {
		name     string
		origin   string
		host     string
		allowLAN bool
		wantOK   bool
	}{
		{"loopback", "http://127.0.0.1:8086", "127.0.0.1:8086", false, true},
		{"localhost", "http://localhost:8086", "localhost:8086", false, true},
		{"missing origin", "", "127.0.0.1:8086", false, false},
		{"cross origin", "http://evil.example", "127.0.0.1:8086", false, false},
		{"dns rebinding", "http://evil.example:8086", "evil.example:8086", false, false},
		{"private LAN opt in", "http://192.168.1.20:8086", "192.168.1.20:8086", true, true},
		{"private LAN off", "http://192.168.1.20:8086", "192.168.1.20:8086", false, false},
		{"public host even with LAN", "http://example.com:8086", "example.com:8086", true, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := validWebSocketUpgrade(relayRequest(tt.origin, tt.host), tt.allowLAN)
			if (err == nil) != tt.wantOK {
				t.Fatalf("validWebSocketUpgrade() error = %v, wantOK %v", err, tt.wantOK)
			}
		})
	}
}

func TestRelayFrameLengthLimit(t *testing.T) {
	if got, err := parseFrameLength(125, nil); err != nil || got != 125 {
		t.Fatalf("small frame = %d, %v", got, err)
	}
	if _, err := parseFrameLength(126, []byte{0xff, 0xff}); err != nil {
		t.Fatalf("64 KiB frame rejected: %v", err)
	}
	if _, err := parseFrameLength(127, []byte{0, 0, 0, 0, 0, 1, 0, 1}); err == nil {
		t.Fatal("oversized frame accepted")
	}
}

func writeMaskedBinaryFrame(t *testing.T, conn net.Conn, payload []byte) {
	t.Helper()
	if len(payload) >= 126 {
		t.Fatalf("test payload too large: %d", len(payload))
	}
	mask := [4]byte{1, 2, 3, 4}
	frame := []byte{0x82, 0x80 | byte(len(payload))}
	frame = append(frame, mask[:]...)
	for i, b := range payload {
		frame = append(frame, b^mask[i%len(mask)])
	}
	if _, err := conn.Write(frame); err != nil {
		t.Fatal(err)
	}
}

func readBinaryFrame(t *testing.T, r *bufio.Reader) []byte {
	t.Helper()
	first, err := r.ReadByte()
	if err != nil {
		t.Fatal(err)
	}
	if first != 0x82 {
		t.Fatalf("frame opcode = %#x, want binary FIN", first)
	}
	second, err := r.ReadByte()
	if err != nil {
		t.Fatal(err)
	}
	if second&0x80 != 0 {
		t.Fatal("server frame must not be masked")
	}
	length := int(second & 0x7f)
	if length == 126 {
		var extended [2]byte
		if _, err := io.ReadFull(r, extended[:]); err != nil {
			t.Fatal(err)
		}
		length = int(binary.BigEndian.Uint16(extended[:]))
	}
	payload := make([]byte, length)
	if _, err := io.ReadFull(r, payload); err != nil {
		t.Fatal(err)
	}
	return payload
}

func TestWispProxiesTCP(t *testing.T) {
	echo, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer echo.Close()
	go func() {
		conn, acceptErr := echo.Accept()
		if acceptErr != nil {
			return
		}
		defer conn.Close()
		_, _ = io.Copy(conn, conn)
	}()

	publicFS := fstest.MapFS{
		"index.html": &fstest.MapFile{Data: []byte("ok"), Mode: fs.FileMode(0o644)},
	}
	server := httptest.NewServer(newHandler(publicFS, false))
	defer server.Close()
	serverURL, err := url.Parse(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	conn, err := net.DialTimeout("tcp", serverURL.Host, 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(10 * time.Second))

	_, err = io.WriteString(conn,
		"GET /wisp/ HTTP/1.1\r\n"+
			"Host: "+serverURL.Host+"\r\n"+
			"Origin: "+server.URL+"\r\n"+
			"Connection: Upgrade\r\n"+
			"Upgrade: websocket\r\n"+
			"Sec-WebSocket-Version: 13\r\n"+
			"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n")
	if err != nil {
		t.Fatal(err)
	}
	reader := bufio.NewReader(conn)
	status, err := reader.ReadString('\n')
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(status, "101") {
		t.Fatalf("upgrade status = %q", strings.TrimSpace(status))
	}
	for {
		line, readErr := reader.ReadString('\n')
		if readErr != nil {
			t.Fatal(readErr)
		}
		if line == "\r\n" {
			break
		}
	}

	initial := readBinaryFrame(t, reader)
	if len(initial) != 9 || initial[0] != wispContinue ||
		binary.LittleEndian.Uint32(initial[1:5]) != 0 ||
		binary.LittleEndian.Uint32(initial[5:9]) != wispInitialBuffer {
		t.Fatalf("initial WISP frame = %v", initial)
	}

	tcpAddr := echo.Addr().(*net.TCPAddr)
	connect := make([]byte, 8+len("127.0.0.1"))
	connect[0] = wispConnect
	binary.LittleEndian.PutUint32(connect[1:5], 1)
	connect[5] = 1
	binary.LittleEndian.PutUint16(connect[6:8], uint16(tcpAddr.Port))
	copy(connect[8:], "127.0.0.1")
	writeMaskedBinaryFrame(t, conn, connect)

	data := append([]byte{wispData, 1, 0, 0, 0}, []byte("hello through WISP")...)
	writeMaskedBinaryFrame(t, conn, data)

	response := readBinaryFrame(t, reader)
	if len(response) < 5 || response[0] != wispData ||
		binary.LittleEndian.Uint32(response[1:5]) != 1 ||
		string(response[5:]) != "hello through WISP" {
		t.Fatalf("WISP response = %v", response)
	}
}
