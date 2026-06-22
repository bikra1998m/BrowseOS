/* BrowserOS service worker — caches the app shell and versioned VM assets.
 *
 * Strategy:
 *  - App shell (html/js/css/branding/logo): NETWORK-FIRST, so updates show up
 *    immediately and you never get trapped on a stale UI.
 *  - Content-versioned VM assets: CACHE-FIRST. Buildroot is pre-cached; Alpine
 *    and its offline tools become available offline after they are fetched once.
 *  - HEAD probes can be answered from a cached GET, so offline Alpine detection
 *    does not incorrectly fall back to Buildroot.
 *  - Byte-range disk reads are sliced from cached full responses, allowing v86
 *    asynchronous disks to keep working without a network connection.
 */
importScripts("./asset-manifest.js");

const ASSETS = self.BROWSEROS_ASSETS;
const CACHE = "browseros-v30";
const cachedBlobs = new Map();

// Core offline boot assets. Alpine is cached on first successful online boot
// rather than during service-worker installation to avoid a mandatory 49 MB
// download before the app can become ready.
const CORE_ASSETS = [
  ASSETS.libv86, ASSETS.wasm,
  ASSETS.bios, ASSETS.vgaBios,
  ASSETS.buildrootIso,
];

// App shell — always try the network first so new builds win.
const SHELL = ["./", "./index.html", "./app.js", "./branding.js", "./browseros-capabilities.json", "./url-policy.js", "./asset-manifest.js", "./asset-loader.js", "./bootstrap.js", "./instance-id.js", "./save-coordinator.js", "./screen-dock.js",
               "./logo.png", "./icon.svg", "./manifest.webmanifest", "./desktop.css", "./desktop.js"];

self.addEventListener("install", (e) => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE).then((c) =>
      c.addAll([...SHELL, ...CORE_ASSETS]).catch(() => {})
    )
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function isShell(url) {
  const p = new URL(url).pathname;
  return p === "/" || p.endsWith("/index.html") || p.endsWith("/app.js") ||
         p.endsWith("/branding.js") || p.endsWith("/logo.png") ||
         p.endsWith("/browseros-capabilities.json") ||
         p.endsWith("/icon.svg") || p.endsWith("/manifest.webmanifest") ||
         p.endsWith("/url-policy.js") || p.endsWith("/asset-manifest.js") ||
         p.endsWith("/asset-loader.js") || p.endsWith("/bootstrap.js") ||
         p.endsWith("/instance-id.js") || p.endsWith("/save-coordinator.js") ||
         p.endsWith("/screen-dock.js") || p.endsWith("/desktop.js") ||
         p.endsWith("/desktop.css");
}

function parseSingleRange(value, size) {
  if (typeof value !== "string" || !Number.isSafeInteger(size) || size < 0) return null;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(value.trim());
  if (!match || (!match[1] && !match[2])) return null;

  let start;
  let end;
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0 || size === 0) return null;
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(match[1]);
    if (!Number.isSafeInteger(start) || start >= size) return null;
    if (match[2]) {
      end = Number(match[2]);
      if (!Number.isSafeInteger(end) || end < start) return null;
      end = Math.min(end, size - 1);
    } else {
      end = size - 1;
    }
  }
  return { start, end };
}

async function blobForCachedResponse(url, response) {
  let promise = cachedBlobs.get(url);
  if (!promise) {
    promise = response.blob().catch((error) => {
      cachedBlobs.delete(url);
      throw error;
    });
    cachedBlobs.set(url, promise);
  }
  return promise;
}

async function cachedRangeResponse(request) {
  const hit = await caches.match(request.url);
  if (!hit || !hit.ok || hit.type === "opaque") return fetch(request);

  const blob = await blobForCachedResponse(request.url, hit);
  const range = parseSingleRange(request.headers.get("range"), blob.size);
  const headers = new Headers(hit.headers);
  headers.set("Accept-Ranges", "bytes");
  headers.delete("Content-Encoding");

  if (!range) {
    headers.set("Content-Range", `bytes */${blob.size}`);
    headers.set("Content-Length", "0");
    return new Response(null, { status: 416, headers });
  }

  const length = range.end - range.start + 1;
  headers.set("Content-Range", `bytes ${range.start}-${range.end}/${blob.size}`);
  headers.set("Content-Length", String(length));
  return new Response(blob.slice(range.start, range.end + 1), {
    status: 206,
    statusText: "Partial Content",
    headers,
  });
}

self.addEventListener("fetch", (e) => {
  const req = e.request;

  if (req.method === "HEAD") {
    e.respondWith(
      caches.match(req.url).then((hit) =>
        hit
          ? new Response(null, {
              status: hit.status,
              statusText: hit.statusText,
              headers: hit.headers,
            })
          : fetch(req)
      )
    );
    return;
  }

  if (req.method !== "GET") return;
  if (req.headers.has("range")) {
    e.respondWith(cachedRangeResponse(req));
    return;
  }

  if (isShell(req.url)) {
    // NETWORK-FIRST: get the freshest app shell, fall back to cache offline.
    e.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      }).catch(() => caches.match(req))
    );
    return;
  }

  // CACHE-FIRST for everything else (engine, BIOS, ISO).
  e.respondWith(
    caches.match(req).then((hit) =>
      hit || fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      }).catch(() => hit)
    )
  );
});

// Allow the page to tell us to activate a new SW immediately.
self.addEventListener("message", (e) => {
  if (e.data === "skipWaiting") self.skipWaiting();
});
