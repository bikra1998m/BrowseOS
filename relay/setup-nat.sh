#!/usr/bin/env bash
# BrowserOS advanced NAT relay — build (if needed) and run with root.
# Gives browser-tab VMs unique IPs, inter-VM comms, AND internet (NAT Network).
# Linux only. Requires: go (to build), root (TUN + iptables).
set -e
cd "$(dirname "$0")"

ALLOW_LAN="${BROWSEROS_ALLOW_LAN:-0}"
if [ "${1:-}" = "--lan" ]; then
  ALLOW_LAN=1
  shift
fi

if [ "$(id -u)" != "0" ]; then
  echo "This needs root (TUN + iptables). Re-running with sudo..."
  exec sudo PORT="${PORT:-9000}" BROWSEROS_ALLOW_LAN="$ALLOW_LAN" \
    BROWSEROS_ALLOWED_ORIGINS="${BROWSEROS_ALLOWED_ORIGINS:-}" "$0" "$@"
fi

BIN=./browseros-relay-nat
if [ ! -x "$BIN" ]; then
  if ! command -v go >/dev/null; then
    echo "Go is required to build the relay. Install from https://go.dev/dl/"
    exit 1
  fi
  echo "Building $BIN ..."
  go build -o "$BIN" relay-nat.go
fi

# Make sure /dev/net/tun exists.
if [ ! -e /dev/net/tun ]; then
  echo "Creating /dev/net/tun ..."
  mkdir -p /dev/net
  mknod /dev/net/tun c 10 200 || true
  chmod 600 /dev/net/tun || true
fi

echo "Starting BrowserOS NAT relay on port ${PORT:-9000} (LAN access: $ALLOW_LAN) ..."
echo "(Ctrl-C to stop; run ./cleanup-nat.sh afterward to remove NAT rules)"
exec env PORT="${PORT:-9000}" BROWSEROS_ALLOW_LAN="$ALLOW_LAN" \
  BROWSEROS_ALLOWED_ORIGINS="${BROWSEROS_ALLOWED_ORIGINS:-}" "$BIN"
