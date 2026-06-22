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

  function preferredNATHost(id) {
    let h = 2166136261;
    for (let i = 0; i < id.length; i++) {
      h ^= id.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return 2 + (h % 253);
  }

  function validNATIP(value) {
    const match = /^192\.168\.86\.(\d{1,3})$/.exec(String(value || ""));
    if (!match) return false;
    const host = Number(match[1]);
    return host >= 2 && host <= 254;
  }

  // Keep a stable per-origin allocation table so even the rare case of two VM
  // IDs hashing to the same preferred host address is resolved consistently.
  function allocateNATIP(id, env) {
    const fallback = `192.168.86.${preferredNATHost(id)}`;
    const storage = env && env.localStorage;
    if (!storage || typeof storage.getItem !== "function" ||
        typeof storage.setItem !== "function") return fallback;

    const key = "browseros-nat-ip-map-v1";
    try {
      const parsed = JSON.parse(storage.getItem(key) || "{}");
      const map = parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed
        : {};
      if (validNATIP(map[id])) return map[id];

      const used = new Set(
        Object.entries(map)
          .filter(([owner, ip]) => owner !== id && validNATIP(ip))
          .map(([, ip]) => ip)
      );
      const preferred = preferredNATHost(id);
      for (let offset = 0; offset < 253; offset++) {
        const host = 2 + ((preferred - 2 + offset) % 253);
        const candidate = `192.168.86.${host}`;
        if (!used.has(candidate)) {
          map[id] = candidate;
          storage.setItem(key, JSON.stringify(map));
          return candidate;
        }
      }
    } catch (_) {
      // Storage can be unavailable in privacy modes; deterministic fallback is
      // still stable and collisions remain extremely unlikely.
    }
    return fallback;
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

    return Object.freeze({
      id,
      mac: deriveMAC(id),
      natIP: allocateNATIP(id, env),
    });
  }

  return { normalize, deriveMAC, allocateNATIP, create };
});
