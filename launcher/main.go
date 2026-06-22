// BrowserOS standalone launcher.
// A single self-contained binary: embeds the entire web app (engine + Linux
// image) and serves it locally with the headers v86 needs, then opens the
// browser. No Python, no Node, no internet, no install — just run the file.
package main

import (
	"embed"
	"fmt"
	"io/fs"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"runtime"
	"strconv"
	"strings"
	"time"
)

const contentSecurityPolicy = "default-src 'self'; " +
	"script-src 'self' 'wasm-unsafe-eval'; " +
	"worker-src 'self' blob:; " +
	"connect-src 'self' ws: wss: https://cloudflare-dns.com; " +
	"img-src 'self' data: blob:; " +
	"style-src 'self' 'unsafe-inline'; " +
	"font-src 'self' data:; " +
	"object-src 'none'; " +
	"base-uri 'self'; " +
	"form-action 'self'; " +
	"frame-ancestors 'none'"

//go:embed all:public
var embedded embed.FS

func main() {
	sub, err := fs.Sub(embedded, "public")
	if err != nil {
		panic(err)
	}

	natStatus := initRelayNAT()
	defer shutdownRelayNAT()
	bridgeStatus := initLANBridge()
	defer shutdownLANBridge()
	go func() {
		ch := make(chan os.Signal, 1)
		signal.Notify(ch, os.Interrupt)
		<-ch
		shutdownLANBridge()
		shutdownRelayNAT()
		os.Exit(0)
	}()

	// Pick a free port starting at 8086.
	allowLAN := envBool("BROWSEROS_ALLOW_LAN")
	bindHost := "127.0.0.1"
	if allowLAN {
		bindHost = "0.0.0.0"
	}
	port := pickPort(bindHost, 8086)
	addr := bindHost + ":" + strconv.Itoa(port)
	localURL := "http://127.0.0.1:" + strconv.Itoa(port) + "/"
	ip := lanIP()
	lanURL := ""
	if allowLAN && ip != "" {
		lanURL = "http://" + ip + ":" + strconv.Itoa(port) + "/"
	}

	handler := newHandler(sub, allowLAN)

	fmt.Printf("\n  BrowserOS is running:\n")
	fmt.Printf("    This machine : %s\n", localURL)
	if lanURL != "" {
		fmt.Printf("    On your LAN  : %s   (open from phones/other PCs on same Wi-Fi)\n", lanURL)
	} else {
		fmt.Printf("    LAN access   : off (set BROWSEROS_ALLOW_LAN=1 to opt in)\n")
	}
	fmt.Printf("    VM internet  : built-in WISP proxy ON\n")
	fmt.Printf("    LAN bridge   : %s\n", bridgeStatus)
	fmt.Printf("    VM network   : built-in relay ON  (tabs get unique IPs")
	if natStatus != "" {
		fmt.Printf("; %s", natStatus)
	} else if runtime.GOOS == "linux" && os.Geteuid() != 0 {
		fmt.Printf("; inter-VM only — re-run with sudo for VM internet")
	} else if runtime.GOOS != "linux" {
		fmt.Printf("; inter-VM only on this OS")
	}
	fmt.Printf(")\n")
	fmt.Printf("  (close this window to stop)\n\n")

	go func() {
		time.Sleep(800 * time.Millisecond)
		openBrowser(localURL)
	}()

	server := &http.Server{
		Addr:              addr,
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    maxRelayHeaderSize,
	}
	if err := server.ListenAndServe(); err != nil {
		fmt.Println("server error:", err)
	}
}

func newHandler(publicFS fs.FS, allowLAN bool) http.Handler {
	fileServer := http.FileServer(http.FS(publicFS))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		// Cross-origin isolation → enables SharedArrayBuffer (fast v86 path).
		h.Set("Cross-Origin-Opener-Policy", "same-origin")
		h.Set("Cross-Origin-Embedder-Policy", "require-corp")
		h.Set("Cross-Origin-Resource-Policy", "cross-origin")
		h.Set("Content-Security-Policy", contentSecurityPolicy)
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), usb=(), payment=()")
		h.Set("Cache-Control", "no-cache")

		// Let the browser distinguish this launcher from a plain static/Python
		// server before selecting the same-origin WebSocket relay.
		if r.URL.Path == "/browseros-capabilities.json" {
			h.Set("Content-Type", "application/json")
			h.Set("Cache-Control", "no-store")
			_, _ = w.Write(capabilitiesPayload())
			return
		}

		// Real host-LAN bridge. The browser still sends raw Ethernet over a
		// same-origin WebSocket; Npcap connects it to the active Windows adapter.
		if r.URL.Path == "/bridge" && strings.Contains(strings.ToLower(r.Header.Get("Upgrade")), "websocket") {
			if !lanBridgeCanAccept() {
				http.Error(w, "LAN bridge is unavailable or full", http.StatusServiceUnavailable)
				return
			}
			if err := validWebSocketUpgrade(r, allowLAN); err != nil {
				http.Error(w, err.Error(), http.StatusForbidden)
				return
			}
			key := r.Header.Get("Sec-WebSocket-Key")
			hj, ok := w.(http.Hijacker)
			if !ok || key == "" {
				http.Error(w, "no hijack", 500)
				return
			}
			conn, buf, err := hj.Hijack()
			if err != nil {
				return
			}
			vmID := strings.TrimSpace(r.URL.Query().Get("vm"))
			if vmID == "" {
				vmID = conn.RemoteAddr().String()
			}
			lanBridgeHandleConn(conn, buf.Reader, key, vmID)
			return
		}

		// Cross-platform outbound TCP proxy used by v86's WISP backend. This is
		// the normal NAT path and needs no TUN/TAP device or administrator rights.
		if r.URL.Path == "/wisp/" && strings.Contains(strings.ToLower(r.Header.Get("Upgrade")), "websocket") {
			if !wispCanAccept() {
				http.Error(w, "WISP connection limit reached", http.StatusServiceUnavailable)
				return
			}
			if err := validWebSocketUpgrade(r, allowLAN); err != nil {
				http.Error(w, err.Error(), http.StatusForbidden)
				return
			}
			key := r.Header.Get("Sec-WebSocket-Key")
			hj, ok := w.(http.Hijacker)
			if !ok || key == "" {
				http.Error(w, "no hijack", 500)
				return
			}
			conn, buf, err := hj.Hijack()
			if err != nil {
				return
			}
			wispHandleConn(conn, buf.Reader, key)
			return
		}

		// Built-in virtual-switch relay: VMs connect here to get unique IPs and
		// talk to each other. Runs in THIS process → zero setup for the user.
		if r.URL.Path == "/relay" && strings.Contains(strings.ToLower(r.Header.Get("Upgrade")), "websocket") {
			if !relayCanAccept() {
				http.Error(w, "relay connection limit reached", http.StatusServiceUnavailable)
				return
			}
			if err := validWebSocketUpgrade(r, allowLAN); err != nil {
				http.Error(w, err.Error(), http.StatusForbidden)
				return
			}
			key := r.Header.Get("Sec-WebSocket-Key")
			hj, ok := w.(http.Hijacker)
			if !ok || key == "" {
				http.Error(w, "no hijack", 500)
				return
			}
			conn, buf, err := hj.Hijack()
			if err != nil {
				return
			}
			relayHandleConn(conn, buf.Reader, key)
			return
		}
		// http.FileServer already implements Range + correct MIME (incl. wasm).
		fileServer.ServeHTTP(w, r)
	})
}

// lanIP returns the machine's primary non-loopback IPv4 address (best effort).
func lanIP() string {
	conn, err := net.Dial("udp", "8.8.8.8:80") // no packets sent; just picks the route
	if err == nil {
		defer conn.Close()
		if a, ok := conn.LocalAddr().(*net.UDPAddr); ok {
			return a.IP.String()
		}
	}
	addrs, _ := net.InterfaceAddrs()
	for _, a := range addrs {
		if ipn, ok := a.(*net.IPNet); ok && !ipn.IP.IsLoopback() && ipn.IP.To4() != nil {
			return ipn.IP.String()
		}
	}
	return ""
}

func pickPort(host string, start int) int {
	for p := start; p < start+50; p++ {
		ln, err := net.Listen("tcp", net.JoinHostPort(host, strconv.Itoa(p)))
		if err == nil {
			ln.Close()
			return p
		}
	}
	return start
}

func envBool(name string) bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(name))) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}

func openBrowser(url string) {
	var cmd string
	var args []string
	switch runtime.GOOS {
	case "windows":
		cmd, args = "rundll32", []string{"url.dll,FileProtocolHandler", url}
	case "darwin":
		cmd, args = "open", []string{url}
	default:
		cmd, args = "xdg-open", []string{url}
	}
	_ = exec.Command(cmd, args...).Start()
}
