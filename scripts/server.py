#!/usr/bin/env python3
"""Tiny static server for BrowserOS.

Adds the headers v86 needs:
  * correct application/wasm MIME type
  * COOP/COEP so SharedArrayBuffer (fast path) is allowed
  * HTTP Range support (Python's handler already provides it for files)
"""
import sys
import os
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8086
ROOT = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(__file__), "..", "public")
ROOT = os.path.abspath(ROOT)
ALLOW_LAN = os.environ.get("BROWSEROS_ALLOW_LAN", "").strip().lower() in {
    "1", "true", "yes", "on",
}
BIND_HOST = "0.0.0.0" if ALLOW_LAN else "127.0.0.1"
CONTENT_SECURITY_POLICY = (
    "default-src 'self'; "
    "script-src 'self' 'wasm-unsafe-eval'; "
    "worker-src 'self' blob:; "
    "connect-src 'self' ws: wss: https://cloudflare-dns.com; "
    "img-src 'self' data: blob:; "
    "style-src 'self' 'unsafe-inline'; "
    "font-src 'self' data:; "
    "object-src 'none'; "
    "base-uri 'self'; "
    "form-action 'self'; "
    "frame-ancestors 'none'"
)


class Handler(SimpleHTTPRequestHandler):
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".wasm": "application/wasm",
        ".js": "text/javascript",
        ".json": "application/json",
        ".bin": "application/octet-stream",
        ".img": "application/octet-stream",
        ".iso": "application/octet-stream",
    }

    def __init__(self, *a, **k):
        super().__init__(*a, directory=ROOT, **k)

    # ---- HTTP Range support (lets v86 stream large disk images) ----
    def send_head(self):
        rng = self.headers.get("Range")
        if not rng or not rng.startswith("bytes="):
            return super().send_head()
        path = self.translate_path(self.path)
        if not os.path.isfile(path):
            return super().send_head()
        try:
            size = os.path.getsize(path)
            start_s, _, end_s = rng[len("bytes="):].partition("-")
            start = int(start_s) if start_s else 0
            end = int(end_s) if end_s else size - 1
            end = min(end, size - 1)
            if start > end or start >= size:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.end_headers()
                return None
            length = end - start + 1
            f = open(path, "rb")
            f.seek(start)
            self.send_response(206)
            ctype = self.guess_type(path)
            self.send_header("Content-Type", ctype)
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
            self.send_header("Content-Length", str(length))
            self.end_headers()
            self._range_remaining = length
            return f
        except (OSError, ValueError):
            return super().send_head()

    def copyfile(self, source, outputfile):
        remaining = getattr(self, "_range_remaining", None)
        if remaining is None:
            return super().copyfile(source, outputfile)
        self._range_remaining = None
        while remaining > 0:
            chunk = source.read(min(64 * 1024, remaining))
            if not chunk:
                break
            outputfile.write(chunk)
            remaining -= len(chunk)

    def end_headers(self):
        # Cross-origin isolation enables SharedArrayBuffer (smoother v86).
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cross-Origin-Resource-Policy", "cross-origin")
        self.send_header("Content-Security-Policy", CONTENT_SECURITY_POLICY)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header(
            "Permissions-Policy",
            "camera=(), microphone=(), geolocation=(), usb=(), payment=()",
        )
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write("  %s\n" % (fmt % args))


if __name__ == "__main__":
    os.chdir(ROOT)
    httpd = ThreadingHTTPServer((BIND_HOST, PORT), Handler)
    print(f"Serving {ROOT} on {BIND_HOST}:{PORT}")
    print(
        "LAN access enabled"
        if ALLOW_LAN
        else "LAN access disabled (set BROWSEROS_ALLOW_LAN=1 to opt in)"
    )
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
