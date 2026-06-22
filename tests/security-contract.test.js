"use strict";

const assert = require("assert");
const fs = require("fs");
const policy = require("../public/url-policy.js");

const app = fs.readFileSync("public/app.js", "utf8");
const desktop = fs.readFileSync("public/desktop.js", "utf8");
const index = fs.readFileSync("public/index.html", "utf8");
const headers = fs.readFileSync("public/_headers", "utf8");
const server = fs.readFileSync("scripts/server.py", "utf8");
const launcher = fs.readFileSync("launcher/main.go", "utf8");

assert.equal(
  policy.externalLink("https://support.example/path", "https://browser.example/"),
  "https://support.example/path"
);
assert.equal(
  policy.externalLink("/help", "https://browser.example/app/"),
  "https://browser.example/help"
);
assert.equal(policy.externalLink("mailto:help@example.com"), "mailto:help@example.com");
assert.equal(policy.externalLink("javascript:alert(1)"), "");
assert.equal(policy.externalLink("data:text/html,<script>alert(1)</script>"), "");
assert.equal(policy.externalLink("  "), "");

assert(!app.includes("logo.innerHTML"));
assert(!app.includes("isoInfo.innerHTML"));
assert(!app.includes('row.innerHTML = `<input value="${'));
assert(app.includes("pfRules.replaceChildren()"));
assert(app.includes("isoInfo.textContent = msg"));
assert(app.includes("BrowserOSURLPolicy?.externalLink"));
assert(!desktop.includes("<code>${snapshotInstance}</code>"));
assert(desktop.includes('$("#snapshot-vm-id", body).textContent = snapshotInstance'));
assert(!desktop.includes("window.open("));

assert(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(index), "index.html contains inline script");
assert(index.includes('<script src="url-policy.js"></script>'));
assert(index.includes('<script src="asset-manifest.js"></script>'));
assert(index.includes('<script src="asset-loader.js"></script>'));
assert(index.includes('<script src="bootstrap.js"></script>'));

for (const source of [headers, server, launcher]) {
  assert(source.includes("Content-Security-Policy"));
  assert(source.includes("frame-ancestors 'none'"));
  assert(source.includes("X-Content-Type-Options"));
}

console.log("browser security rendering checks passed");
