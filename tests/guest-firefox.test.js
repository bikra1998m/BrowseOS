"use strict";

const assert = require("assert");
const fs = require("fs");

const app = fs.readFileSync("public/app.js", "utf8");
const desktop = fs.readFileSync("public/desktop.js", "utf8");
const css = fs.readFileSync("public/desktop.css", "utf8");
const prebake = fs.readFileSync("prebake/build-repo.py", "utf8");
const make9p = fs.readFileSync("prebake/make-9p.py", "utf8");
const lock = JSON.parse(fs.readFileSync("prebake/packages.lock.json", "utf8"));

assert(desktop.includes('{ id:"firefox",   name:"Firefox", icon:"🦊" }'));
assert(desktop.includes('if (id === "firefox") return openFirefox()'));
assert(desktop.includes("window.__launchFirefox?.()"));
assert(desktop.includes("openTerminal();"));
assert(!desktop.includes("openFirefox();\n    },"));
assert(!desktop.includes("window.open("));
assert(css.includes(".guest-browser-screen"));
assert(css.includes("body.zoomed .guest-browser-screen #screen_container"));
assert(css.includes("transform:none"));

assert(app.includes("window.__launchFirefox = () =>"));
assert(app.includes("sh /mnt/tools/launch-firefox.sh"));
assert(app.includes("alpine9p: 1024"));

for (const packageName of [
  "alpine-base", "firefox-esr", "xorg-server", "xinit", "openbox",
  "xf86-video-vesa", "xf86-input-libinput", "font-dejavu", "dbus-x11",
]) {
  assert(prebake.includes(`"${packageName}"`));
  assert(lock.requested.includes(packageName));
}
assert(make9p.includes("LAUNCH_FIREFOX_SH"));
assert(make9p.includes("INSTALL_FIREFOX_SH"));
assert(make9p.includes('"firefox-apks"'));
assert(make9p.includes("browseros-firefox-session"));
assert(make9p.includes('Driver "modesetting"'));
assert(make9p.includes("modprobe bochs"));
assert(make9p.includes("modprobe psmouse"));
assert(make9p.includes('Option "AutoAddDevices" "false"'));
assert(make9p.includes('Option "Device" "/dev/input/event0"'));
assert(make9p.includes('Option "Device" "/dev/input/event1"'));
assert(make9p.includes("x-scheme-handler/http=firefox-esr.desktop"));
assert(make9p.includes("x-scheme-handler/https=firefox-esr.desktop"));
assert(make9p.includes("export BROWSER=firefox-esr"));
assert(make9p.includes("udhcpc -i eth0 -t 5 -n -q"));
assert(make9p.includes("exec startx"));
assert(make9p.includes("exec dbus-run-session -- firefox-esr"));

const root = lock.packages.map((entry) => entry.package);
assert(root.includes("firefox-esr"));
assert(root.includes("xorg-server"));

console.log("guest Firefox integration checks passed");
