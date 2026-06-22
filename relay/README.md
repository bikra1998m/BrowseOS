# BrowserOS Virtual-Switch Relay

This gives **multiple browser-tab VMs a real network**: each tab gets a
**unique IP** and the VMs can **ping/SSH each other**. It's the only way to do
this with browser-based VMs, because a browser tab can't run a virtual switch —
so this small server does it, and the VMs connect to it over WebSocket.

```
 Tab 1 (VM) ─ws─┐
 Tab 2 (VM) ─ws─┼──►  relay  → assigns 10.5.0.2, .3, .4 …  + forwards frames
 Tab 3 (VM) ─ws─┘                (VMs see each other)
```

## Run it

### Option A — Node.js
```bash
cd relay
npm ci
node relay.js          # ws://127.0.0.1:9000 (local-only by default)
```

### Option B — Go (single binary, no deps)
```bash
cd relay
go build -o browseros-relay relay.go
./browseros-relay      # ws://127.0.0.1:9000 (local-only by default)
```
(Cross-compile for Windows: `GOOS=windows go build -o browseros-relay.exe relay.go`)

## Point BrowserOS at it
In each tab's right panel:
1. **Network → Attached to → NAT Network**
2. **Relay URL** = `ws://127.0.0.1:9000` on the same machine.
   To expose it to trusted LAN devices, explicitly start it with
   `BROWSEROS_ALLOW_LAN=1` and use `ws://<the-relay-host-ip>:9000`.
   - same machine: `ws://127.0.0.1:9000`
   - other devices: `ws://192.168.1.50:9000` (the relay host's LAN IP)
3. Boot. Inside each VM bring the NIC up:
   ```sh
   ip link set eth0 up
   udhcpc -i eth0
   ip a          # tab 1 -> 10.5.0.2, tab 2 -> 10.5.0.3, ...
   ```
4. From tab 1, ping tab 2:
   ```sh
   ping 10.5.0.3
   ```

## What works / what doesn't (honest)
- ✅ **Unique IP per VM** (DHCP) — tested
- ✅ **Inter-VM communication** (the relay is an L2 switch) — tested
- ✅ ARP + DHCP for the `10.5.0.0/24` subnet
- ⚠️ **Internet (NAT to the outside)** — the *simple* relay above does NOT do it.
  Use the **advanced NAT relay** below for full internet access.

---

# 🚀 Advanced: full NAT Network (unique IPs + inter-VM + INTERNET)

`relay-nat.go` is a Linux-only relay that gives VMs **everything VirtualBox's
NAT Network does**: unique IPs, VM-to-VM comms, **and internet** — by bridging
the WebSocket Ethernet frames to a kernel **TUN** device and NAT'ing with
iptables.

### Requirements
- **Linux host** with **root** (for `/dev/net/tun` + `iptables`)
- **Go** to build (`go build`)

### Run
```bash
cd relay
sudo ./setup-nat.sh        # local browser only
sudo ./setup-nat.sh --lan  # explicit LAN exposure
```
It will:
1. create the `browseros0` TUN device, IP `10.5.0.1/24`
2. enable `net.ipv4.ip_forward=1`
3. add an `iptables MASQUERADE` rule (`10.5.0.0/24` → your internet interface)
4. start the WebSocket relay on `:9000`

### Use in BrowserOS
For local use, each tab → **Network → NAT Network → Relay URL =
`ws://127.0.0.1:9000`** → Boot. With `--lan`, use the relay host's private IP.
Inside each VM:
```sh
ip link set eth0 up && udhcpc -i eth0
ip a                 # tab1=10.5.0.2, tab2=10.5.0.3 ...
ping 10.5.0.3        # reach another VM
ping 8.8.8.8         # reach the INTERNET (via NAT)
apk update           # works!
```

### Stop / clean up
Ctrl-C the relay, then:
```bash
sudo ./cleanup-nat.sh      # removes the iptables rules + TUN device
```

### Verified
- ✅ `relay-nat.go` compiles + passes `go vet`
- ✅ Shares the tested WebSocket/DHCP/L2-switch core (DHCP offer + inter-VM proven)
- ⚠️ TUN+iptables paths require root, so they run on YOUR Linux host (can't be
  exercised in an unprivileged sandbox) — they use standard `TUNSETIFF` + the
  same `iptables MASQUERADE` pattern VirtualBox/QEMU use.

### Notes
- macOS/Windows: this advanced relay is **Linux-only** (TUN+iptables). On those,
  run it inside a Linux VM/WSL2/Docker (`--cap-add=NET_ADMIN --device /dev/net/tun`).
- Security: it forwards VM traffic to the internet via your host. Run on a
  trusted network; LAN exposure is disabled by default. Firewall port 9000 if
  you enable it. For a browser hosted on a different origin, set an exact
  allowlist such as `BROWSEROS_ALLOWED_ORIGINS=https://browseros.example`.
