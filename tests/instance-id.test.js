"use strict";

const assert = require("assert");
const { normalize, deriveMAC, create } = require("../public/instance-id.js");

assert.equal(normalize("  My VM / One  "), "my-vm-one");
assert.equal(normalize("***"), null);
assert.equal(normalize("a".repeat(100)).length, 64);
assert.equal(deriveMAC("demo"), deriveMAC("demo"));
assert.notEqual(deriveMAC("demo"), deriveMAC("other"));

const storage = new Map();
let replaced = "";
const env = {
  location: { search: "?mode=test", pathname: "/index.html", hash: "#console" },
  history: { replaceState(_a, _b, url) { replaced = url; } },
  sessionStorage: {
    getItem(k) { return storage.get(k) || null; },
    setItem(k, v) { storage.set(k, v); },
  },
  crypto: {
    getRandomValues(bytes) {
      bytes.set([1, 2, 3, 4, 5, 6]);
      return bytes;
    },
  },
};

const first = create(env);
assert.equal(first.id, "vm-010203040506");
assert.equal(storage.get("browseros-vm"), first.id);
assert.equal(replaced, "/index.html?mode=test&vm=vm-010203040506#console");

env.location.search = "?mode=test&vm=My%20Persistent%20VM";
const named = create(env);
assert.equal(named.id, "my-persistent-vm");
assert.equal(replaced, "/index.html?mode=test&vm=my-persistent-vm#console");

console.log("instance identity checks passed");
