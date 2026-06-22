#!/usr/bin/env python3
"""Verify the local Python server emits the browser security policy."""

import importlib.util
from pathlib import Path
import threading
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "server.py"
SPEC = importlib.util.spec_from_file_location("browseros_server", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(MODULE)

server = MODULE.ThreadingHTTPServer(("127.0.0.1", 0), MODULE.Handler)
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
try:
    with urllib.request.urlopen(
        f"http://127.0.0.1:{server.server_port}/index.html", timeout=5
    ) as response:
        headers = response.headers
        assert headers["Content-Security-Policy"] == MODULE.CONTENT_SECURITY_POLICY
        assert headers["X-Content-Type-Options"] == "nosniff"
        assert headers["X-Frame-Options"] == "DENY"
        assert headers["Referrer-Policy"] == "no-referrer"
        assert "camera=()" in headers["Permissions-Policy"]

    versioned_iso = (
        f"http://127.0.0.1:{server.server_port}/images/linux.iso?v=test-version"
    )
    head = urllib.request.Request(versioned_iso, method="HEAD")
    with urllib.request.urlopen(head, timeout=5) as response:
        assert response.status == 200
        assert int(response.headers["Content-Length"]) > 0

    ranged = urllib.request.Request(
        versioned_iso, headers={"Range": "bytes=0-0"}
    )
    with urllib.request.urlopen(ranged, timeout=5) as response:
        assert response.status == 206
        assert response.headers["Content-Range"].startswith("bytes 0-0/")
        assert len(response.read()) == 1
finally:
    server.shutdown()
    server.server_close()
    thread.join(timeout=5)

print("local server security header checks passed")
