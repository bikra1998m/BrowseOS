"use strict";

const assert = require("assert");
const fs = require("fs");

const app = fs.readFileSync("public/app.js", "utf8");
const desktop = fs.readFileSync("public/desktop.js", "utf8");

assert(app.includes("dbName: \"browseros-state-\" + Instance.id"));
assert(app.includes("machine.instanceId !== Instance.id"));
assert(app.includes("machine.osMode !== CFG.osMode"));
assert(app.includes("machine.memoryMB !== CFG.memMB"));
assert(app.includes("await Store.put(\"stateMachine\", machine)"));
assert(app.includes("BrowserOSSaveCoordinator.create"));
assert(app.includes("await Store.putMany"));
assert(app.includes("await stateSaver.idle()"));
assert(app.includes("window.__captureState = () => stateSaver.capture()"));
assert(!app.includes('setInterval(() => saveState(true)'));
assert(!app.includes('addEventListener("beforeunload"'));

assert(desktop.includes("dbName:\"browseros-snaps-\" + snapshotInstance"));
assert(desktop.includes("machine.instanceId === current.instanceId"));
assert(desktop.includes("await window.__restoreState?.(snap)"));
assert(desktop.includes("await window.__captureState()"));
assert(!desktop.includes('indexedDB.open("browseros-snaps",1)'));

console.log("persistence isolation contract checks passed");
