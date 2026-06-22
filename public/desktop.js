/* BrowserOS Desktop Shell
 * A lightweight Ubuntu-like windowed environment layered over the v86 VM.
 * Provides: top bar + clock, left dock, draggable/resizable windows, an
 * Activities app grid, a tabbed Terminal app (sessions into the real VM),
 * a named multi-snapshot manager, and a few utility apps.
 *
 * It reuses the existing emulator created by app.js (window.__getEmulator).
 */
(function () {
  "use strict";
  const $ = (s, r = document) => r.querySelector(s);
  const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };

  let zTop = 100;
  const windows = {};
  const screenDock = window.BrowserOSScreenDock.create(document);
  screenDock.capture();

  // ---------- Desktop root ----------
  function buildDesktop() {
    const existing = document.getElementById("desktop");
    if (existing) return existing;
    const d = el("div"); d.id = "desktop";
    d.innerHTML = `
      <div class="d-topbar">
        <div class="d-activities" id="d-activities">Activities</div>
        <div class="d-clock" id="d-clock">--:--</div>
        <div class="d-tray">
          <span class="d-ico" id="d-snap" title="Snapshots">&#128190;</span>
          <span class="d-ico" id="d-power" title="Power / exit desktop">&#9211;</span>
        </div>
      </div>
      <div class="d-area" id="d-area">
        <div class="d-dock" id="d-dock"></div>
        <div class="d-overlay" id="d-overlay"><div class="d-grid" id="d-grid"></div></div>
      </div>`;
    document.body.appendChild(d);

    const dock = $("#d-dock", d);
    APPS.forEach(a => {
      const b = el("div", "app");
      b.append(document.createTextNode(a.icon));
      const tip = el("span", "tip");
      tip.textContent = a.name;
      b.appendChild(tip);
      b.onclick = () => openApp(a.id);
      b.dataset.app = a.id;
      dock.appendChild(b);
    });

    const grid = $("#d-grid", d);
    APPS.forEach(a => {
      const g = el("div", "gapp");
      const icon = el("div", "gi");
      icon.textContent = a.icon;
      const name = el("div");
      name.textContent = a.name;
      g.append(icon, name);
      g.onclick = () => { openApp(a.id); toggleActivities(false); };
      grid.appendChild(g);
    });

    $("#d-activities", d).onclick = () => toggleActivities();
    $("#d-overlay", d).onclick = (e) => { if (e.target.id === "d-overlay") toggleActivities(false); };
    $("#d-snap", d).onclick = () => openApp("snapshots");
    $("#d-power", d).onclick = () => {
      if (confirm("Leave the desktop and return to the simple view?")) hideDesktop();
    };

    setInterval(() => { $("#d-clock").textContent = new Date().toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"}); }, 1000);
    return d;
  }

  function toggleActivities(force) {
    const o = $("#d-overlay");
    o.classList.toggle("on", force === undefined ? !o.classList.contains("on") : force);
  }

  function hideDesktop() {
    screenDock.restore();
    document.getElementById("desktop")?.classList.remove("on");
  }

  // ---------- Window manager ----------
  function makeWindow(id, title, opts = {}) {
    if (windows[id]) { focusWin(windows[id]); return windows[id]; }
    const w = el("div", "win");
    const area = $("#d-area");
    const areaWidth = area?.clientWidth || window.innerWidth;
    const areaHeight = area?.clientHeight || Math.max(220, window.innerHeight - 30);
    const minWidth = 320;
    const minHeight = 220;
    const requestedX = opts.x ?? (80 + Object.keys(windows).length * 28);
    const requestedY = opts.y ?? (50 + Object.keys(windows).length * 24);
    const x = Math.max(0, Math.min(requestedX, areaWidth - minWidth));
    const y = Math.max(0, Math.min(requestedY, areaHeight - minHeight));
    const width = Math.min(opts.w || 720, Math.max(minWidth, areaWidth - x - 16));
    const height = Math.min(opts.h || 460, Math.max(minHeight, areaHeight - y - 16));
    w.style.left = x + "px"; w.style.top = y + "px";
    w.style.width = width + "px"; w.style.height = height + "px";
    w.innerHTML = `
      <div class="titlebar">
        <button class="wbtn close"></button>
        <button class="wbtn min"></button>
        <button class="wbtn maxb"></button>
        <div class="ttl"></div>
      </div>
      <div class="wbody"></div>`;
    $(".ttl", w).textContent = title;
    $("#d-area").appendChild(w);
    windows[id] = w; w.dataset.app = id;
    focusWin(w);

    const tb = $(".titlebar", w);
    $(".close", w).onclick = () => closeWin(id);
    $(".min", w).onclick = () => {
      if (id === "terminal" || id === "firefox") screenDock.restore();
      w.style.display = "none";
      markDock();
    };
    $(".maxb", w).onclick = () => toggleMax(w);
    w.addEventListener("mousedown", () => focusWin(w));
    dragify(w, tb);
    markDock();
    return $(".wbody", w);
  }
  function focusWin(w) {
    Object.values(windows).forEach(x => x.classList.remove("focused"));
    w.classList.add("focused"); w.style.zIndex = ++zTop; markDock();
  }
  function closeWin(id) {
    const w = windows[id]; if (!w) return;
    if (id === "terminal" || id === "firefox") screenDock.restore();
    w.remove(); delete windows[id]; markDock();
  }
  function toggleMax(w) {
    if (w.classList.contains("max")) {
      w.classList.remove("max");
      Object.assign(w.style, w._restore || {});
    } else {
      w._restore = { left:w.style.left, top:w.style.top, width:w.style.width, height:w.style.height };
      w.classList.add("max");
      Object.assign(w.style, { left:"0", top:"30px", width:"100%", height:"calc(100% - 30px)" });
    }
  }
  function dragify(w, handle) {
    let sx, sy, ox, oy, drag = false;
    handle.addEventListener("mousedown", (e) => {
      if (e.target.classList.contains("wbtn")) return;
      drag = true; sx = e.clientX; sy = e.clientY;
      ox = parseInt(w.style.left); oy = parseInt(w.style.top);
      document.body.style.userSelect = "none";
    });
    window.addEventListener("mousemove", (e) => {
      if (!drag) return;
      w.style.left = (ox + e.clientX - sx) + "px";
      w.style.top = Math.max(30, oy + e.clientY - sy) + "px";
    });
    window.addEventListener("mouseup", () => { drag = false; document.body.style.userSelect = ""; });
  }
  function markDock() {
    document.querySelectorAll("#d-dock .app").forEach(a => {
      const w = windows[a.dataset.app] || windows[a.dataset.app + "-0"];
      a.classList.toggle("active", !!w && w.style.display !== "none");
    });
  }

  // ---------- Apps ----------
  const APPS = [
    { id:"firefox",   name:"Firefox", icon:"🦊" },
    { id:"terminal",  name:"Terminal",  icon:"🖥" },
    { id:"files",     name:"Files",     icon:"📁" },
    { id:"editor",    name:"Text Editor", icon:"📝" },
    { id:"snapshots", name:"Snapshots", icon:"💾" },
    { id:"system",    name:"System",    icon:"⚙" },
    { id:"help",      name:"Help",      icon:"❓" },
  ];

  function openApp(id) {
    if (id === "firefox") return openFirefox();
    if (id === "terminal") return openTerminal();
    if (id === "snapshots") return openSnapshots();
    if (id === "system") return openSystem();
    if (id === "files") return openInfoApp("files", "Files", FILES_HTML);
    if (id === "editor") return openInfoApp("editor", "Text Editor", EDITOR_HTML);
    if (id === "help") return openInfoApp("help", "Help", HELP_HTML);
  }

  // ---- Firefox inside the Alpine guest ----
  let firefoxLaunchRequested = false;
  function openFirefox() {
    const existing = windows["firefox"];
    if (existing) {
      existing.style.display = "";
      attachVM($("#firefox-vm-host", existing));
      focusWin(existing);
      return;
    }
    const body = makeWindow("firefox", "Firefox — Alpine Linux VM", {
      x: 74, y: 40,
      w: Math.max(340, Math.min(window.innerWidth - 110, 1200)),
      h: Math.max(240, Math.min(window.innerHeight - 90, 800)),
    });
    body.innerHTML = `<div class="guest-browser">
      <div class="guest-browser-status">
        Firefox runs inside Alpine. First launch installs the bundled GUI packages and can take several minutes.
      </div>
      <div class="guest-browser-screen" id="firefox-vm-host"></div>
    </div>`;
    attachVM($("#firefox-vm-host", body));
    if (!firefoxLaunchRequested) {
      firefoxLaunchRequested = true;
      const launched = window.__launchFirefox?.();
      if (!launched) firefoxLaunchRequested = false;
    }
  }

  // ---- Terminal with tabs ----
  let termTabCount = 0;
  function openTerminal() {
    const existing = windows["terminal"];
    if (existing) {
      existing.style.display = "";
      attachVM($("#term-vm-host", existing));
      focusWin(existing);
      return;
    }
    const body = makeWindow("terminal", "Terminal — Alpine Linux", {
      x: 60, y: 50,
      w: Math.min(window.innerWidth - 120, 1200),
      h: Math.min(window.innerHeight - 120, 760),
    });
    body.innerHTML = `
      <div class="term">
        <div class="tabs" id="t-tabs"></div>
        <div class="screens" id="t-screens"></div>
      </div>`;
    const tabs = $("#t-tabs", body), screens = $("#t-screens", body);

    const addTab = (isVM) => {
      const idx = termTabCount++;
      const tab = el("div", "tab" + (idx === 0 ? " active" : ""),
        `<span>${isVM ? "Linux (VM)" : "tmux " + idx}</span>` +
        (isVM ? "" : `<span class="x">&#10005;</span>`));
      const scr = el("div", "screen" + (idx === 0 ? " active" : ""));
      scr.dataset.idx = idx;
      if (isVM) {
        // Move the real emulator screen into this tab.
        const host = el("div", "scr"); host.id = "term-vm-host";
        scr.appendChild(host);
        attachVM(host);
        scr.appendChild(el("div", "note",
          "This is the real Alpine console. Click it to type. Other tabs run extra shells via <b>tmux</b> inside this same VM."));
      } else {
        scr.appendChild(el("div", "note",
          "Extra shell tab. In the Linux (VM) tab run <b>tmux</b> then Ctrl+B then C for new windows, "+
          "or just use this as a notes pane. (v86 exposes one console; true split shells use tmux/screen.)"));
      }
      tab.onclick = (e) => {
        if (e.target.classList.contains("x")) {
          if (isVM) return; // the live VM console is the permanent primary tab
          if (screens.querySelectorAll(".screen").length <= 1) return;
          tab.remove(); scr.remove(); activateFirst(); return;
        }
        document.querySelectorAll("#t-tabs .tab").forEach(t => t.classList.remove("active"));
        document.querySelectorAll("#t-screens .screen").forEach(s => s.classList.remove("active"));
        tab.classList.add("active"); scr.classList.add("active");
      };
      tabs.insertBefore(tab, $(".newtab", tabs));
      screens.appendChild(scr);
    };
    const activateFirst = () => {
      const t = $("#t-tabs .tab"); const s = $("#t-screens .screen");
      if (t) t.classList.add("active"); if (s) s.classList.add("active");
    };

    const newBtn = el("div", "tab newtab", "+ tmux");
    newBtn.onclick = () => addTab(false);
    tabs.appendChild(newBtn);
    addTab(true);   // first tab = real VM console
  }

  function attachVM(host) {
    screenDock.attach(host);
  }

  // ---- Snapshots (named, multiple) ----
  function openSnapshots() {
    const body = makeWindow("snapshots", "Snapshots", { w: 560, h: 460 });
    const render = async () => {
      const list = await SnapStore.list();
      body.innerHTML = `<div class="snaps">
        <h3>Machine Snapshots</h3>
        <div class="note" style="margin-bottom:12px">Snapshots for VM <code id="snapshot-vm-id"></code>. Each VM URL has an isolated snapshot history.</div>
        <div class="newbar">
          <input id="snap-name" placeholder="Snapshot name (e.g. after-setup)" />
          <button class="dbtn primary" id="snap-take">Take snapshot</button>
        </div>
        <div id="snap-list"></div>
      </div>`;
      $("#snapshot-vm-id", body).textContent = snapshotInstance;
      const ul = $("#snap-list", body);
      if (!list.length) ul.innerHTML = `<div class="note" style="color:var(--d-muted)">No snapshots yet. Boot the VM, set things up, then take one.</div>`;
      list.forEach(s => {
        const compatible = snapshotCompatible(s);
        const r = el("div", "row");
        const meta = el("div", "meta");
        const title = el("b"); title.textContent = s.name;
        const detail = el("small");
        detail.textContent = new Date(s.at).toLocaleString() + " · " +
          (s.size/1048576).toFixed(1) + " MB · " +
          (compatible ? s.machine.osMode + " / " + s.machine.memoryMB + " MB" : "incompatible legacy snapshot");
        meta.appendChild(title); meta.appendChild(document.createElement("br")); meta.appendChild(detail);
        const restore = el("button", "dbtn", "Restore");
        const del = el("button", "dbtn danger", "Delete");
        restore.disabled = !compatible;
        if (!compatible) restore.title = "Snapshot metadata does not match this VM";
        restore.onclick = () => doRestore(s.id);
        del.onclick = async () => { if (confirm("Delete snapshot '"+s.name+"'?")) { await SnapStore.del(s.id); render(); } };
        r.appendChild(meta); r.appendChild(restore); r.appendChild(del); ul.appendChild(r);
      });
      $("#snap-take", body).onclick = async () => {
        const name = ($("#snap-name", body).value || ("snapshot-" + Date.now())).trim().slice(0, 80);
        const emu = window.__getEmulator && window.__getEmulator();
        const machine = window.__getMachineConfig && window.__getMachineConfig();
        if (!emu) { alert("Boot the VM first."); return; }
        if (!machine) { alert("Machine metadata is unavailable."); return; }
        try {
          const state = await window.__captureState();
          await SnapStore.add(name, state, machine);
          render();
        } catch (e) { alert("Snapshot failed: " + e.message); }
      };
    };
    render();
  }
  async function doRestore(id) {
    const snap = await SnapStore.get(id);
    if (!snap) return;
    if (!snapshotCompatible(snap)) {
      alert("This snapshot is incompatible with the current VM, OS, or memory setting.");
      return;
    }
    if (!confirm("Restore '" + snap.name + "'? This reloads the machine into that saved state.")) return;
    const result = await window.__restoreState?.(snap);
    if (result && !result.ok) alert(result.message);
  }

  // ---- System info ----
  function openSystem() {
    const body = makeWindow("system", "System", { w: 480, h: 360 });
    body.innerHTML = `<div class="snaps">
      <h3>BrowserOS</h3>
      <div class="row"><div class="meta">Guest OS<br><small>Alpine Linux (real kernel, x86 via v86)</small></div></div>
      <div class="row"><div class="meta">Environment<br><small>Ubuntu-like: bash, apt shim, ll, git, python3…</small></div></div>
      <div class="row"><div class="meta">Persistence<br><small>Named snapshots in your browser (IndexedDB)</small></div></div>
      <div style="margin-top:12px">
        <button class="dbtn" id="sys-setup">Run "Setup Ubuntu env"</button>
        <button class="dbtn" id="sys-cad">Ctrl-Alt-Del</button>
      </div>
    </div>`;
    $("#sys-setup", body).onclick = () => window.__setupUbuntu && window.__setupUbuntu();
    $("#sys-cad", body).onclick = () => { const e = window.__getEmulator?.(); e?.keyboard_send_scancodes?.([0x1d,0x38,0x53,0xd3,0xb8,0x9d]); };
  }

  function openInfoApp(id, title, html) {
    const body = makeWindow(id, title, { w: 600, h: 420 });
    body.innerHTML = `<div class="snaps">${html}</div>`;
  }

  const FILES_HTML = `<h3>Files</h3><div class="note">A graphical file manager isn't wired to the VM filesystem yet. Use the Terminal: <code>ls</code>, <code>cd</code>, <code>nano</code>. (Roadmap: 9p-backed file browser.)</div>`;
  const EDITOR_HTML = `<h3>Text Editor</h3><div class="note">Use <code>nano</code> or <code>vim</code> inside the Terminal for now. A GUI editor bound to the VM is on the roadmap.</div>`;
  const HELP_HTML = `<h3>Help</h3><div class="note">
    <b>Firefox</b>: launches the real browser inside the Alpine VM. First launch installs the bundled GUI stack.<br>
    <b>Terminal</b>: open multiple shells (extra tabs use tmux inside the VM).<br>
    <b>Snapshots</b>: save named machine states and restore them anytime.<br>
    <b>System</b>: run the one-click Ubuntu setup, send Ctrl-Alt-Del.<br>
    Login is <code>root</code> (no password). Commands match Ubuntu (apt shim + bash).</div>`;

  // ---------- Snapshot storage (IndexedDB) ----------
  function snapshotCompatible(snap) {
    const current = window.__getMachineConfig?.();
    const machine = snap && snap.machine;
    return !!(current && machine &&
      machine.format === 1 &&
      machine.instanceId === current.instanceId &&
      machine.osMode === current.osMode &&
      machine.osVersion === current.osVersion &&
      machine.memoryMB === current.memoryMB &&
      Number.isFinite(machine.vgaMemoryMB));
  }

  const snapshotInstance = window.__browserOSInstance?.id || "unknown";
  const SnapStore = {
    db:null,
    dbName:"browseros-snaps-" + snapshotInstance,
    open(){ return new Promise((res,rej)=>{ const r=indexedDB.open(this.dbName,1);
      r.onupgradeneeded=()=>r.result.createObjectStore("snaps",{keyPath:"id"});
      r.onsuccess=()=>{this.db=r.result;res();}; r.onerror=()=>rej(r.error);});},
    async tx(mode){ if(!this.db) await this.open(); return this.db.transaction("snaps",mode).objectStore("snaps"); },
    async add(name,state,machine){ const s=await this.tx("readwrite");
      const id = "s-" + Date.now() + "-" + Math.random().toString(36).slice(2,8);
      return new Promise((res,rej)=>{const q=s.put({id,name,at:Date.now(),size:state.byteLength||state.length||0,state,machine});
        q.onsuccess=()=>res(id);q.onerror=()=>rej(q.error);});},
    async list(){ const s=await this.tx("readonly"); return new Promise((res,rej)=>{ const out=[]; const q=s.openCursor(); q.onsuccess=e=>{
      const c=e.target.result; if(c){const{id,name,at,size,machine}=c.value;out.push({id,name,at,size,machine});c.continue();}else res(out.sort((a,b)=>b.at-a.at));};
      q.onerror=()=>rej(q.error);});},
    async get(id){ const s=await this.tx("readonly"); return new Promise((res,rej)=>{const g=s.get(id);g.onsuccess=()=>res(g.result);g.onerror=()=>rej(g.error);});},
    async del(id){ const s=await this.tx("readwrite"); return new Promise((res,rej)=>{const q=s.delete(id);q.onsuccess=()=>res();q.onerror=()=>rej(q.error);});},
  };

  // ---------- Public toggle ----------
  window.BrowserOSDesktop = {
    show() {
      (document.getElementById("desktop") || buildDesktop()).classList.add("on");
      openTerminal();
    },
    hide: hideDesktop,
  };

  // Build on load (hidden until toggled).
  document.addEventListener("DOMContentLoaded", buildDesktop);
})();
