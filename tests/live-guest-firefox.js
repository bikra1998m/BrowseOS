#!/usr/bin/env node
"use strict";

const assert = require("assert");
const fs = require("fs");

const debuggerUrl = process.argv[2];
const timeoutMs = Number(process.env.BROWSEROS_FIREFOX_TIMEOUT_MS || 2100000);
if (!debuggerUrl) {
  console.error("Usage: node tests/live-guest-firefox.js <webSocketDebuggerUrl>");
  process.exit(2);
}

const ws = new WebSocket(debuggerUrl);
let nextId = 1;
const pending = new Map();
const findings = [];

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject, method });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

function evaluate(expression) {
  return send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
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

function vmState() {
  return evaluate(`(() => {
    const canvas = document.querySelector("#screen_container canvas");
    const text = document.querySelector("#screen_container > div")?.textContent || "";
    return {
      status: document.getElementById("sStatus")?.textContent,
      emulatorPresent: !!window.__getEmulator?.(),
      desktopOpen: document.getElementById("desktop")?.classList.contains("on"),
      firefoxWindow: !!document.querySelector('.win[data-app="firefox"]'),
      screenParent: document.getElementById("screen_container")?.parentElement?.id,
      canvasVisible: !!canvas && getComputedStyle(canvas).display !== "none",
      centerPixel: (() => {
        if (!canvas || getComputedStyle(canvas).display === "none") return null;
        try {
          return Array.from(
            canvas.getContext("2d").getImageData(
              Math.floor(canvas.width * 0.75),
              Math.floor(canvas.height * 0.7),
              1,
              1
            ).data
          );
        } catch (_) {
          return null;
        }
      })(),
      textScreen: text.trim().slice(-1800)
    };
  })()`);
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
  if (message.method === "Runtime.exceptionThrown") {
    findings.push(message.params.exceptionDetails?.text || "Uncaught exception");
  }
  if (message.method === "Runtime.consoleAPICalled" &&
      ["error", "assert"].includes(message.params.type)) {
    findings.push(
      (message.params.args || []).map((arg) => arg.value || arg.description || "").join(" ")
    );
  }
};

ws.onerror = () => {
  console.error("Chrome debugging WebSocket failed");
  process.exit(1);
};

ws.onopen = async () => {
  try {
    await Promise.all([send("Runtime.enable"), send("Page.enable")]);
    await sleep(500);
    let state = await vmState();
    if (!state.emulatorPresent) {
      await evaluate(`document.getElementById("btnStart").click()`);
    }

    let deadline = Date.now() + 300000;
    if (!(state.canvasVisible && state.firefoxWindow)) {
      while (Date.now() < deadline) {
        await sleep(2000);
        state = await vmState();
        if (/login:/i.test(state.textScreen)) break;
      }
      assert(/login:/i.test(state.textScreen), "Alpine did not reach its login prompt");
    }

    await evaluate(`document.getElementById("btnDesktop").click()`);
    await sleep(300);
    await evaluate(`document.querySelector('#d-dock .app[data-app="firefox"]').click()`);

    deadline = Date.now() + timeoutMs;
    let nextReport = 0;
    while (Date.now() < deadline) {
      await sleep(3000);
      state = await vmState();
      if (Date.now() >= nextReport) {
        console.log("Firefox guest state:", JSON.stringify(state));
        nextReport = Date.now() + 30000;
      }
      if (state.canvasVisible &&
          state.screenParent === "firefox-vm-host" &&
          state.centerPixel &&
          state.centerPixel[0] + state.centerPixel[1] + state.centerPixel[2] > 200) break;
      if (/No space left on device|Fatal server error|Permission denied|unable to select packages/i.test(state.textScreen)) {
        break;
      }
      if (/ERROR:|failed|not found/i.test(state.textScreen.slice(-500))) {
        console.log("Guest reported a possible error; continuing until timeout.");
      }
    }

    assert(state.canvasVisible, "Firefox/Xorg never switched to graphical VGA mode");
    assert(
      state.centerPixel &&
      state.centerPixel[0] + state.centerPixel[1] + state.centerPixel[2] > 200,
      "Firefox never rendered its browser surface"
    );

    await evaluate(`(async () => {
      const emulator = window.__getEmulator();
      emulator.keyboard_set_enabled?.(true);
      await emulator.keyboard_send_scancodes([0x1d, 0x26, 0xa6, 0x9d], 80);
      await new Promise(resolve => setTimeout(resolve, 10000));
      await emulator.keyboard_send_text(
        "data:text/html,<body bgcolor=lime>",
        200
      );
      await new Promise(resolve => setTimeout(resolve, 2000));
      await emulator.keyboard_send_text("\\n", 300);
    })()`);

    deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      await sleep(3000);
      state = await vmState();
      const pixel = state.centerPixel || [];
      if (pixel[0] < 100 && pixel[1] > 180 && pixel[2] < 100) break;
    }

    const screenshot = await send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(".firefox-guest-test.png", Buffer.from(screenshot.data, "base64"));
    console.log("Final Firefox guest state:", JSON.stringify(state));
    console.log("Findings:", JSON.stringify(findings));
    assert.equal(state.desktopOpen, true);
    assert.equal(state.firefoxWindow, true);
    assert.equal(state.screenParent, "firefox-vm-host");
    assert(
      state.centerPixel &&
      state.centerPixel[0] < 100 &&
      state.centerPixel[1] > 180 &&
      state.centerPixel[2] < 100,
      "Firefox did not accept keyboard navigation inside the VM"
    );
    assert.deepEqual(findings, []);
    console.log("live guest Firefox checks passed");
    ws.close();
  } catch (error) {
    console.error(error.stack || error);
    console.error("Findings:", JSON.stringify(findings));
    ws.close();
    process.exitCode = 1;
  }
};
