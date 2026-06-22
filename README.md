# BrowserOS

**A real Linux operating system that runs entirely inside the browser** — no install, no VM software, no cloud. It boots an actual x86 Linux kernel (Alpine) emulated in WebAssembly via [v86](https://github.com/copy/v86), wrapped in a clean web UI. Your files and session state are **saved in the browser (IndexedDB)** so they survive refreshes.

> Built as a self-hostable product front-end. Drop `public/` on any static host and your users get a Linux box in a tab.

---

## ⚡ Quick start

```bash
cd browseros
./scripts/setup.sh --alpine  # one-time: download the engine + Alpine image
./scripts/start.sh     # serve + open http://localhost:8086
```

Then click **Boot**. When you reach the prompt, log in as `root` (no password).

---

## 🤔 Honest note on "single file, zero dependency"

You asked for a *single HTML file with no physical dependency*. Here's the unavoidable truth for **real** Linux:

A real OS needs three binary blobs the browser must download — the WASM CPU emulator (`v86.wasm`), the BIOS ROMs, and the Linux disk image (tens of MB). These **cannot** be embedded in one `.html` file in practice, and browsers **block** loading them from `file://`. So a tiny static web server is required.

What you *get* instead:
- ✅ **Real Linux** (genuine kernel + busybox/apk shell), not a fake UI
- ✅ **Zero install for the end user** — just a URL in any modern browser
- ✅ **Persistent** — state saved client-side in IndexedDB
- ✅ **Self-contained project** — one folder, one command to run/host

If you truly need a *literal single file*, that's only possible with a **simulated** shell (not a real kernel). Say the word and I'll build that variant too.

---

## 🧩 What's in the box

```
browseros/
├── public/
│   ├── index.html        # UI: top bar, screen, side panel
│   ├── app.js            # v86 boot logic + IndexedDB persistence
│   ├── vendor/           # v86 engine (filled by setup.sh)
│   └── images/           # boot images + Alpine offline tools
└── scripts/
    ├── setup.sh          # downloads engine + OS image
    ├── start.sh          # launches the local server + opens browser
    └── server.py         # static server with WASM MIME + COOP/COEP headers
```

## 🎛️ Features in the UI
- **Boot / Save / Reset** machine controls
- Docked **Firefox ESR** that runs inside the Alpine VM through Xorg/Openbox
- Cross-platform guest **NAT internet** in the standalone launcher (DHCP, DNS,
  TCP/HTTPS; no administrator privileges or TUN/TAP driver)
- Optional Windows **Bridged Adapter** mode using an installed Npcap driver:
  guests receive real host-subnet addresses and are reachable from other LAN
  devices through proxy ARP and Wi-Fi-safe MAC translation
- Serialized **auto-save** every 5 minutes, plus throttled background saves
- **Pause/Resume**, **Ctrl-Alt-Del**, **Export state** to a file
- Live **uptime** and machine info panel
- **Fullscreen** mode

## 🚀 Deploying for your product
The `public/` folder is fully static. Host it on Netlify, Vercel, S3+CloudFront, Nginx, etc.
Make sure your host sends:
- `Content-Type: application/wasm` for `.wasm`
- `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp`
- HTTP **Range** support for the disk image

## 🔧 Customize the OS
Want another distro, a custom rootfs, or your company's tooling pre-installed?
Swap the `filesystem` / `cmdline` (or use an `hda` disk image) in `public/app.js`.
See v86's [custom image guide](https://github.com/copy/v86/discussions/1245).

## 🔒 Reproducible offline tools
The bundled Alpine APK collection is pinned by
`prebake/packages.lock.json`. `python3 prebake/build-repo.py --check` verifies
every locked package filename, size, and SHA-256 hash without using the network.
Updating dependencies is an explicit `--update-lock` maintenance operation.
`scripts/generate-asset-manifest.sh` turns those verified hashes into browser
cache keys, so hosted upgrades cannot silently reuse an older VM engine or ISO.
Setup deterministically patches Alpine's verified ISO boot command line to skip
the v86-incompatible hardware auto-detection pass while preserving VGA BIOS
initialization for guest Xorg/Firefox.
The service worker can serve v86 byte ranges from cached full disk images, so
asynchronous disks remain readable after the hosted app goes offline.

## 🎨 White-labeling / branding
Edit **`public/branding.js`** — name, tagline, company, support link, logo, and the
full color theme are all variables there. No build step; just change and reload.
Replace `public/logo.png` with your own logo to rebrand instantly.

## 🐧 Choosing the OS
Use the **Operating system** dropdown in the UI:
- **Alpine Linux** — default full distro with `apk`. Fetch it first:
  ```bash
  ./scripts/setup.sh --alpine
  ```
- **Buildroot Linux** — bundled, instant, fully offline fallback
Want **your own** image with company software baked in? See
[`scripts/build-custom-image.md`](scripts/build-custom-image.md).

## 📦 Prerequisite-free offline binaries (no Python needed)
Build single self-contained executables for Windows, macOS, and Linux — each one
embeds the **entire** OS image, so users just run the file (nothing to install):
```bash
cd launcher
./build.sh                # bundles Alpine (full apk distro) — auto-downloads it
./build.sh --lite         # smaller: embed only Buildroot
```
Output lands in `launcher/dist/` (e.g. `BrowserOS-windows-x64.exe`,
`BrowserOS-macos-apple-silicon`, `BrowserOS-linux-x64`). By default the shared
binary boots a **full Alpine Linux** offline. Verified truly static
(`ldd` → "not a dynamic executable").

The launcher exposes two different network modes: **NAT** gives every saved VM a
stable unique `192.168.86.x` address and uses the built-in WISP proxy for normal
outbound internet, while **NAT Network** uses the raw Ethernet relay for direct
communication between BrowserOS VMs.

On Windows, **Bridged Adapter** becomes available when
[Npcap](https://npcap.com/) is installed. It allocates a free address from the
active host subnet (for example `192.168.1.x`), advertises that address with
proxy ARP, and translates Ethernet MAC addresses so it also works over Wi-Fi.
This exposes the guest to the local network. Some Wi-Fi drivers do not loop
packets back to the same host, so test inbound access from another LAN device
rather than relying on a host-to-guest ping.

## 📄 License
Your code here is yours. v86 is BSD-2-Clause; Alpine is its own license.
