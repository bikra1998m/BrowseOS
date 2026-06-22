# Deploying BrowserOS — both ways

BrowserOS ships **real Linux** (x86 kernel emulated in WebAssembly via v86).
There are two delivery modes; you can ship both from the same `public/` folder.

---

## 1) Hosted website (zero dependency for your users)

Your users just open a URL. The web host *is* the "server" — they install nothing.
All assets are static, so any static host works **as long as it sends the right headers**
(cross-origin isolation + `application/wasm`). Configs are included:

### Netlify
```bash
npm i -g netlify-cli
cd browseros
netlify deploy --prod         # uses netlify.toml
```

### Vercel
```bash
npm i -g vercel
cd browseros
vercel --prod                 # uses vercel.json
```

### Cloudflare Pages / GitHub Pages / S3+CloudFront / Nginx
Serve the `public/` folder and apply the headers from `public/_headers`
(or your server config):
```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Resource-Policy: cross-origin
Content-Security-Policy: default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'self' ws: wss: https://cloudflare-dns.com; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Referrer-Policy: no-referrer
Content-Type: application/wasm        # for .wasm
Accept-Ranges: bytes                  # for disk images
```

> **PWA bonus:** the site registers a service worker and pre-caches the app,
> emulator, BIOS, and Buildroot fallback. Alpine becomes available offline after
> one successful online Alpine boot; offline tools are cached as they are used.
> Verified asset hashes are included in every VM asset URL, so new deployments
> do not reuse year-long immutable cache entries from an older release. Cached
> full disk images also answer v86 byte-range reads while offline.

Hosted deployments need a compatible WISP endpoint for full guest TCP/HTTPS
internet. Enter its `wisps://...` URL in **Network → NAT → Internet proxy**.
The self-contained Go launcher does not need an external endpoint because it
serves `/wisp/` itself.

---

## 2) Offline downloadable package (no internet at all)

Zip the whole `browseros/` folder and send it. Your users:

- **Windows:** double-click `run-offline.bat`
- **macOS/Linux:** double-click `run-offline.command` (or `./scripts/start.sh`)

It launches a tiny local server and opens the browser. Everything (engine + Linux
image) is bundled — no downloads, no internet. The only prerequisite is Python 3,
which ships with macOS/most Linux and is a one-click install on Windows.

For a **truly prerequisite-free** package, build the included Go launcher:
`cd launcher && ./build.sh`. It produces self-contained Windows, macOS, and Linux
binaries in `launcher/dist/`. Its built-in WISP proxy gives the guest outbound
DNS and TCP/HTTPS access without administrator privileges.

---

## Why a server is needed at all
Browsers refuse to load `.wasm` and disk images over `file://` for security, and a
real OS is a binary kernel that must be fetched over HTTP. So *something* serves the
files. In **hosted** mode that's your web host (invisible to users); in **offline**
mode it's the tiny bundled launcher. There is no way around this for a *real* OS —
only a *simulated* one could be a single dependency-free file.

---

## Customizing the guest OS
Default is full **Alpine Linux**, with the 5.4 MB Buildroot image as an instant
offline fallback. To ship another image with company software pre-installed, edit
`public/app.js`, place the image in `public/images/`, then regenerate
`public/asset-manifest.js` so hosted caches receive a new content-versioned URL.
See README → "Customize the OS".
