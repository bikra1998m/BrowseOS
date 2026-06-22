#!/usr/bin/env bash
# Remove the NAT rules + TUN device created by the advanced relay.
set -e
[ "$(id -u)" = "0" ] || exec sudo "$0" "$@"

SUBNET="10.5.0"
TUN="browseros0"
OUTIF="$(ip route show default | awk '{print $5; exit}')"

echo "Removing iptables NAT/forward rules..."
iptables -t nat -D POSTROUTING -s ${SUBNET}.0/24 -o "$OUTIF" -j MASQUERADE 2>/dev/null || true
iptables -D FORWARD -i "$TUN" -o "$OUTIF" -j ACCEPT 2>/dev/null || true
iptables -D FORWARD -i "$OUTIF" -o "$TUN" -m state --state RELATED,ESTABLISHED -j ACCEPT 2>/dev/null || true

echo "Removing TUN device..."
ip link del "$TUN" 2>/dev/null || true

echo "Done. (IP forwarding sysctl left as-is.)"
