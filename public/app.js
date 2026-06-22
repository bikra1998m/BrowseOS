/* BrowserOS — v86 integration with IndexedDB persistence
 * --------------------------------------------------------
 * Boots Alpine Linux (real kernel, x86 emulated in WASM) and
 * auto-saves machine state to the browser so sessions persist.
 */
"use strict";

// ---- Apply branding (from branding.js) -------------------------------
const B = window.BRANDING || {};
const ASSETS = window.BROWSEROS_ASSETS;
if (!ASSETS) throw new Error("BrowserOS asset manifest is missing");
const PUBLIC_RELAY_URL = "wss://relay.widgetry.org/";
const CONFIGURED_RELAY_URL =
  localStorage.getItem("browseros-relay") ||
  B.relayUrl ||
  "";
const STORED_OS_MODE = localStorage.getItem("browseros-os") || "alpine9p";
const SUPPORTED_OS_MODES = new Set(["alpine9p", "iso", "custom"]);
const INITIAL_OS_MODE = SUPPORTED_OS_MODES.has(STORED_OS_MODE)
  ? STORED_OS_MODE
  : "alpine9p";
if (STORED_OS_MODE !== INITIAL_OS_MODE) {
  localStorage.setItem("browseros-os", INITIAL_OS_MODE);
}
const OS_DEFAULT_MEMORY_MB = {
  alpine9p: 1024,
  iso: 512,
  custom: 512,
};
const storedMemoryMB = parseInt(localStorage.getItem("browseros-mem") || "", 10);
(function applyBranding() {
  if (B.theme) {
    const r = document.documentElement.style;
    for (const k in B.theme) r.setProperty(k, B.theme[k]);
  }
  const set = (id, v) => { const e = document.getElementById(id); if (e && v != null) e.textContent = v; };
  if (B.productName) { document.title = B.productName + " — Linux in your browser"; }
  set("brandName", B.productName);
  set("brandTagline", B.tagline);
  set("brandCompany", B.companyName);
  if (B.logoSrc) {
    const logo = document.getElementById("brandLogo");
    if (logo) {
      logo.style.background = "none";
      logo.style.boxShadow = "none";
      const image = document.createElement("img");
      image.src = String(B.logoSrc);
      image.alt = "logo";
      image.style.cssText = "width:100%;height:100%;border-radius:7px;object-fit:cover";
      image.addEventListener("error", () => logo.classList.add("logo"));
      logo.replaceChildren(image);
    }
  }
  const sup = document.getElementById("brandSupport");
  const supportUrl = window.BrowserOSURLPolicy?.externalLink(B.supportUrl, location.href) || "";
  if (sup && supportUrl) {
    sup.href = supportUrl;
    sup.target = "_blank";
    sup.rel = "noopener noreferrer";
  } else if (sup) {
    sup.removeAttribute("href");
  }
})();

// ---- Per-VM instance isolation ---------------------------------------
// A generated ID is written into ?vm= so refreshes, restored browser tabs,
// bookmarks, and copied links all address the same IndexedDB-backed machine.
const Instance = window.BrowserOSInstanceID.create(window);
window.__browserOSInstance = Instance;
// Show the instance id in the title bar so users can tell tabs apart.
(function showInstance() {
  const small = document.querySelector(".brand small");
  if (small) small.textContent += "  ·  " + Instance.id;
})();

const CFG = {
  memory: 512 * 1024 * 1024,      // 512 MB RAM
  vgaMemory: 32 * 1024 * 1024,
  // Asset paths — bundled in /vendor and /images (see scripts/setup.sh)
  wasm: ASSETS.wasm,
  bios: ASSETS.bios,
  vgaBios: ASSETS.vgaBios,

  // Which OS to boot. "iso" = the bundled, offline 5.4MB Buildroot Linux
  // (real kernel + busybox, works out of the box). "alpine9p" = full Alpine
  // distro (apk package manager) loaded from images/ (run setup.sh --alpine).
  osMode: INITIAL_OS_MODE,

  // --- user-configurable settings (persisted) ---
  // VirtualBox-style network config (stored as JSON).
  net: (() => {
    const def = {
      enabled: true, attach: "nat", name: "", type: "virtio",
      promisc: "deny", mac: "", mtu: "", cable: true, portfwd: [],
    };
    try {
      const saved = JSON.parse(localStorage.getItem("browseros-netcfg"));
      if (saved && typeof saved === "object") return Object.assign(def, saved);
    } catch (_) {}
    return def;
  })(),
  memMB: Number.isFinite(storedMemoryMB)
    ? storedMemoryMB
    : (OS_DEFAULT_MEMORY_MB[INITIAL_OS_MODE] || 512),

  // --- iso mode (default, fully offline) ---
  cdrom: ASSETS.buildrootIso,

  // --- alpine mode (optional, richer distro) ---
  // We boot Alpine from its official ISO (downloaded by setup.sh --alpine).
  alpineIso: ASSETS.alpineIso,
  alpineKernel: ASSETS.alpineKernel,
  alpineInitramfs: ASSETS.alpineInitramfs,
  alpineVersion: ASSETS.alpineVersion,
  alpineMem: 1024 * 1024 * 1024,
  alpineCmdline:
    "modules=loop,squashfs,sd-mod,usb-storage,virtio_pci,virtio_net," +
    "9p,9pnet,9pnet_virtio ip=dhcp quiet noautodetect",
  // Pre-baked offline tools as a virtio-9p filesystem (bash, git, python3, …).
  tools9pBase: ASSETS.tools9pBase,
  tools9pJson: ASSETS.tools9pJson,
  // Pre-installed Alpine state snapshot (built by prebake/make-snapshot.js).
  // If present, Alpine boots straight into it with all tools already installed.
  preinstalledState: ASSETS.preinstalledState,
  preinstalledStateMeta: ASSETS.preinstalledStateMeta,
  // Explicit user/branding configuration wins. Otherwise boot() asks the
  // current server whether it is the standalone launcher with a built-in relay.
  relayUrl: CONFIGURED_RELAY_URL || PUBLIC_RELAY_URL,

  dbName: "browseros-state-" + Instance.id,   // per-VM storage (no collisions)
  autosaveMs: 5 * 60 * 1000,     // full VM snapshots are expensive: every 5 min
  lifecycleSaveMinMs: 2 * 60 * 1000,
};

let emulator = null;
let bootStart = 0;
let uptimeTimer = null;
let paused = false;
let bootLog = "";          // captured serial console output (for "Copy logs")
let consoleBuf = "";       // rolling console buffer (for "Copy out", survives boot)
let bootCancelled = false;
let activeMachineConfig = {
  memoryMB: CFG.memMB,
  vgaMemoryMB: CFG.vgaMemory / 1048576,
};

// ---- tiny DOM helpers -------------------------------------------------
const $ = (id) => document.getElementById(id);
const els = {
  start: $("btnStart"), stop: $("btnStop"), save: $("btnSave"), reset: $("btnReset"), full: $("btnFull"),
  crisp: $("btnCrisp"), sidebar: $("btnSidebar"),
  zoomIn: $("zoomIn"), zoomOut: $("zoomOut"), zoomFit: $("zoomFit"), zoomLabel: $("zoomLabel"),
  ubuntu: $("btnUbuntuSetup"),
  paste: $("btnPaste"), copyOut: $("btnCopyOut"), focushint: $("focushint"),
  cad: $("btnCtrlAltDel"), pause: $("btnPause"), dl: $("btnDownState"),
  dot: $("statusDot"), statusText: $("statusText"),
  overlay: $("overlay"), ovTitle: $("ovTitle"), ovText: $("ovText"),
  ovBarWrap: $("ovBarWrap"), ovBar: $("ovBar"), ovHint: $("ovHint"),
  ovActions: $("ovActions"), copyLogs: $("btnCopyLogs"), cancelBoot: $("btnCancelBoot"),
  toggleLogs: $("btnToggleLogs"), ovLog: $("ovLog"), ovLogSearch: $("ovLogSearch"),
  ovChips: $("ovChips"),
  sStatus: $("sStatus"), sUptime: $("sUptime"), sMem: $("sMem"),
  screen: $("screen_container"), toast: $("toast"),
};
els.sMem.textContent = (CFG.memMB || 512) + " MB";

function setStatus(text, kind) {
  els.statusText.textContent = text;
  els.dot.className = "dot" + (kind ? " " + kind : "");
}
function toast(msg, ms = 2600) {
  els.toast.textContent = msg;
  els.toast.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => els.toast.classList.remove("show"), ms);
}
function fmtUptime(ms) {
  const s = Math.floor(ms / 1000);
  const h = String(Math.floor(s / 3600)).padStart(2, "0");
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${h}:${m}:${ss}`;
}

// ---- IndexedDB persistence -------------------------------------------
const Store = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open(CFG.dbName, 1);
      r.onupgradeneeded = () => r.result.createObjectStore("kv");
      r.onsuccess = () => { this.db = r.result; res(this.db); };
      r.onerror = () => rej(r.error);
    });
  },
  async put(key, val) {
    if (!this.db) await this.open();
    return new Promise((res, rej) => {
      const tx = this.db.transaction("kv", "readwrite");
      tx.objectStore("kv").put(val, key);
      tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    });
  },
  async putMany(values) {
    if (!this.db) await this.open();
    return new Promise((res, rej) => {
      const tx = this.db.transaction("kv", "readwrite");
      const store = tx.objectStore("kv");
      for (const [key, value] of Object.entries(values)) store.put(value, key);
      tx.oncomplete = res;
      tx.onerror = () => rej(tx.error);
      tx.onabort = () => rej(tx.error || new Error("State save transaction aborted"));
    });
  },
  async get(key) {
    if (!this.db) await this.open();
    return new Promise((res, rej) => {
      const tx = this.db.transaction("kv", "readonly");
      const g = tx.objectStore("kv").get(key);
      g.onsuccess = () => res(g.result); g.onerror = () => rej(g.error);
    });
  },
  async del(key) {
    if (!this.db) await this.open();
    return new Promise((res, rej) => {
      const tx = this.db.transaction("kv", "readwrite");
      tx.objectStore("kv").delete(key);
      tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    });
  },
  async delMany(keys) {
    if (!this.db) await this.open();
    return new Promise((res, rej) => {
      const tx = this.db.transaction("kv", "readwrite");
      const store = tx.objectStore("kv");
      keys.forEach((key) => store.delete(key));
      tx.oncomplete = res;
      tx.onerror = () => rej(tx.error);
      tx.onabort = () => rej(tx.error || new Error("State reset transaction aborted"));
    });
  },
};

const stateSaver = window.BrowserOSSaveCoordinator.create({
  intervalMs: CFG.autosaveMs,
  lifecycleMinAgeMs: CFG.lifecycleSaveMinMs,
  canAutosave: () => !!emulator,
  capture: async () => {
    const emu = emulator;
    if (!emu) throw new Error("Nothing running");
    const state = await emu.save_state();
    if (emulator !== emu) throw new Error("Machine changed while saving");
    return state;
  },
  persist: async (state) => {
    const savedAt = Date.now();
    await Store.putMany({
      state,
      savedAt,
      stateOS: CFG.osMode,
      stateMachine: {
        format: 1,
        instanceId: Instance.id,
        osMode: CFG.osMode,
        osVersion: CFG.osMode === "alpine9p" ? CFG.alpineVersion : null,
        memoryMB: activeMachineConfig.memoryMB,
        vgaMemoryMB: activeMachineConfig.vgaMemoryMB,
      },
    });
  },
  onSaveStart: () => {
    els.save.disabled = true;
    els.save.title = "Saving machine state…";
  },
  onSaveEnd: () => {
    els.save.disabled = !emulator;
    els.save.title = "Save current machine state to your browser (auto-save runs every 5 minutes)";
  },
  onSaveError: (reason, error) => {
    if (reason !== "manual") console.warn("[BrowserOS] Background save failed:", error);
  },
});

async function clearSavedState() {
  stateSaver.stop();
  els.save.disabled = true;
  try { await stateSaver.idle(); } catch (_) {}
  await Store.delMany(["state", "savedAt", "stateOS", "stateMachine"]);
  els.save.disabled = true;
}

// ---- Boot flow --------------------------------------------------------
async function boot() {
  if (emulator) { toast("Already running"); return; }

  try {
    await window.BrowserOSEngineReady;
  } catch (error) {
    console.error("[BrowserOS] Engine load failed:", error);
  }
  if (typeof V86 === "undefined" && typeof V86Starter === "undefined") {
    setStatus("Engine missing", "err");
    els.ovTitle.textContent = "Engine not installed";
    els.ovText.innerHTML = "v86 wasn't found. Run <code>./scripts/setup.sh</code> first to download the engine and Alpine image, then reload.";
    return;
  }

  els.start.disabled = true;
  setStatus("Booting…", "busy");
  els.sStatus.textContent = "Booting";
  els.ovTitle.textContent = "Starting machine…";

  // Auto-fallback: if the selected OS image isn't downloaded, use Buildroot
  // (which is always bundled) so first boot never dead-ends on a 404.
  if (CFG.osMode === "alpine9p") {
    const assetsPresent = await Promise.all([
      CFG.alpineIso,
      CFG.alpineKernel,
      CFG.alpineInitramfs,
    ].map(imageExists));
    if (assetsPresent.some((present) => !present)) {
      const wanted = osNames[CFG.osMode];
      CFG.osMode = "iso";
      if (osSelect) osSelect.value = "iso";
      $("sOS").textContent = osNames.iso;
      toast(wanted + " image not found — run ./scripts/setup.sh --alpine. Using Buildroot for now.");
    }
  }

  const isAlpine = (CFG.osMode === "alpine9p");
  if (isAlpine) {
    els.ovText.textContent = "Loading Alpine Linux 3.24.1 (~49 MB). First boot can take 1–3 minutes.";
  } else {
    els.ovText.textContent = "Loading the kernel and emulator. The first boot can take a little while.";
  }
  els.ovBarWrap.style.display = "block";
  bootLog = ""; bootCancelled = false;
  logFilter = ""; els.ovLogSearch.value = "";
  els.ovChips.querySelectorAll(".chip").forEach((c) => c.classList.remove("active"));
  els.ovActions.classList.add("show");          // reveal Show/Copy/Cancel
  // Show the live boot log automatically (so you watch the kernel come up).
  // Set BRANDING.autoShowLogs = false to keep it collapsed by default.
  if (B.autoShowLogs !== false) setLogsVisible(true);
  startBootClock(false);
  progress(8);

  // A v86 state is tied to its machine configuration. Restore only when its OS
  // and RAM match; VGA RAM is restored from the state metadata below.
  let saved = await Store.get("state").catch(() => null);
  const savedOS = await Store.get("stateOS").catch(() => null);
  const savedMachine = await Store.get("stateMachine").catch(() => null);
  if (saved && (
      savedOS !== CFG.osMode ||
      !savedMachine ||
      savedMachine.format !== 1 ||
      (savedMachine.instanceId && savedMachine.instanceId !== Instance.id) ||
      savedMachine.osMode !== CFG.osMode ||
      (CFG.osMode === "alpine9p" && savedMachine.osVersion !== CFG.alpineVersion) ||
      savedMachine.memoryMB !== CFG.memMB ||
      !Number.isFinite(savedMachine.vgaMemoryMB)
  )) {
    saved = null;
    toast("Saved session configuration differs from this machine — booting fresh.");
  }

  let bundledSnapshot = null;
  if (!saved &&
      CFG.osMode === "alpine9p" &&
      CFG.preinstalledState &&
      CFG.preinstalledStateMeta &&
      sessionStorage.getItem("browseros-skip-snapshot") !== "1" &&
      await imageExists(CFG.preinstalledState)) {
    const meta = await loadJson(CFG.preinstalledStateMeta);
    if (meta &&
        meta.format === 1 &&
        meta.osMode === CFG.osMode &&
        meta.osVersion === CFG.alpineVersion &&
        meta.memoryMB === CFG.memMB &&
        Number.isFinite(meta.vgaMemoryMB)) {
      bundledSnapshot = meta;
    } else if (meta) {
      toast("Pre-installed snapshot needs " + meta.memoryMB +
            " MB RAM; booting Alpine fresh with " + CFG.memMB + " MB.");
    }
  }

  const restoreMachine = saved ? savedMachine : bundledSnapshot;
  const V86Ctor = (typeof V86 !== "undefined") ? V86 : V86Starter;
  const opts = {
    wasm_path: CFG.wasm,
    memory_size: CFG.memMB * 1024 * 1024,
    vga_memory_size: (restoreMachine
      ? restoreMachine.vgaMemoryMB * 1024 * 1024
      : CFG.vgaMemory),
    screen_container: els.screen,
    bios: { url: CFG.bios },
    vga_bios: { url: CFG.vgaBios },
    autostart: true,
    disable_speaker: true,
  };
  if (CFG.osMode === "custom") {
    // Boot a user-uploaded ISO/IMG (stored in IndexedDB by the upload control).
    const blob = await Store.get("customIso").catch(() => null);
    if (!blob) {
      setStatus("No ISO", "err"); els.start.disabled = false;
      els.ovTitle.textContent = "No custom ISO";
      els.ovText.innerHTML = "Upload a bootable ISO/IMG first (Operating system → Custom ISO).";
      return;
    }
    const buf = blob instanceof ArrayBuffer ? blob : await blob.arrayBuffer();
    opts.cdrom = { buffer: new Uint8Array(buf) };
    opts.boot_order = 0x123;
  } else if (CFG.osMode === "alpine9p") {
    // Boot through BrowserOS's deterministically patched ISOLINUX config. This
    // preserves the VGA BIOS state Xorg needs while still disabling Alpine's
    // v86-incompatible generic hardware scan.
    opts.cdrom = { url: CFG.alpineIso };
    opts.boot_order = 0x123;
    if (CFG.tools9pBase && CFG.tools9pJson) {
      opts.filesystem = { baseurl: CFG.tools9pBase, basefs: CFG.tools9pJson };
    }
  } else {
    // Default: boot the bundled, fully-offline Buildroot Linux ISO.
    opts.cdrom = { url: CFG.cdrom };
    opts.boot_order = 0x123; // CD-ROM first
  }

  // ----- Apply user Resources (memory) -----
  opts.memory_size = (CFG.memMB || 512) * 1024 * 1024;
  activeMachineConfig = {
    memoryMB: CFG.memMB || 512,
    vgaMemoryMB: opts.vga_memory_size / 1048576,
  };

  // ----- Apply user Network config (VirtualBox-style → v86 reality) -----
  await applyNetwork(opts);
  if (saved) {
    opts.initial_state = { buffer: saved };
    els.ovText.textContent = "Restoring your saved session…";
    progress(40);
  } else if (bundledSnapshot) {
    // Boot DIRECTLY into the pre-installed snapshot: tools already set up,
    // no install step after login. Its exact machine config came from metadata.
    opts.initial_state = { url: CFG.preinstalledState };
    els.ovText.textContent = "Loading pre-installed Alpine (tools ready)…";
    progress(35);
  }

  try {
    emulator = new V86Ctor(opts);
  } catch (e) {
    setStatus("Boot failed", "err");
    els.start.disabled = false;
    els.ovText.textContent = "Failed to start: " + e.message;
    return;
  }

  // Capture the Linux serial console so users can see / copy boot logs.
  emulator.add_listener("serial0-output-byte", (byte) => {
    const ch = String.fromCharCode(byte);
    if (ch === "\r") return;
    bootLog += ch;
    if (bootLog.length > 200000) bootLog = bootLog.slice(-200000); // cap memory
    consoleBuf += ch;                                              // for "Copy out"
    if (consoleBuf.length > 200000) consoleBuf = consoleBuf.slice(-200000);
    renderLog();
  });

  emulator.add_listener("download-progress", (e) => {
    if (!e || !e.total) { setBootPhase("Downloading OS image…"); return; }
    const pct = e.loaded / e.total;
    progress(8 + Math.floor(pct * 80)); // most of the bar is the download
    const mb = (n) => (n / 1048576).toFixed(1) + " MB";
    setBootPhase("Downloading OS image — " + mb(e.loaded) + " / " + mb(e.total) +
                 " (" + Math.floor(pct * 100) + "%)");
  });
  emulator.add_listener("emulator-loaded", () => {
    progress(92);
    setBootPhase("Image loaded — starting the Linux kernel…");
  });

  emulator.add_listener("emulator-started", () => {
    progress(100);
    setBootPhase("Booting Linux… (this can take a moment)");
    onRunning();
    // When restoring from a saved state/snapshot, v86 may NOT fire
    // "screen-set-mode" (the screen is already in its final mode), so the
    // overlay would never hide. Force-hide it shortly after start.
    const restoring = !!opts.initial_state;
    setTimeout(() => hideOverlay(), restoring ? 1500 : 800);
  });

  // Fallback: hide overlay once screen shows output even if events differ
  emulator.add_listener("screen-set-mode", () => {
    hideOverlay();
    if (!bootStart) onRunning();
  });
  // Extra fallback: any serial/console output means it's alive → hide overlay.
  emulator.add_listener("serial0-output-byte", () => {
    if (!els.overlay.classList.contains("hidden")) {
      clearTimeout(hideOnOutput);
      hideOnOutput = setTimeout(() => { hideOverlay(); if (!bootStart) onRunning(); }, 1200);
    }
  });
  // VGA text output (TinyCore and many ISOs boot to the VGA console, not
  // serial) → also means it's alive → reveal the screen.
  emulator.add_listener("screen-put-char", () => {
    if (!els.overlay.classList.contains("hidden")) {
      clearTimeout(hideOnOutput);
      hideOnOutput = setTimeout(() => { hideOverlay(); if (!bootStart) onRunning(); }, 800);
    }
  });
  // Hard fallback: never get stuck on the overlay. After a generous wait,
  // reveal the screen no matter what (the VM is almost certainly running).
  clearTimeout(hideHardFallback);
  hideHardFallback = setTimeout(() => {
    if (!els.overlay.classList.contains("hidden")) { hideOverlay(); if (!bootStart) onRunning(); }
  }, 12000);

  // Boot watchdog: if a saved-state restore hangs (incompatible state), the
  // engine starts but never produces screen output. Detect that and offer to
  // clear the bad state so the user isn't stuck forever at "Starting machine…".
  if (opts.initial_state) {
    const fromSnapshot = !saved; // came from the bundled pre-installed .bin
    clearTimeout(bootWatchdog);
    bootWatchdog = setTimeout(async () => {
      if (bootStart) return;            // booted fine — nothing to do
      setBootPhase("Restore looks stuck — it may be incompatible.");
      if (fromSnapshot) {
        els.ovText.innerHTML =
          "The pre-installed snapshot didn't resume (often a memory/config " +
          "mismatch). Click OK to boot Alpine <b>fresh</b> instead.";
        if (confirm("Pre-installed snapshot seems stuck.\n\nBoot Alpine fresh (skip the snapshot) now?")) {
          sessionStorage.setItem("browseros-skip-snapshot", "1");
          location.reload();
        }
      } else {
        els.ovText.innerHTML =
          "Your saved session didn't resume. Click <b>Reset</b> to clear it and boot fresh.";
        if (confirm("The saved session seems stuck / incompatible.\n\nClear it and boot fresh now?")) {
          await clearSavedState();
          location.reload();
        }
      }
    }, 20000);                          // 20s with no screen output = stuck
  }
}

let bootWatchdog = null;
let hideOnOutput = null;
let hideHardFallback = null;

function hideOverlay() {
  stopBootClock();
  els.ovActions.classList.remove("show");
  els.ovLog.classList.remove("show");
  els.ovLogSearch.classList.remove("show");
  els.ovChips.classList.remove("show");
  if (els.toggleLogs) els.toggleLogs.textContent = "Show logs ▾";
  els.overlay.classList.add("hidden");
}

// Live boot-log viewer (only repaints when it's visible). Auto-scrolls
// to the newest line unless the user has scrolled up to read history.
// When a filter is set, shows only matching lines with the term highlighted.
let logRaf = 0;
let logFilter = "";
function escHtml(s) {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}
function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
// Classify a log line by severity for auto red/yellow coloring.
const ERR_RE = /\b(error|fail(ed|ure)?|panic|fatal|cannot|unable|segfault|denied|critical)\b/i;
const WARN_RE = /\b(warn(ing)?|deprecat|timeout|retry|missing|skipp?ed)\b/i;
function sevClass(line) {
  if (ERR_RE.test(line)) return "l-err";
  if (WARN_RE.test(line)) return "l-warn";
  return "";
}
// Render one line: escape, apply severity color, then highlight filter hits.
function fmtLine(line, re) {
  let html = escHtml(line);
  if (re) html = html.replace(re, "<mark>$1</mark>");
  const cls = sevClass(line);
  return cls ? '<span class="' + cls + '">' + html + "</span>" : html;
}
function renderLog() {
  if (!els.ovLog.classList.contains("show")) return;
  if (logRaf) return;                       // throttle to one paint per frame
  logRaf = requestAnimationFrame(() => {
    logRaf = 0;
    const el = els.ovLog;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    if (!bootLog) {
      el.textContent = "(waiting for kernel output…)";
    } else if (!logFilter) {
      // No filter: show everything, auto-colored by severity.
      el.innerHTML = bootLog.split("\n").map((l) => fmtLine(l, null)).join("\n");
    } else {
      const needle = logFilter.toLowerCase();
      const lines = bootLog.split("\n").filter((l) => l.toLowerCase().includes(needle));
      if (!lines.length) {
        el.innerHTML = '<span style="color:#5e6a82">(no lines match “' +
          escHtml(logFilter) + '”)</span>';
      } else {
        const re = new RegExp("(" + escRe(logFilter) + ")", "ig");
        el.innerHTML = lines.map((l) => fmtLine(l, re)).join("\n") +
          '\n<span style="color:#5e6a82">— ' + lines.length + " matching line(s) —</span>";
      }
    }
    if (atBottom && !logFilter) el.scrollTop = el.scrollHeight;
  });
}

// A small line under the progress bar showing the current phase.
function setBootPhase(text) {
  let p = document.getElementById("ovPhase");
  if (!p) {
    p = document.createElement("div");
    p.id = "ovPhase";
    p.className = "hint";
    p.style.cssText = "margin-top:2px;color:#9fb0cc;font-variant-numeric:tabular-nums";
    els.ovHint.parentNode.insertBefore(p, els.ovHint);
  }
  p.textContent = text;
}

// "Elapsed: 00:42" ticker so a long download never looks frozen.
let bootClock = null, bootClockStart = 0;
function startBootClock(heavy) {
  bootClockStart = Date.now();
  stopBootClock();
  const tick = () => {
    const s = Math.floor((Date.now() - bootClockStart) / 1000);
    const mm = String(Math.floor(s / 60)).padStart(2, "0");
    const ss = String(s % 60).padStart(2, "0");
    els.ovHint.innerHTML = "⏱ Elapsed: <b>" + mm + ":" + ss + "</b>" +
      (heavy ? " — large image, please keep this tab open" : "");
  };
  tick();
  bootClock = setInterval(tick, 1000);
}
function stopBootClock() { if (bootClock) { clearInterval(bootClock); bootClock = null; } }

function progress(pct) { els.ovBar.style.width = Math.min(100, pct) + "%"; }

function websocketUrl(path) {
  const u = new URL(path, location.href);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  return u.href;
}

// Static/Python hosting serves checked-in null capabilities. The standalone
// launcher overrides this document to advertise its same-origin WISP internet
// proxy and its separate multi-VM Ethernet relay.
let capabilityResolution = null;
async function resolveLauncherCapabilities() {
  if (!location.protocol.startsWith("http")) return {};
  if (capabilityResolution) return capabilityResolution;
  capabilityResolution = (async () => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 1500);
    try {
      const r = await fetch("browseros-capabilities.json", {
        cache: "no-store",
        signal: ctl.signal,
      });
      if (!r.ok) return {};
      const capabilities = await r.json();
      return capabilities && typeof capabilities === "object" ? capabilities : {};
    } catch (_) {
      return {};
    } finally {
      clearTimeout(timer);
    }
  })();
  return capabilityResolution;
}

function wispUrl(path) {
  return websocketUrl(path).replace(/^ws:/, "wisp:").replace(/^wss:/, "wisps:");
}

let internetResolution = null;
async function resolveDefaultInternetUrl() {
  if (CONFIGURED_RELAY_URL) return CONFIGURED_RELAY_URL;
  if (internetResolution) return internetResolution;
  internetResolution = (async () => {
    const capabilities = await resolveLauncherCapabilities();
    if (typeof capabilities.wisp === "string" && capabilities.wisp) {
      return wispUrl(capabilities.wisp);
    }
    return PUBLIC_RELAY_URL;
  })();
  const resolved = await internetResolution;
  CFG.relayUrl = resolved;
  return resolved;
}

let relayResolution = null;
async function resolveDefaultRelayUrl() {
  if (CONFIGURED_RELAY_URL) return CONFIGURED_RELAY_URL;
  if (relayResolution) return relayResolution;
  relayResolution = (async () => {
    const capabilities = await resolveLauncherCapabilities();
    if (typeof capabilities.relay === "string" && capabilities.relay) {
      return websocketUrl(capabilities.relay);
    }
    return PUBLIC_RELAY_URL;
  })();
  return relayResolution;
}


// Returns true if an OS image is actually present (HEAD; falls back to a
// tiny ranged GET for servers that don't answer HEAD). Used for auto-fallback.
async function imageExists(url) {
  try {
    const r = await fetch(url, { method: "HEAD" });
    if (r.ok) return true;
    if (r.status === 405 || r.status === 501) {
      const g = await fetch(url, { headers: { Range: "bytes=0-0" } });
      return g.ok;
    }
    return false;
  } catch (_) {
    return false;
  }
}

async function loadJson(url) {
  try {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) return null;
    return await r.json();
  } catch (_) {
    return null;
  }
}

function onRunning() {
  if (bootStart) return;
  clearTimeout(bootWatchdog);
  clearTimeout(hideOnOutput);
  clearTimeout(hideHardFallback);
  sessionStorage.removeItem("browseros-skip-snapshot"); // booted OK, clear fallback flag
  bootStart = Date.now();
  setStatus("Running", "on");
  els.sStatus.textContent = "Running";
  els.save.disabled = false;
  els.start.disabled = true;
  els.stop.disabled = false;
  toast("Linux is booting — login as root");

  uptimeTimer = setInterval(() => {
    $("sUptime").textContent = fmtUptime(Date.now() - bootStart);
  }, 1000);

  // Full state capture is serialized and conservatively scheduled.
  stateSaver.start();
  const cv = els.screen.querySelector("canvas");
  cv?.focus?.();
  document.querySelector(".crt")?.classList.add("focused");
  // Show the "click to type" hint briefly so users know to focus the console.
  if (els.focushint) {
    els.focushint.style.display = "block";
    setTimeout(() => { if (els.focushint) els.focushint.style.display = "none"; }, 12000);
  }
}

// ---- Save / restore / reset ------------------------------------------
async function saveState(silent) {
  if (!emulator) { if (!silent) toast("Nothing running"); return; }
  try {
    // Concurrent callers share the same expensive capture and persistence work.
    await stateSaver.save(silent ? "auto" : "manual");
    if (!silent) toast("Session saved to this browser");
  } catch (e) {
    if (!silent) toast("Save failed: " + e.message);
  }
}

async function resetAll() {
  const ok = confirm("Wipe the saved machine state and start completely fresh? This cannot be undone.");
  if (!ok) return;
  await clearSavedState();
  toast("Saved state cleared — reloading");
  setTimeout(() => location.reload(), 700);
}

async function exportState() {
  if (!emulator) { toast("Nothing running"); return; }
  const state = await stateSaver.capture();
  const blob = new Blob([state], { type: "application/octet-stream" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "browseros-state.bin";
  a.click();
  URL.revokeObjectURL(a.href);
  toast("State exported");
}

// ---- OS selector ------------------------------------------------------
const osSelect = $("osSelect");
const osNames = { iso: "Buildroot Linux", alpine9p: "Alpine Linux", custom: "Custom ISO" };
if (osSelect) {
  osSelect.value = CFG.osMode;
  $("sOS").textContent = osNames[CFG.osMode] || "Linux";
  osSelect.onchange = async () => {
    const v = osSelect.value;
    if (v === "custom") {
      // Don't reload — let the user pick a file first (handled by configControls).
      $("sOS").textContent = osNames.custom;
      return;
    }
    if (v === "alpine9p") {
      toast("Alpine selected — run ./scripts/setup.sh --alpine to fetch it");
    }
    localStorage.setItem("browseros-os", v);
    $("sOS").textContent = osNames[v] || "Linux";
    // Clear saved state since it belongs to the previous OS.
    await clearSavedState();
    setTimeout(() => location.reload(), 600);
  };
}

// ---- Boot overlay actions: toggle / search / copy logs / cancel boot --
function setLogsVisible(show) {
  els.ovLog.classList.toggle("show", show);
  els.ovLogSearch.classList.toggle("show", show);
  els.ovChips.classList.toggle("show", show);
  els.toggleLogs.textContent = show ? "Hide logs ▴" : "Show logs ▾";
  if (show) renderLog();
}
els.toggleLogs.onclick = () => setLogsVisible(!els.ovLog.classList.contains("show"));

// Apply a filter term from anywhere (chips or typing) and sync the UI.
function applyLogFilter(term) {
  logFilter = (term || "").trim();
  els.ovLogSearch.value = logFilter;
  els.ovChips.querySelectorAll(".chip").forEach((c) => {
    c.classList.toggle("active", !!logFilter && c.dataset.term.toLowerCase() === logFilter.toLowerCase());
  });
  logRaf = 0;            // force an immediate repaint with the new filter
  renderLog();
}
els.ovLogSearch.oninput = () => applyLogFilter(els.ovLogSearch.value);
els.ovChips.querySelectorAll(".chip").forEach((chip) => {
  chip.onclick = () => {
    // Clicking an already-active chip toggles it off.
    const t = chip.dataset.term;
    applyLogFilter(t && t.toLowerCase() === logFilter.toLowerCase() ? "" : t);
  };
});

els.copyLogs.onclick = async () => {
  const text = bootLog.trim() ||
    "(no console output captured yet — the kernel may not have started printing)";
  try {
    await navigator.clipboard.writeText(text);
    toast("Boot logs copied to clipboard");
  } catch (_) {
    // Fallback: download as a file if clipboard is blocked.
    const blob = new Blob([text], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "browseros-boot.log";
    a.click(); URL.revokeObjectURL(a.href);
    toast("Clipboard blocked — saved boot logs to a file");
  }
};

els.cancelBoot.onclick = () => {
  if (!emulator) return;
  bootCancelled = true;
  try { emulator.stop?.(); emulator.destroy?.(); } catch (_) {}
  emulator = null;
  bootStart = 0;
  stopBootClock();
  if (uptimeTimer) { clearInterval(uptimeTimer); uptimeTimer = null; }
  stateSaver.stop();
  progress(0);
  els.ovActions.classList.remove("show");
  els.ovLog.classList.remove("show");
  els.ovLogSearch.classList.remove("show");
  els.ovChips.classList.remove("show");
  els.toggleLogs.textContent = "Show logs ▾";
  els.ovBarWrap.style.display = "none";
  els.ovTitle.textContent = "Boot cancelled";
  els.ovText.textContent = "The machine was stopped. Press Boot to try again.";
  els.ovHint.textContent = "Tip: Show logs can help diagnose a slow or failed boot.";
  const p = document.getElementById("ovPhase"); if (p) p.textContent = "";
  setStatus("Idle", "");
  els.sStatus.textContent = "Powered off";
  els.start.disabled = false;
  els.save.disabled = true;
  toast("Boot cancelled");
};

// Esc cancels boot — only while the boot overlay is up (so it never
// interferes with the running VM, which gets the key once booted).
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  const booting = emulator && !els.overlay.classList.contains("hidden");
  if (booting) { e.preventDefault(); els.cancelBoot.onclick(); }
});

// ---- Controls ---------------------------------------------------------
els.start.onclick = boot;
els.save.onclick = () => saveState(false);
els.reset.onclick = resetAll;

// Power off the machine (keeps your config; press Boot to start again).
function powerOff() {
  if (!emulator) { toast("Nothing running"); return; }
  try { emulator.stop?.(); emulator.destroy?.(); } catch (_) {}
  emulator = null; bootStart = 0; paused = false;
  if (uptimeTimer) { clearInterval(uptimeTimer); uptimeTimer = null; }
  stateSaver.stop();
  if (typeof bootWatchdog !== "undefined") clearTimeout(bootWatchdog);
  try { stopBootClock(); } catch (_) {}      // stop the elapsed timer
  setStatus("Powered off", "");
  els.sStatus.textContent = "Powered off";
  $("sUptime").textContent = "—";
  els.start.disabled = false;
  els.stop.disabled = true;
  els.save.disabled = true;
  // Reset the overlay completely (clear stale phase text + progress + actions).
  progress(0);
  els.ovBarWrap.style.display = "none";
  els.ovActions.classList.remove("show");
  els.ovLog && els.ovLog.classList.remove("show");
  els.ovLogSearch && els.ovLogSearch.classList.remove("show");
  els.ovChips && els.ovChips.classList.remove("show");
  const ph = document.getElementById("ovPhase"); if (ph) ph.textContent = "";
  els.ovHint && (els.ovHint.textContent = "");
  els.overlay.classList.remove("hidden");
  els.ovTitle.textContent = "Powered off";
  els.ovText.textContent = "The machine is stopped. Press Boot to start it again.";
  toast("Machine powered off");
}
els.stop.onclick = () => { if (confirm("Power off the machine now?")) powerOff(); };

// ----- Config controls: OS / Network / Memory / Custom ISO upload -----
// Translate the VirtualBox-style net config into what v86 can actually do.
// Honest mapping:
//   NAT          -> WISP TCP proxy (cross-platform internet, including HTTPS)
//   NAT Network  -> raw Ethernet relay (VM-to-VM; internet only if that relay
//                   also provides NAT)
//   Bridged / Host-only/ Internal -> best-effort approximations; real host
//                                     bridging isn't possible in-browser
//   Not Attached / disabled / cable off -> no NIC (offline)
async function applyNetwork(opts) {
  const n = CFG.net || {};
  if (!n.enabled || n.attach === "notattached" || n.cable === false) return; // offline
  const dev = { type: n.type === "ne2k" ? "ne2k" : "virtio" };
  if (n.mtu) dev.mtu = parseInt(n.mtu, 10) || undefined;
  // v86 currently exposes only net0 to the emulated NIC. Its `id` setting is
  // a network namespace/channel id, not a MAC seed; using a per-tab value here
  // disconnects fetch/WISP backends from the NIC. v86 already randomises the
  // guest MAC, so keep the backend and device on channel zero.
  dev.id = 0;
  if (n.attach === "internal" || n.attach === "hostonly") {
    // Isolated modes: no upstream relay (VMs-only network isn't possible across
    // browser tabs, so this behaves as an offline NIC — closest honest mapping).
    dev.relay_url = "";  // present NIC but no upstream
  } else if (n.attach === "nat") {
    dev.relay_url = (n.name && (/^(?:wisp|wisps|ws|wss):\/\//.test(n.name) || n.name === "fetch"))
      ? n.name
      : await resolveDefaultInternetUrl();
  } else {
    dev.relay_url = (n.name && /^wss?:\/\//.test(n.name))
      ? n.name
      : await resolveDefaultRelayUrl();
  }
  opts.net_device = dev;
}

(function configControls() {
  const osSel = $("osSelect"), memSel = $("memSel");
  const isoFile = $("isoFile"), isoInfo = $("isoInfo"), isoDrop = $("isoDrop"),
        isoActions = $("isoActions"), isoBoot = $("isoBoot"), isoClear = $("isoClear");
  const N = CFG.net;
  const elN = {
    enable:$("netEnable"), attach:$("netAttach"), name:$("netName"),
    nameField:$("netNameField"), nameLbl:$("netNameLbl"), type:$("netType"),
    promisc:$("netPromisc"), mac:$("netMacIn"), mtu:$("netMtu"),
    cable:$("netCable"), note:$("netNote"), pfBtn:$("netPortFwd"),
  };

  // ----- init from saved config -----
  if (memSel) memSel.value = String(CFG.memMB);
  if (elN.enable) elN.enable.checked = N.enabled !== false;
  if (elN.attach) elN.attach.value = N.attach || "nat";
  if (elN.name) elN.name.value = N.name || "";
  if (elN.type) elN.type.value = N.type || "virtio";
  if (elN.promisc) elN.promisc.value = N.promisc || "deny";
  if (elN.mac) { elN.mac.value = ""; elN.mac.placeholder = "automatic (assigned by v86)"; }
  if (elN.mtu) elN.mtu.value = N.mtu || "";
  if (elN.cable) elN.cable.checked = N.cable !== false;

  const NAME_LABELS = { nat:"Internet proxy", natnet:"NAT network", bridged:"Bridge name",
                        internal:"Network name", hostonly:"Adapter", notattached:"" };
  const NOTES = {
    nat:        "The standalone launcher uses its built-in WISP proxy (no admin rights required). On a hosted deployment, enter a compatible <code>wisps://...</code> endpoint. DNS and TCP/HTTPS work; inbound ports are not exposed.",
    natnet:     "<b>VMs share a subnet</b> via the raw Ethernet relay. The bundled relay gives each tab a unique 10.5.0.x address; internet on this mode requires a relay host with NAT.",
    bridged:    "<b>Not possible in a browser</b> — needs a real hypervisor (VirtualBox/VMware/QEMU) for a router DHCP IP. Use NAT here.",
    internal:   "Not available in a browser. Use NAT.",
    hostonly:   "Not available in a browser. Use NAT.",
    notattached:"No network adapter — the VM is fully offline.",
  };
  function syncNetUI() {
    const on = elN.enable.checked;
    const a = elN.attach.value;
    ["attach","name","type","promisc","mac","mtu","cable","pfBtn"].forEach(k => { if (elN[k]) elN[k].disabled = !on; });
    if (elN.nameField) elN.nameField.style.display = (a === "notattached" || !on) ? "none" : "";
    if (elN.nameLbl) elN.nameLbl.textContent = NAME_LABELS[a] || "Name";
    if (elN.name) elN.name.placeholder = a === "nat" ? "automatic (built-in WISP)" : (a + " name");
    if (elN.pfBtn) elN.pfBtn.style.display = a === "natnet" ? "" : "none";
    if (elN.note) elN.note.innerHTML = on ? (NOTES[a] || "") : "Network adapter disabled — VM is offline.";
  }
  syncNetUI();

  function saveNet() {
    CFG.net = {
      enabled: elN.enable.checked, attach: elN.attach.value, name: (elN.name.value||"").trim(),
      type: elN.type.value, promisc: elN.promisc.value, mac: (elN.mac.value||"").trim(),
      mtu: (elN.mtu.value||"").trim(), cable: elN.cable.checked, portfwd: N.portfwd || [],
    };
    localStorage.setItem("browseros-netcfg", JSON.stringify(CFG.net));
    $("sStatus"); // no-op
    toast("Network settings saved — apply on next boot");
  }
  ["enable","attach","name","type","promisc","mac","mtu","cable"].forEach(k => {
    if (elN[k]) elN[k].addEventListener("change", () => { syncNetUI(); saveNet(); });
  });

  // ----- Port forwarding modal -----
  const pfModal = $("#pfModal"), pfRules = $("#pfRules");
  function renderPF() {
    pfRules.replaceChildren();
    (CFG.net.portfwd || []).forEach((r, i) => {
      const row = document.createElement("div"); row.className = "pf-rule";
      const makeInput = (value, placeholder, type) => {
        const input = document.createElement("input");
        input.value = value == null ? "" : String(value);
        input.placeholder = placeholder;
        if (type) input.type = type;
        return input;
      };
      const nm = makeInput(r.name, "rule");
      const hp = makeInput(r.host, "8022", "number");
      const gp = makeInput(r.guest, "22", "number");
      const del = document.createElement("button");
      del.className = "btn ghost";
      del.style.cssText = "padding:2px 6px";
      del.textContent = "✕";
      nm.oninput=()=>r.name=nm.value; hp.oninput=()=>r.host=hp.value; gp.oninput=()=>r.guest=gp.value;
      del.onclick=()=>{ CFG.net.portfwd.splice(i,1); renderPF(); };
      row.append(nm, hp, gp, del);
      pfRules.appendChild(row);
    });
  }
  if (elN.pfBtn) elN.pfBtn.onclick = () => { CFG.net.portfwd = CFG.net.portfwd || []; renderPF(); pfModal.classList.add("on"); };
  $("#pfAdd") && ($("#pfAdd").onclick = () => { CFG.net.portfwd.push({name:"",host:"",guest:""}); renderPF(); });
  $("#pfClose") && ($("#pfClose").onclick = () => pfModal.classList.remove("on"));
  $("#pfSave") && ($("#pfSave").onclick = () => { saveNet(); pfModal.classList.remove("on"); });

  // ----- Memory -----
  if (memSel) memSel.onchange = () => {
    CFG.memMB = parseInt(memSel.value, 10); localStorage.setItem("browseros-mem", String(CFG.memMB));
    els.sMem.textContent = CFG.memMB + " MB";
    toast("Memory: " + CFG.memMB + " MB — applies on next boot");
  };

  // ----- Custom ISO upload (with validation) -----
  function setIsoStatus(msg, kind) {
    if (!isoInfo) return;
    isoInfo.textContent = msg;
    isoInfo.className = "iso-status" + (kind ? " " + kind : "");
  }
  // Inspect the first bytes to decide if v86 can likely boot it, and warn for
  // common unsupported cases (64-bit only ISOs, non-bootable archives, etc.).
  function validateImage(name, buf) {
    const n = (name || "").toLowerCase();
    const u = new Uint8Array(buf);
    const sizeMB = buf.byteLength / 1048576;
    const ext = n.slice(n.lastIndexOf("."));
    const okExt = [".iso", ".img", ".bin"].includes(ext);
    if (!okExt) return { ok:false, msg:`Unsupported file type "${ext}". Please choose a .iso or .img bootable image.` };
    if (buf.byteLength < 64 * 1024) return { ok:false, msg:"File too small or not a disk image. Choose a real bootable ISO or IMG." };

    // ISO9660 magic "CD001" at offset 0x8001 (sector 16). Strong signal it's an ISO.
    const cd001 = u.length > 0x8006 &&
      u[0x8001]===0x43 && u[0x8002]===0x44 && u[0x8003]===0x30 && u[0x8004]===0x30 && u[0x8005]===0x31;
    // MBR boot signature 0x55AA at 510 — typical for .img / hybrid ISOs.
    const mbr = u[510]===0x55 && u[511]===0xAA;

    if (!cd001 && !mbr && ext === ".iso")
      return { ok:false, msg:"Doesn't look like a bootable ISO (no ISO9660/boot signature). Try another image." };

    // Accept ANY image that passes the boot-signature checks. We only WARN
    // (not block) for likely-64-bit or large images, so users can try any ISO.
    const warns = [];
    if (sizeMB > 900)
      warns.push("Large image (" + sizeMB.toFixed(0) + " MB) — will be slow.");
    const looks64 = /ubuntu|fedora|mint|kali|manjaro|popos|centos|rocky|alma|x86[_-]?64|amd64/i.test(n)
                    && !/i386|i686|x86(?![_-]64)/i.test(n);
    if (looks64)
      warns.push("Name suggests 64-bit — BrowserOS is 32-bit, so it may not boot. " +
                 "A 32-bit (i686) image is recommended.");

    return { ok:true, warn: warns.join(" "), sizeMB, cd001, mbr };
  }

  async function loadIso(f) {
    if (!f) return;
    setIsoStatus("Reading " + f.name + " (" + (f.size/1048576).toFixed(1) + " MB)…", "");
    let buf;
    try { buf = await f.arrayBuffer(); }
    catch (e) { setIsoStatus("Failed to read file: " + e.message, "err"); return; }

    const v = validateImage(f.name, buf);
    if (!v.ok) {
      setIsoStatus(v.msg + " Choose a different ISO.", "err");
      if (isoActions) isoActions.style.display = "none";
      return;
    }
    try {
      await Store.put("customIso", buf);
      await Store.put("customIsoName", f.name);
      await clearSavedState();
      CFG.osMode = "custom";
      localStorage.setItem("browseros-os", "custom");
      if (osSel) osSel.value = "custom"; $("sOS").textContent = "Custom ISO";
      const head = "Ready: " + f.name + " (" + v.sizeMB.toFixed(1) + " MB).";
      if (v.warn) setIsoStatus(head + " ⚠️ " + v.warn + " You can still try booting it.", "warn");
      else setIsoStatus(head + " Looks bootable. Press Boot this image.", "ok");
      if (isoActions) isoActions.style.display = "flex";
      toast("Image loaded — press Boot to run it");
    } catch (e) {
      setIsoStatus("Could not store the image (too large for browser storage?): " + e.message, "err");
    }
  }

  // Show existing uploaded image on load
  Store.get("customIsoName").then(n => {
    if (n) { setIsoStatus("Loaded: " + n + " (stored in your browser).", "ok"); if (isoActions) isoActions.style.display = "flex"; }
  }).catch(()=>{});

  if (isoDrop) {
    isoDrop.onclick = () => isoFile && isoFile.click();
    isoDrop.addEventListener("dragover", (e) => { e.preventDefault(); isoDrop.classList.add("drag"); });
    isoDrop.addEventListener("dragleave", () => isoDrop.classList.remove("drag"));
    isoDrop.addEventListener("drop", (e) => {
      e.preventDefault(); isoDrop.classList.remove("drag");
      const f = e.dataTransfer.files && e.dataTransfer.files[0];
      loadIso(f);
    });
  }
  if (isoFile) isoFile.onchange = () => loadIso(isoFile.files && isoFile.files[0]);
  if (isoBoot) isoBoot.onclick = () => { CFG.osMode = "custom"; if (osSel) osSel.value = "custom"; boot(); };
  if (isoClear) isoClear.onclick = async () => {
    await Store.del("customIso"); await Store.del("customIsoName");
    setIsoStatus("No custom image uploaded yet.", "");
    if (isoActions) isoActions.style.display = "none";
    if (CFG.osMode === "custom") { CFG.osMode = "alpine9p"; localStorage.setItem("browseros-os","alpine9p"); if (osSel) osSel.value = "alpine9p"; $("sOS").textContent = "Alpine Linux"; }
    toast("Custom image removed");
  };
})();
els.dl.onclick = exportState;
els.cad.onclick = () => { emulator?.keyboard_send_scancodes?.([0x1d,0x38,0x53,0xd3,0xb8,0x9d]); toast("Ctrl-Alt-Del sent"); };
els.pause.onclick = () => {
  if (!emulator) return;
  paused = !paused;
  paused ? emulator.stop() : emulator.run();
  setStatus(paused ? "Paused" : "Running", paused ? "busy" : "on");
  els.sStatus.textContent = paused ? "Paused" : "Running";
  toast(paused ? "Paused" : "Resumed");
};
els.full.onclick = () => {
  const c = els.screen.querySelector("canvas");
  (c?.requestFullscreen || els.screen.requestFullscreen)?.call(c || els.screen);
};

// Show / hide the sidebar → full-width console view (remembers your choice).
function applySidebar(hidden) {
  document.body.classList.toggle("no-side", hidden);
  localStorage.setItem("browseros-no-side", hidden ? "1" : "0");
}
els.sidebar.onclick = () =>
  applySidebar(!document.body.classList.contains("no-side"));
applySidebar(localStorage.getItem("browseros-no-side") === "1");

// Crisp 1:1 display toggle → fixes the hazy/blurred console (no upscaling).
function applyCrisp(on) {
  document.body.classList.toggle("crisp", on);
  localStorage.setItem("browseros-crisp", on ? "1" : "0");
  els.crisp.classList.toggle("primary", on);
}
els.crisp.onclick = () => applyCrisp(!document.body.classList.contains("crisp"));
applyCrisp(localStorage.getItem("browseros-crisp") === "1");

// Console zoom — scales the canvas with SHARP pixels so text gets bigger and
// stays crisp. "Fit" lets the browser size it to the window (default).
let zoom = 0; // 0 = Fit; otherwise a multiplier like 1, 1.5, 2 …
function applyZoom(z) {
  zoom = z;
  if (!z) {
    document.body.classList.remove("zoomed");
    document.documentElement.style.removeProperty("--zoom");
    els.zoomLabel.textContent = "Fit";
    localStorage.setItem("browseros-zoom", "0");
    return;
  }
  zoom = Math.max(0.5, Math.min(5, z));
  document.body.classList.add("zoomed");
  document.documentElement.style.setProperty("--zoom", zoom.toFixed(2));
  els.zoomLabel.textContent = Math.round(zoom * 100) + "%";
  localStorage.setItem("browseros-zoom", String(zoom));
  // Also tell v86 to scale natively (crisp), if available.
  try { emulator && emulator.screen_set_scale && emulator.screen_set_scale(zoom, zoom); } catch (_) {}
}
els.zoomIn.onclick  = () => applyZoom((zoom || 1) + 0.25);
els.zoomOut.onclick = () => applyZoom((zoom || 1) - 0.25);
els.zoomFit.onclick = () => applyZoom(0);

// ---- Console focus indicator (so you can see when the cursor is active) ----
(function focusHandling() {
  const crt = document.querySelector(".crt");
  const showFocused = (on) => crt && crt.classList.toggle("focused", on);
  // Clicking anywhere in the screen focuses the canvas → Linux cursor activates.
  els.screen.addEventListener("mousedown", () => {
    const c = els.screen.querySelector("canvas");
    (c || els.screen).focus?.();
    showFocused(true);
  });
  els.screen.addEventListener("focusin", () => showFocused(true));
  document.addEventListener("focusin", (e) => {
    if (!els.screen.contains(e.target)) showFocused(false);
  });
})();

// ---- Clipboard bridge: host ⇄ VM ----
// Paste your machine's clipboard INTO the VM (types it via the keyboard API).
els.paste.onclick = async () => {
  if (!emulator) { toast("Boot first"); return; }
  let text = "";
  try { text = await navigator.clipboard.readText(); }
  catch (_) {
    text = prompt("Clipboard blocked by the browser. Paste your text here to send it to the VM:") || "";
  }
  if (!text) { toast("Nothing to paste"); return; }
  const c = els.screen.querySelector("canvas"); (c || els.screen).focus?.();
  if (typeof emulator.keyboard_send_text === "function") {
    emulator.keyboard_send_text(text);
    toast("Pasted " + text.length + " chars into the VM");
  } else if (typeof emulator.serial0_send === "function") {
    emulator.serial0_send(text);
    toast("Sent to VM console");
  } else {
    toast("Paste not supported by this engine build");
  }
};

// Copy the VM's recent console text OUT to your machine's clipboard.
els.copyOut.onclick = async () => {
  const text = (consoleBuf || bootLog || "").trim();
  if (!text) { toast("No console text captured yet"); return; }
  try {
    await navigator.clipboard.writeText(text);
    toast("Copied " + text.length + " chars from the VM console");
  } catch (_) {
    const blob = new Blob([text], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = "console.txt"; a.click();
    URL.revokeObjectURL(a.href);
    toast("Clipboard blocked — saved console to a file");
  }
};

// ---- "Setup Ubuntu env" : type a setup script into the guest console ----
// Installs a dev toolset and Ubuntu-style conveniences (bash, apt shim, ll…).
// Setup commands typed line-by-line into the guest. Kept deliberately simple
// (no nested quote gymnastics) so they survive being sent as key presses.
// We build the apt shim and profile with a heredoc, which types cleanly.
// OFFLINE install from the pre-baked tools disk (second drive, no internet).
// The disk holds all .apk files + an install.sh that installs them and sets up
// the Ubuntu-like environment. We mount it and run that script.
const UBUNTU_SETUP_LINES = [
  "mkdir -p /mnt/tools",
  "for m in 9p 9pnet 9pnet_virtio; do modprobe $m 2>/dev/null; done",
  "mount -t 9p -o trans=virtio,version=9p2000.L host9p /mnt/tools 2>/dev/null || mount -t 9p -o trans=virtio host9p /mnt/tools 2>/dev/null",
  "ls /mnt/tools/apks >/dev/null 2>&1 && echo TOOLS_MOUNTED_OK || echo TOOLS_NOT_FOUND",
  "sh /mnt/tools/install.sh",
];

function guestType(text) {
  if (!emulator) { toast("Boot Alpine first"); return false; }
  // The visible Alpine shell runs on the VGA console (tty1), so we must
  // simulate real KEY PRESSES with keyboard_send_text. serial0_send goes to
  // ttyS0 (a different console the shell isn't on) and would appear to do
  // nothing — so keyboard input is the correct, reliable method here.
  const c = els.screen && els.screen.querySelector("canvas");
  (c || els.screen)?.focus?.();
  if (typeof emulator.keyboard_send_text === "function") {
    emulator.keyboard_send_text(text);
    return true;
  }
  if (typeof emulator.serial0_send === "function") {
    emulator.serial0_send(text);
    return true;
  }
  return false;
}

els.ubuntu.onclick = () => {
  if (!emulator) { toast("Boot Alpine first, log in as root, then click this."); return; }
  const ok = confirm(
    "This installs a dev toolset + Ubuntu-style commands from the OFFLINE tools\n" +
    "disk (bash, sudo, git, curl, python3, an 'apt' shim, 'll' alias, etc).\n" +
    "No internet needed — packages are bundled.\n\n" +
    "BEFORE you click OK:\n" +
    "  1. Make sure you're logged in as root (prompt shows  ~ #  or  localhost:~#)\n" +
    "  2. Click once inside the black console so it has focus\n\n" +
    "Takes ~30–60s. When done, type 'exec bash -l' then try 'll'.\nContinue?"
  );
  if (!ok) return;
  if (typeof emulator.keyboard_send_text !== "function") {
    toast("This engine build can't auto-type. Paste the commands manually.");
    return;
  }
  // Focus the console, then type each line with a delay so the guest's
  // keyboard buffer never overflows (which would drop/garble characters).
  const c = els.screen.querySelector("canvas"); (c || els.screen).focus?.();
  document.querySelector(".crt")?.classList.add("focused");
  toast("Typing setup into the console… don't click away (~1–2 min for downloads)");

  let i = 0;
  emulator.keyboard_send_text("\n");   // fresh prompt line
  const typeNext = () => {
    if (i >= UBUNTU_SETUP_LINES.length) {
      toast("Setup sent! When it finishes, type 'exec bash -l' then try 'll'. Then click Save.");
      return;
    }
    const line = UBUNTU_SETUP_LINES[i++];
    emulator.keyboard_send_text(line + "\n");
    // 'apk add' line needs much longer (it downloads packages).
    const delay = /mount|install.sh/.test(line) ? 1500 : 250;
    setTimeout(typeNext, delay);
  };
  setTimeout(typeNext, 400);
};
{
  // Default to a comfortably BIG console (1.5x) on first run; remember choice.
  const raw = localStorage.getItem("browseros-zoom");
  const saved = raw === null ? 1.5 : parseFloat(raw);
  applyZoom(isNaN(saved) ? 1.5 : saved);
}

// Keyboard zoom: Ctrl/Cmd with +, -, 0 (0 = Fit). Only when not in the VM-less
// boot overlay, and only with the modifier so it never clashes with the guest.
document.addEventListener("keydown", (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  if (e.key === "=" || e.key === "+") { e.preventDefault(); els.zoomIn.onclick(); }
  else if (e.key === "-" || e.key === "_") { e.preventDefault(); els.zoomOut.onclick(); }
  else if (e.key === "0") { e.preventDefault(); els.zoomFit.onclick(); }
});

// Browsers do not reliably finish large asynchronous snapshots in
// beforeunload. Save earlier when the page becomes hidden; pagehide is a
// best-effort second opportunity. The coordinator throttles and coalesces both.
function requestLifecycleSave() {
  if (!emulator) return;
  stateSaver.lifecycle().catch(() => {});
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") requestLifecycleSave();
});
window.addEventListener("pagehide", requestLifecycleSave);

// Show whether a compatible saved session exists on load.
Promise.all([
  Store.get("savedAt"),
  Store.get("stateOS"),
  Store.get("stateMachine"),
]).then(([t, stateOS, machine]) => {
  if (t &&
      stateOS === CFG.osMode &&
      machine &&
      machine.format === 1 &&
      (!machine.instanceId || machine.instanceId === Instance.id) &&
      machine.osMode === CFG.osMode &&
      machine.memoryMB === CFG.memMB) {
    els.ovText.textContent = "A saved session was found (" + new Date(t).toLocaleString() +
      "). Press Boot to resume it, or Reset to start fresh.";
    els.statusText.textContent = "Saved session ready";
  } else if (t) {
    els.ovText.textContent =
      "An older or differently configured saved session exists. Boot will start fresh; Reset removes the old state.";
    els.statusText.textContent = "Fresh boot required";
  }
}).catch(() => {});

// ---------- Desktop shell integration hooks ----------
// Expose the running emulator and helpers so desktop.js can use them.
window.__getEmulator = () => emulator;
window.__captureState = () => stateSaver.capture();
window.__setupUbuntu = () => { try { els.ubuntu.onclick(); } catch (_) {} };
window.__launchFirefox = () => {
  if (!emulator || CFG.osMode !== "alpine9p") {
    toast("Boot Alpine first, then open Firefox.");
    return false;
  }
  const c = els.screen && els.screen.querySelector("canvas");
  (c || els.screen)?.focus?.();
  toast("Starting Firefox inside Alpine. First launch installs the bundled GUI stack.");
  // Short, paced lines avoid overflowing the emulated PS/2 keyboard buffer.
  const lines = [
    "root",
    "mkdir -p /mnt/tools",
    "mount -t 9p -o trans=virtio host9p /mnt/tools",
    "sh /mnt/tools/launch-firefox.sh",
  ];
  const delays = [0, 1800, 900, 1100];
  let elapsed = 0;
  lines.forEach((line, index) => {
    elapsed += delays[index];
    setTimeout(() => emulator?.keyboard_send_text(line + "\n"), elapsed);
  });
  return true;
};
window.__getMachineConfig = () => ({
  format: 1,
  instanceId: Instance.id,
  osMode: CFG.osMode,
  osVersion: CFG.osMode === "alpine9p" ? CFG.alpineVersion : null,
  memoryMB: activeMachineConfig.memoryMB,
  vgaMemoryMB: activeMachineConfig.vgaMemoryMB,
});
// Validate and stage a named snapshot for restoration.
window.__restoreState = async (snapshot) => {
  const machine = snapshot && snapshot.machine;
  if (!snapshot || !snapshot.state || !machine ||
      machine.format !== 1 ||
      machine.instanceId !== Instance.id ||
      machine.osMode !== CFG.osMode ||
      (CFG.osMode === "alpine9p" && machine.osVersion !== CFG.alpineVersion) ||
      machine.memoryMB !== CFG.memMB ||
      !Number.isFinite(machine.vgaMemoryMB)) {
    return {
      ok: false,
      message: "This snapshot belongs to a different VM, OS, or RAM configuration.",
    };
  }
  try {
    await Store.put("state", snapshot.state);
    await Store.put("savedAt", Date.now());
    await Store.put("stateOS", machine.osMode);
    await Store.put("stateMachine", machine);
    location.reload();
    return { ok: true };
  } catch (e) {
    return { ok: false, message: "Snapshot restore failed: " + e.message };
  }
};
