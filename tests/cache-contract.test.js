"use strict";

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const vm = require("vm");

const manifestSource = fs.readFileSync("public/asset-manifest.js", "utf8");
const context = {};
context.globalThis = context;
vm.runInNewContext(manifestSource, context);
const assets = context.BROWSEROS_ASSETS;

assert(assets);
for (const key of [
  "libv86", "wasm", "bios", "vgaBios", "buildrootIso", "alpineIso",
  "alpineKernel", "alpineInitramfs", "tools9pJson",
]) {
  assert.match(assets[key], /\?v=[a-f0-9]{64}$/);
}
assert.equal(assets.alpineVersion, "3.24.1");
assert.equal(assets.tools9pBase, "images/tools9p");
assert.equal(assets.preinstalledState, null);
assert.equal(assets.preinstalledStateMeta, null);

const toolsHash = crypto
  .createHash("sha256")
  .update(fs.readFileSync("public/images/tools9p.json"))
  .digest("hex");
assert.equal(assets.tools9pJson, "images/tools9p.json?v=" + toolsHash);

const index = fs.readFileSync("public/index.html", "utf8");
assert(index.includes('<script src="asset-manifest.js"></script>'));
assert(index.includes('<script src="asset-loader.js"></script>'));
assert(!index.includes('<script src="vendor/libv86.js'));

const loader = fs.readFileSync("public/asset-loader.js", "utf8");
assert(loader.includes("script.src = assets.libv86"));
assert(loader.includes("window.BrowserOSEngineReady = new Promise"));
let appendedScript;
const loaderWindow = { BROWSEROS_ASSETS: assets };
const loaderContext = {
  window: loaderWindow,
  document: {
    createElement: () => ({}),
    head: { appendChild: (script) => { appendedScript = script; } },
  },
  Error,
  Promise,
};
vm.runInNewContext(loader, loaderContext);
assert.equal(appendedScript.src, assets.libv86);
assert.equal(appendedScript.async, true);
assert(loaderWindow.BrowserOSEngineReady instanceof Promise);

const app = fs.readFileSync("public/app.js", "utf8");
assert(app.includes("const ASSETS = window.BROWSEROS_ASSETS"));
assert(app.includes("await window.BrowserOSEngineReady"));
assert(app.includes("wasm: ASSETS.wasm"));
assert(app.includes("alpineIso: ASSETS.alpineIso"));
assert(app.includes("alpineKernel: ASSETS.alpineKernel"));
assert(app.includes("alpineInitramfs: ASSETS.alpineInitramfs"));
assert(app.includes("tools9pJson: ASSETS.tools9pJson"));
assert(!app.includes("opts.bzimage = { url: CFG.alpineKernel }"));
assert(!app.includes("opts.initrd = { url: CFG.alpineInitramfs }"));
assert(app.includes("opts.boot_order = 0x123"));
assert(app.includes("noautodetect"));
assert(!app.includes('alpineIso: "images/alpine.iso"'));

const sw = fs.readFileSync("public/sw.js", "utf8");
assert(sw.includes('importScripts("./asset-manifest.js")'));
assert(sw.includes('if (req.method === "HEAD")'));
assert(sw.includes("caches.match(req.url)"));
assert(sw.includes("cachedRangeResponse(req)"));
assert(sw.includes("parseSingleRange"));
assert(!sw.includes('if (req.headers.has("range")) return'));
assert(sw.includes("ASSETS.buildrootIso"));
assert(sw.includes('"./asset-loader.js"'));
assert(sw.includes("c.addAll([...SHELL, ...CORE_ASSETS])"));
assert(!sw.includes('"./images/linux.iso"'));

(async () => {
  const handlers = {};
  let networkFetches = 0;
  const swContext = {
    URL,
    Response,
    Headers,
    Blob,
    Promise,
    importScripts: () => {},
    fetch: async () => {
      networkFetches++;
      throw new Error("offline");
    },
    caches: {
      open: async () => ({ addAll: async () => {}, put: async () => {} }),
      keys: async () => [],
      delete: async () => true,
      match: async () => new Response("cached-image", {
        status: 200,
        headers: { "Content-Type": "application/octet-stream" },
      }),
    },
  };
  swContext.self = {
    BROWSEROS_ASSETS: assets,
    addEventListener: (type, handler) => { handlers[type] = handler; },
    skipWaiting: () => {},
    clients: { claim: async () => {} },
  };
  vm.runInNewContext(sw, swContext);

  let responsePromise;
  handlers.fetch({
    request: { method: "HEAD", url: "https://example.test/" + assets.alpineIso },
    respondWith: (promise) => { responsePromise = promise; },
  });
  const response = await responsePromise;
  assert.equal(response.status, 200);
  assert.equal(networkFetches, 0);
  assert.equal(await response.text(), "");

  const rangeRequest = (value) => ({
    method: "GET",
    url: "https://example.test/" + assets.alpineIso,
    headers: new Headers({ Range: value }),
  });
  handlers.fetch({
    request: rangeRequest("bytes=0-0"),
    respondWith: (promise) => { responsePromise = promise; },
  });
  const sizeProbe = await responsePromise;
  assert.equal(sizeProbe.status, 206);
  assert.equal(sizeProbe.headers.get("Content-Range"), "bytes 0-0/12");
  assert.equal(await sizeProbe.text(), "c");

  handlers.fetch({
    request: rangeRequest("bytes=2-5"),
    respondWith: (promise) => { responsePromise = promise; },
  });
  const partial = await responsePromise;
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get("Content-Range"), "bytes 2-5/12");
  assert.equal(partial.headers.get("Content-Length"), "4");
  assert.equal(partial.headers.get("Accept-Ranges"), "bytes");
  assert.equal(await partial.text(), "ched");
  assert.equal(networkFetches, 0);

  handlers.fetch({
    request: rangeRequest("bytes=-5"),
    respondWith: (promise) => { responsePromise = promise; },
  });
  const suffix = await responsePromise;
  assert.equal(suffix.status, 206);
  assert.equal(suffix.headers.get("Content-Range"), "bytes 7-11/12");
  assert.equal(await suffix.text(), "image");

  handlers.fetch({
    request: rangeRequest("bytes=7-"),
    respondWith: (promise) => { responsePromise = promise; },
  });
  const openEnded = await responsePromise;
  assert.equal(openEnded.status, 206);
  assert.equal(await openEnded.text(), "image");

  handlers.fetch({
    request: rangeRequest("bytes=99-100"),
    respondWith: (promise) => { responsePromise = promise; },
  });
  const unsatisfied = await responsePromise;
  assert.equal(unsatisfied.status, 416);
  assert.equal(unsatisfied.headers.get("Content-Range"), "bytes */12");
  assert.equal(await unsatisfied.text(), "");

  console.log("versioned asset cache checks passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
