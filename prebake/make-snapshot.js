#!/usr/bin/env node
/* Build a "pre-installed" Alpine state snapshot.
 *
 * Boots Alpine headlessly in Node (via v86), attaches the 9p tools fs, runs the
 * install script, then saves the machine state to
 *   ../public/images/alpine-preinstalled.bin
 *
 * BrowserOS then boots DIRECTLY into that state, so the OS comes up with bash,
 * git, python3, the apt shim, ll, etc. ALREADY installed — no setup after boot.
 *
 * Run on a machine with internet + the Alpine ISO present:
 *   cd prebake && node make-snapshot.js
 */
"use strict";
const fs = require("fs");
const path = require("path");

const HERE = __dirname;
const PUBLIC = path.join(HERE, "..", "public");
const VENDOR = path.join(PUBLIC, "vendor");
const IMAGES = path.join(PUBLIC, "images");
const ALPINE = path.join(IMAGES, "alpine.iso");
const ALPINE_KERNEL = path.join(IMAGES, "alpine-vmlinuz-virt");
const ALPINE_INITRAMFS = path.join(IMAGES, "alpine-initramfs-virt");
const TOOLS_BASE = path.join(IMAGES, "tools9p");
const TOOLS_JSON = path.join(IMAGES, "tools9p.json");
const OUT = path.join(IMAGES, "alpine-preinstalled.bin");
const OUT_META = path.join(IMAGES, "alpine-preinstalled.json");
const MACHINE = {
  format: 1,
  osMode: "alpine9p",
  osVersion: "3.24.1",
  memoryMB: 768,
  vgaMemoryMB: 8,
};

if (![ALPINE, ALPINE_KERNEL, ALPINE_INITRAMFS].every(fs.existsSync)) {
  console.error("ERROR: Alpine boot assets are missing. Run ./scripts/setup.sh --alpine first.");
  process.exit(1);
}
if (!fs.existsSync(TOOLS_JSON)) {
  console.error("ERROR: tools9p not found. Run: python make-9p.py");
  process.exit(1);
}

// v86's libv86.js is UMD: under Node it sets module.exports.V86.
// (Don't pre-set global.window or it takes the browser branch instead.)
let V86;
{
  const mod = require(path.join(HERE, "..", "public", "vendor", "libv86.js"));
  V86 = (mod && mod.V86) || global.V86 || global.V86Starter;
}
if (typeof V86 !== "function") {
  console.error("ERROR: could not load V86 constructor from libv86.js");
  process.exit(1);
}

console.log("Booting Alpine headlessly to pre-install tools...");
const emulator = new V86({
  bios:     { url: path.join(VENDOR, "seabios.bin") },
  vga_bios: { url: path.join(VENDOR, "vgabios.bin") },
  wasm_path: path.join(VENDOR, "v86.wasm"),
  memory_size: MACHINE.memoryMB * 1024 * 1024,
  vga_memory_size: MACHINE.vgaMemoryMB * 1024 * 1024,
  bzimage: { url: ALPINE_KERNEL },
  initrd: { url: ALPINE_INITRAMFS },
  cmdline: "modules=loop,squashfs,sd-mod,usb-storage,virtio_pci,virtio_net,9p,9pnet,9pnet_virtio quiet noautodetect console=ttyS0,115200",
  cdrom: { url: ALPINE },
  filesystem: { baseurl: TOOLS_BASE, basefs: { url: TOOLS_JSON } },
  net_device: { type: "virtio", relay_url: "wss://relay.widgetry.org/" },
  autostart: true,
  disable_speaker: true,
});

let serialBuf = "";
function send(line) { emulator.serial0_send(line + "\n"); }
function waitFor(re, timeoutMs) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error("timeout waiting for " + re)), timeoutMs);
    const check = () => { if (re.test(serialBuf)) { clearTimeout(t); res(); } };
    emulator.add_listener("serial0-output-byte", () => check());
    check();
  });
}

let gotAnySerial = false;
emulator.add_listener("serial0-output-byte", (b) => {
  gotAnySerial = true;
  const ch = String.fromCharCode(b);
  serialBuf += ch;
  process.stdout.write(ch); // mirror guest console to our stdout
});

// Diagnostic: if no serial output appears in 30s, the guest is likely logging
// to the VGA console (tty1), not serial — headless control won't work and we
// must use the in-browser Snapshots feature instead.
setTimeout(() => {
  if (!gotAnySerial) {
    console.error("\n\nWARNING: no serial output after 30s.");
    console.error("This Alpine ISO logs to the VGA console, not serial, so headless");
    console.error("snapshotting can't drive it. Use the in-browser method instead:");
    console.error("  Boot in the browser -> run Setup -> Desktop > Snapshots > Take snapshot,");
    console.error("  or top-bar Save. That captures the same pre-installed state reliably.");
  }
}, 30000);

(async () => {
  try {
    // Alpine on the -virt ISO uses serial console ttyS0 with v86.
    await waitFor(/login:/i, 180000);
    send("root");
    await waitFor(/\#\s*$/, 30000);

    // Mount the 9p tools and run the install (same as the desktop button).
    send("mkdir -p /mnt/tools");
    send("for m in 9p 9pnet 9pnet_virtio; do modprobe $m 2>/dev/null; done");
    send("mount -t 9p -o trans=virtio,version=9p2000.L host9p /mnt/tools 2>/dev/null || mount -t 9p -o trans=virtio host9p /mnt/tools");
    await waitFor(/\#\s*$/, 20000);
    send("sh /mnt/tools/install.sh");

    // Wait for the install to finish (the script prints this marker).
    await waitFor(/All packages installed|Ubuntu-like environment ready/, 600000);
    // Give the FS a moment to settle, then drop the exec'd bash back to a prompt.
    send("");
    await new Promise(r => setTimeout(r, 4000));

    console.log("\n\nSaving state snapshot...");
    const state = await emulator.save_state();
    fs.writeFileSync(OUT, Buffer.from(state));
    fs.writeFileSync(OUT_META, JSON.stringify(MACHINE, null, 2) + "\n");
    console.log("Wrote " + OUT + " (" + (state.byteLength / 1048576).toFixed(1) + " MB)");
    console.log("Wrote " + OUT_META + " (machine compatibility metadata)");
    emulator.stop();
    process.exit(0);
  } catch (e) {
    console.error("\nSnapshot build failed:", e.message);
    process.exit(1);
  }
})();
