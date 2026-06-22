# 🚀 BrowserOS — Getting Started

A **real Linux** that runs inside your browser. Default OS is **Alpine Linux**
(falls back to a bundled Buildroot Linux if Alpine isn't downloaded yet).

> ⚠️ You **cannot** just double-click `public/index.html` — browsers block the
> engine/disk files over `file://`. Always start it with one of the methods below
> (they run a tiny local server, which is what makes it work).

---

## 0) Unzip
Extract the download. You should see folders: `public/`, `scripts/`, `launcher/`,
and files like `run-offline.bat`, `README.md`.

---

## ⭐ Pick ONE path

### Path A — Run it now (needs Python)
**Windows (double-click):** open `run-offline.bat` in File Explorer.
**macOS/Linux (double-click):** open `run-offline.command`.

Or from a terminal (works in Git Bash too):
```bash
./scripts/start.sh
```
If Python isn't installed, these will try to install it automatically.
Then a browser opens at **http://localhost:8086** → click **Boot**.

The local server binds to loopback by default. To deliberately expose it to
trusted devices on your LAN, start it with `BROWSEROS_ALLOW_LAN=1`.

BrowserOS adds a `?vm=...` identifier to the URL. Keep or bookmark that URL to
return to the same VM state and its isolated named snapshots.

> In **Git Bash on Windows**, do NOT run `run-offline.bat` (it's a cmd file).
> Use `./scripts/start.sh` instead. If `python3` isn't found but `python` is:
> `python scripts/server.py 8086 public`

---

### Path B — Zero-dependency binary (no Python, best for sharing)
Requires **Go** on YOUR machine to build (users of the binary need nothing).
Install Go: https://go.dev/dl/  then:
```bash
cd launcher
./build.sh            # bundles full Alpine inside the binary (auto-downloads it)
```
Run the file for your OS from `launcher/dist/`:
- Windows: `BrowserOS-windows-x64.exe`
- macOS:   `BrowserOS-macos-apple-silicon` or `-intel`
- Linux:   `BrowserOS-linux-x64` or `-arm64`

It opens your browser automatically. Hand this single file to anyone — no install
and no download required. The launcher also provides cross-platform outbound
internet to the guest through its built-in WISP proxy.

Build variants:
```bash
./build.sh --lite          # smaller; only Buildroot embedded
```

---

### Path C — Host it online (your users just open a link)
```bash
npx netlify deploy --prod   # uses netlify.toml
# or
npx vercel --prod           # uses vercel.json
```
See `DEPLOY.md` for other hosts. Users need nothing but a browser.

---

## 1) Choosing / downloading an OS
The **Operating system** dropdown (right panel) has three options:

| OS | How to get it | Notes |
|----|---------------|-------|
| **Alpine Linux** (default) | `./scripts/setup.sh --alpine` | Alpine 3.24.1, `apk`, ~49 MB |
| **Buildroot** | bundled already | instant, offline, minimal |
| **Custom ISO/IMG** | upload in the UI | bring a compatible x86 boot image |

If you pick an OS that isn't downloaded, BrowserOS auto-falls back to Buildroot
and tells you which `setup.sh` command to run.

---

## ⚡ Pre-baked offline tools (no internet needed)
The standalone launcher supports guest DNS and TCP/HTTPS in **NAT** mode, so
`apk add` / `apt install` can use the internet. BrowserOS also ships pre-baked
tools as a **virtio-9p filesystem**
(`public/images/tools9p/` + `tools9p.json`, ~50 MB) containing bash, sudo, git,
curl, wget, nano, vim, python3, pip, htop, net-tools, coreutils, etc. — all
installable **offline** when internet is unavailable. (We use 9p, not an IDE disk, because the alpine-virt
kernel can't see IDE disks but supports virtio-9p natively.)

For networking, use **NAT** for a stable per-VM `192.168.86.x` address and normal
internet access. NAT VMs remain isolated from each other. **NAT Network** is the
separate VM-to-VM Ethernet relay and only has internet when its relay host also
provides NAT.

To give a Windows guest a real address on the host LAN, install
[Npcap](https://npcap.com/), run the self-contained launcher, and choose
**Network → Attached to → Bridged Adapter**. BrowserOS detects the active adapter,
offers an unused address from its subnet, and exposes the VM to other LAN
devices. Do not use Bridged Adapter on an untrusted public network.

How to use:
1. Boot Alpine, log in as `root`.
2. Click inside the console, then click **⚡ Setup Ubuntu env**.
3. It mounts the tools disk and installs everything offline (~30–60s), sets up the
   `apt` shim, `ll` alias, and Ubuntu-style prompt.
4. Type `exec bash -l`, then try `ll`, `python3 --version`, `git --version`.

Rebuild the tools (e.g. to add packages) on a machine with internet:
```bash
cd prebake
python3 build-repo.py     # downloads/verifies the exact packages.lock.json set
python3 make-9p.py        # builds ../public/images/tools9p/ + tools9p.json
```
`python3 build-repo.py --check` is a fully offline integrity check. To change
the package set, edit `WANT`, then deliberately run
`python3 build-repo.py --update-lock`; this fetches Alpine's indexes and rewrites
the exact filename/size/SHA-256 lock.

After changing any checked-in engine, BIOS, ISO, tools index, or preinstalled
snapshot, run `./scripts/generate-asset-manifest.sh`. The normal setup and
`rebuild-all.sh` flows do this automatically.

### Pre-install everything (tools ready at boot — no setup step)
Build a state snapshot so Alpine boots straight into a fully set-up system
(bash, git, python3, apt shim, ll already installed — no install after login):
```bash
cd prebake
node make-snapshot.js     # boots Alpine headless, installs tools, saves the state
```
This writes `public/images/alpine-preinstalled.bin`. When present, BrowserOS boots
Alpine directly into it. Then rebuild the binary (`cd launcher && ./build.sh`).
Requires Node + the Alpine ISO + internet (for the one-time package install).

## 2) Using the OS
- Click **Boot**. First Alpine boot takes ~1–3 min.
- Log in as **`root`** (no password).
- Install software:
  - Alpine: `apk update && apk add bash git python3 nano`
- Buildroot is minimal: no package manager, you're already root, use `ls -ltr`.

### Boot screen tools
- **Show logs ▾** — watch the live kernel console
- **Filter box + chips** (`error`/`warn`/`fail`/`panic`) — find problems fast
- Error/warning lines auto-color **red/yellow**
- **Cancel boot** (or press **Esc**) — stop a slow boot
- **Copy logs** — copy the console to clipboard

### Machine controls (top bar)
- **Save** — snapshot your session to the browser. Alpine/Buildroot auto-save
  every five minutes and when the page has been active long enough before being hidden.
- **Reset** — wipe saved state, start fresh
- **Pause/Resume**, **Ctrl-Alt-Del**, **Fullscreen**, **Export state**

### Desktop mode
- Click **Desktop** to open the Ubuntu-like workspace.
- Firefox does not open automatically. Click the **Firefox** fox icon in the dock.
- Firefox ESR, Xorg, Openbox, fonts, and media libraries run inside the Alpine
  VM. Websites stay in the VM display rather than opening in the host browser.
- First launch installs the verified offline GUI bundle and can take several
  minutes. Alpine defaults to 1024 MB RAM; Firefox files live on writable
  virtio-9p storage instead of Alpine's small RAM-backed live root.

---

## 3) Customize / white-label
- Name, colors, logo, company → edit **`public/branding.js`** (replace `public/logo.png`)
- Bake your own software into a custom image → see **`scripts/build-custom-image.md`**

---

## ❓ Troubleshooting
| Problem | Fix |
|---|---|
| `python3: not found` (Git Bash) | use `python scripts/server.py 8086 public` |
| `run-offline.bat` errors in Git Bash | run `./scripts/start.sh` instead |
| `'setlocal' is not recognized` | you ran the `.bat` in bash — use Path A's `start.sh` |
| Blank page / files won't load | you opened `index.html` directly — use a launcher |
| Alpine "not found" on boot | run `./scripts/setup.sh --alpine` |
| Stuck at `Loading hardware drivers` | regenerate the patched Alpine ISO with `./scripts/setup.sh --alpine`, then hard-refresh |
| `go: command not found` (Path B) | install Go from https://go.dev/dl/ |
