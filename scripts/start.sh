#!/usr/bin/env bash
# BrowserOS launcher — serves /public with correct headers and opens the browser.
# A web server is required because browsers refuse to load .wasm and disk
# images over file:// URLs.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PORT:-8086}"

if [ ! -f "$ROOT/public/vendor/v86.wasm" ]; then
  echo "⚠  Engine not found. Run ./scripts/setup.sh first." >&2
  exit 1
fi

URL="http://localhost:$PORT/"
case "${BROWSEROS_ALLOW_LAN:-}" in
  1|true|TRUE|yes|YES|on|ON)
    # Best-effort LAN IP when the user explicitly opts into network exposure.
    LAN_IP="$( (hostname -I 2>/dev/null | awk '{print $1}') || ipconfig getifaddr en0 2>/dev/null || echo '')"
    [ -n "$LAN_IP" ] && printf "  On your LAN: http://%s:%s/\n" "$LAN_IP" "$PORT"
    ;;
esac

# Find a Python interpreter (python3 on Linux/mac, python or py on Windows).
PY=""
for c in python3 python py; do
  if command -v "$c" >/dev/null 2>&1; then PY="$c"; break; fi
done

# Not found? Try to install it automatically.
if [ -z "$PY" ]; then
  echo "Python not found — attempting automatic install..."
  OS="$(uname -s 2>/dev/null || echo unknown)"
  case "$OS" in
    Darwin)
      if command -v brew >/dev/null 2>&1; then brew install python; fi ;;
    Linux)
      if   command -v apt-get >/dev/null 2>&1; then sudo apt-get update && sudo apt-get install -y python3
      elif command -v dnf     >/dev/null 2>&1; then sudo dnf install -y python3
      elif command -v pacman  >/dev/null 2>&1; then sudo pacman -Sy --noconfirm python
      elif command -v apk     >/dev/null 2>&1; then sudo apk add python3
      fi ;;
    *) # Windows / Git Bash: launch the bundled auto-installer launcher
      echo "On Windows, please run run-offline.bat (it auto-installs Python)." ;;
  esac
  for c in python3 python py; do
    if command -v "$c" >/dev/null 2>&1; then PY="$c"; break; fi
  done
fi

if [ -z "$PY" ]; then
  echo "⚠  Python could not be found or installed automatically." >&2
  echo "   Windows: double-click run-offline.bat (auto-installs Python)." >&2
  echo "   Or install manually from https://www.python.org/downloads/" >&2
  exit 1
fi

printf "\033[1;32m▶ BrowserOS serving at %s  (Ctrl-C to stop)\033[0m\n" "$URL"
printf "   using interpreter: %s\n" "$PY"

# Open default browser (best-effort, cross-platform).
( sleep 1
  if command -v xdg-open >/dev/null; then xdg-open "$URL"
  elif command -v open >/dev/null; then open "$URL"
  elif command -v start >/dev/null; then start "$URL"
  fi ) >/dev/null 2>&1 &

exec "$PY" "$ROOT/scripts/server.py" "$PORT" "$ROOT/public"
