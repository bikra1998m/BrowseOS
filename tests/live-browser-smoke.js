#!/usr/bin/env node
"use strict";

const assert = require("assert");

const debuggerUrl = process.argv[2];
const bootTimeoutMs = Number(process.env.BROWSEROS_BOOT_TIMEOUT_MS || 120000);
if (!debuggerUrl) {
  console.error("Usage: node tests/live-browser-smoke.js <webSocketDebuggerUrl>");
  process.exit(2);
}

const ws = new WebSocket(debuggerUrl);
let nextId = 1;
const pending = new Map();
const listeners = new Map();
const findings = {
  consoleErrors: [],
  exceptions: [],
  failedRequests: [],
  httpErrors: [],
};
const requestUrls = new Map();
const responseReceived = new Set();

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject, method });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

function once(method, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      remove();
      reject(new Error(`Timed out waiting for ${method}`));
    }, timeoutMs);
    const handler = (params) => {
      clearTimeout(timer);
      remove();
      resolve(params);
    };
    const remove = () => {
      const set = listeners.get(method);
      if (set) set.delete(handler);
    };
    if (!listeners.has(method)) listeners.set(method, new Set());
    listeners.get(method).add(handler);
  });
}

function evaluate(expression, awaitPromise = true) {
  return send("Runtime.evaluate", {
    expression,
    awaitPromise,
    returnByValue: true,
  }).then((result) => {
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || "Evaluation failed");
    }
    return result.result.value;
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.id) {
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(`${request.method}: ${message.error.message}`));
    else request.resolve(message.result || {});
    return;
  }

  const set = listeners.get(message.method);
  if (set) [...set].forEach((handler) => handler(message.params || {}));

  if (message.method === "Network.requestWillBeSent") {
    requestUrls.set(message.params.requestId, {
      url: message.params.request.url,
      method: message.params.request.method,
    });
  } else if (message.method === "Runtime.consoleAPICalled" &&
      ["error", "assert"].includes(message.params.type)) {
    findings.consoleErrors.push(
      (message.params.args || []).map((arg) => arg.value || arg.description || "").join(" ")
    );
  } else if (message.method === "Runtime.exceptionThrown") {
    findings.exceptions.push(
      message.params.exceptionDetails?.exception?.description ||
      message.params.exceptionDetails?.text ||
      "Uncaught exception"
    );
  } else if (message.method === "Log.entryAdded" &&
             ["error", "warning"].includes(message.params.entry?.level)) {
    const entry = message.params.entry;
    findings.consoleErrors.push(`${entry.text}${entry.url ? ` (${entry.url})` : ""}`);
  } else if (message.method === "Network.loadingFailed") {
    const failure = message.params;
    const request = requestUrls.get(failure.requestId) || {};
    const completedImageProbe =
      failure.errorText === "net::ERR_ABORTED" &&
      responseReceived.has(failure.requestId) &&
      request.method === "HEAD" &&
      /\/images\/alpine(?:\.iso|-(?:vmlinuz|initramfs)-virt)(?:\?|$)/
        .test(request.url || "");
    if (failure.type !== "WebSocket") {
      if (completedImageProbe) return;
      findings.failedRequests.push(
        `${failure.type}: ${failure.errorText} ${request.method || ""} ${request.url || ""}`.trim()
      );
    }
  } else if (message.method === "Network.responseReceived") {
    const response = message.params.response;
    responseReceived.add(message.params.requestId);
    if (response.status >= 400 &&
        !response.url.endsWith("/browseros-capabilities.json")) {
      findings.httpErrors.push(`${response.status} ${response.url}`);
    }
  }
};

ws.onerror = () => {
  console.error("Chrome debugging WebSocket failed");
  process.exit(1);
};

ws.onopen = async () => {
  try {
    await Promise.all([
      send("Runtime.enable"),
      send("Page.enable"),
      send("Network.enable"),
      send("Log.enable"),
    ]);

    const currentUrl = new URL(await evaluate("location.href"));
    currentUrl.searchParams.set("vm", "live-smoke-" + Date.now());
    const loaded = once("Page.loadEventFired", 30000);
    await send("Page.navigate", { url: currentUrl.href });
    await loaded;
    await sleep(2000);
    findings.consoleErrors.length = 0;
    findings.exceptions.length = 0;
    findings.failedRequests.length = 0;
    findings.httpErrors.length = 0;
    requestUrls.clear();
    responseReceived.clear();

    const initial = await evaluate(`(() => ({
      readyState: document.readyState,
      title: document.title,
      crossOriginIsolated: window.crossOriginIsolated,
      engine: typeof (window.V86 || window.V86Starter),
      bootDisabled: document.getElementById("btnStart")?.disabled,
      os: document.getElementById("sOS")?.textContent,
      memory: document.getElementById("sMem")?.textContent,
      memoryControl: document.getElementById("memSel")?.value,
      overlayTitle: document.getElementById("ovTitle")?.textContent,
      instance: window.__browserOSInstance?.id,
      desktopBuilt: !!document.getElementById("desktop"),
      viewportWidth: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth
    }))()`);

    assert.equal(initial.readyState, "complete");
    assert.equal(initial.crossOriginIsolated, true);
    assert.equal(initial.engine, "function");
    assert.equal(initial.bootDisabled, false);
    assert.equal(initial.os, "Alpine Linux");
    assert.equal(initial.memory, "1024 MB");
    assert.equal(initial.memoryControl, "1024");
    assert.equal(initial.desktopBuilt, true);
    assert(
      initial.documentWidth <= initial.viewportWidth,
      `Page overflows horizontally: ${initial.documentWidth}px > ${initial.viewportWidth}px`
    );
    console.log("Initial UI:", JSON.stringify(initial));

    await evaluate(`document.getElementById("btnStart").click()`);
    const deadline = Date.now() + bootTimeoutMs;
    let state;
    while (Date.now() < deadline) {
      await sleep(2000);
      state = await evaluate(`(() => ({
        status: document.getElementById("sStatus")?.textContent,
        statusText: document.getElementById("statusText")?.textContent,
        overlayHidden: document.getElementById("overlay")?.classList.contains("hidden"),
        overlayTitle: document.getElementById("ovTitle")?.textContent,
        overlayText: document.getElementById("ovText")?.textContent,
        bootLogLength: (window.bootLog || "").length,
        emulatorPresent: !!window.__getEmulator?.(),
        saveEnabled: !document.getElementById("btnSave")?.disabled,
        stopEnabled: !document.getElementById("btnStop")?.disabled,
        canvasVisible: (() => {
          const canvas = document.querySelector("#screen_container canvas");
          return !!canvas && getComputedStyle(canvas).display !== "none";
        })(),
        textScreen: (() => {
          const text = document.querySelector("#screen_container > div")?.textContent || "";
          return text.trim().slice(-1000);
        })()
      }))()`);
      if (state.status === "Running" &&
          state.emulatorPresent &&
          state.overlayHidden &&
          /login:|welcome to alpine/i.test(state.textScreen)) break;
      if (state.statusText === "Engine missing" || state.statusText === "Error") break;
    }

    console.log("Boot state:", JSON.stringify(state));
    console.log("Findings:", JSON.stringify(findings));

    assert(state, "No VM boot state was captured");
    assert.equal(state.status, "Running");
    assert.equal(state.emulatorPresent, true);
    assert.equal(state.overlayHidden, true);
    assert.equal(state.saveEnabled, true);
    assert.equal(state.stopEnabled, true);
    assert(
      /login:|welcome to alpine/i.test(state.textScreen),
      "Alpine did not reach a login-ready screen"
    );
    assert.deepEqual(findings.exceptions, []);
    assert.deepEqual(findings.failedRequests, []);
    assert.deepEqual(findings.httpErrors, []);

    await evaluate(`document.getElementById("btnDesktop").click()`);
    await sleep(300);
    await evaluate(`document.getElementById("d-snap").click()`);
    await sleep(300);
    const desktop = await evaluate(`(() => {
      const snapshot = document.querySelector('.win[data-app="snapshots"]');
      const rect = snapshot?.getBoundingClientRect();
      const firefox = document.querySelector('.win[data-app="firefox"]');
      return {
        desktopOpen: document.getElementById("desktop")?.classList.contains("on"),
        terminalOpen: !!document.querySelector('.win[data-app="terminal"]'),
        firefoxOpen: !!firefox,
        firefoxDockIcon: !!document.querySelector('#d-dock .app[data-app="firefox"]'),
        screenParent: document.getElementById("screen_container")?.parentElement?.id,
        snapshotOpen: !!snapshot,
        snapshotRight: rect?.right,
        snapshotBottom: rect?.bottom,
        viewportWidth: innerWidth,
        viewportHeight: innerHeight
      };
    })()`);
    console.log("Desktop state:", JSON.stringify(desktop));
    assert.equal(desktop.desktopOpen, true);
    assert.equal(desktop.terminalOpen, true);
    assert.equal(desktop.firefoxOpen, false);
    assert.equal(desktop.firefoxDockIcon, true);
    assert.equal(desktop.screenParent, "term-vm-host");
    assert.equal(desktop.snapshotOpen, true);
    assert(desktop.snapshotRight <= desktop.viewportWidth);
    assert(desktop.snapshotBottom <= desktop.viewportHeight);

    console.log("live browser smoke checks passed");
    ws.close();
  } catch (error) {
    console.error(error.stack || error);
    console.error("Findings:", JSON.stringify(findings));
    ws.close();
    process.exitCode = 1;
  }
};
