/* Stable, URL-addressable BrowserOS VM identities. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.BrowserOSInstanceID = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  function normalize(value) {
    const clean = String(value || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^[-_]+|[-_]+$/g, "")
      .slice(0, 64);
    return clean || null;
  }

  function randomID(env) {
    const bytes = new Uint8Array(6);
    if (env.crypto && typeof env.crypto.getRandomValues === "function") {
      env.crypto.getRandomValues(bytes);
      return "vm-" + Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
    }
    return "vm-" + Math.random().toString(36).slice(2, 14);
  }

  function deriveMAC(id) {
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
    const b = [0x02, (h >> 24) & 0xfe, (h >> 16) & 0xff, (h >> 8) & 0xff, h & 0xff, (h >> 3) & 0xff];
    return b.map(x => x.toString(16).padStart(2, "0")).join(":");
  }

  function create(env) {
    const params = new URLSearchParams(env.location.search);
    let id = normalize(params.get("vm")) ||
      normalize(env.sessionStorage.getItem("browseros-vm")) ||
      randomID(env);

    env.sessionStorage.setItem("browseros-vm", id);
    if (params.get("vm") !== id) {
      params.set("vm", id);
      const query = params.toString();
      const next = env.location.pathname + (query ? "?" + query : "") + (env.location.hash || "");
      env.history.replaceState(null, "", next);
    }

    return Object.freeze({ id, mac: deriveMAC(id) });
  }

  return { normalize, deriveMAC, create };
});
