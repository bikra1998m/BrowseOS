#!/usr/bin/env bash
# BrowserOS offline launcher (macOS/Linux) — double-click to run.
# Auto-installs Python if missing, then serves the bundled real Linux locally.
cd "$(dirname "$0")" || exit 1
PORT="${PORT:-8086}"

find_python() {
  for c in python3 python py; do
    if command -v "$c" >/dev/null 2>&1; then
      # make sure it's Python 3
      if "$c" -c 'import sys; exit(0 if sys.version_info[0]>=3 else 1)' >/dev/null 2>&1; then
        echo "$c"; return 0
      fi
    fi
  done
  return 1
}

PY="$(find_python || true)"

if [ -z "$PY" ]; then
  echo "Python 3 was not found. Attempting to install it automatically..."
  OS="$(uname -s)"

  if [ "$OS" = "Darwin" ]; then
    # macOS: prefer Homebrew; otherwise download the official universal pkg.
    if command -v brew >/dev/null 2>&1; then
      echo "Installing Python via Homebrew..."
      brew install python
    else
      PKGVER="3.12.4"
      PKG="/tmp/python-$PKGVER-macos11.pkg"
      echo "Downloading official Python $PKGVER installer..."
      curl -fL -o "$PKG" "https://www.python.org/ftp/python/$PKGVER/python-$PKGVER-macos11.pkg" || true
      if [ -f "$PKG" ]; then
        echo "Installing Python (you may be asked for your password)..."
        sudo installer -pkg "$PKG" -target / || true
        rm -f "$PKG"
      fi
    fi

  elif [ "$OS" = "Linux" ]; then
    echo "Installing Python via your system package manager..."
    if   command -v apt-get >/dev/null 2>&1; then sudo apt-get update && sudo apt-get install -y python3
    elif command -v dnf      >/dev/null 2>&1; then sudo dnf install -y python3
    elif command -v yum      >/dev/null 2>&1; then sudo yum install -y python3
    elif command -v pacman   >/dev/null 2>&1; then sudo pacman -Sy --noconfirm python
    elif command -v zypper   >/dev/null 2>&1; then sudo zypper install -y python3
    elif command -v apk      >/dev/null 2>&1; then sudo apk add python3
    fi
  fi

  PY="$(find_python || true)"
fi

if [ -z "$PY" ]; then
  echo
  echo "Could not install Python automatically."
  echo "Please install it manually from https://www.python.org/downloads/ and run this again."
  read -r -p "Press Enter to close..." _
  exit 1
fi

echo "BrowserOS is starting at http://localhost:$PORT  (close this window to stop)"
( sleep 1; (command -v open >/dev/null && open "http://localhost:$PORT/") \
  || (command -v xdg-open >/dev/null && xdg-open "http://localhost:$PORT/") ) >/dev/null 2>&1 &
exec "$PY" scripts/server.py "$PORT" public
