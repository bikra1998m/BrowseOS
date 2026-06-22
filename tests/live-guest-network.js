#!/usr/bin/env node
"use strict";

const assert = require("assert");

const debuggerUrl = process.argv[2];
const relayUrl = process.env.BROWSEROS_TEST_RELAY || "";
const attachMode = process.env.BROWSEROS_TEST_ATTACH || "nat";
const expectedPrefix = process.env.BROWSEROS_EXPECT_IP_PREFIX || "";
const timeoutMs = Number(process.env.BROWSEROS_NETWORK_TIMEOUT_MS || 420000);
if (!debuggerUrl) {
  console.error("Usage: node tests/live-guest-network.js <webSocketDebuggerUrl>");
  process.exit(2);
}

const ws = new WebSocket(debuggerUrl);
let nextId = 1;
const pending = new Map();

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
      throw new Error(
        result.exceptionDetails.exception?.description ||
        result.exceptionDetails.text ||
        "Evaluation failed"
      );
    }
    return result.result.value;
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function screenText() {
  return evaluate(`(() => {
    const text = document.querySelector("#screen_container > div")?.textContent || "";
    return text.trim().slice(-5000);
  })()`);
}

ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (!message.id) return;
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  if (message.error) request.reject(new Error(`${request.method}: ${message.error.message}`));
  else request.resolve(message.result || {});
};

ws.onerror = () => {
  console.error("Browser debugging WebSocket failed");
  process.exit(1);
};

ws.onopen = async () => {
  try {
    await Promise.all([send("Runtime.enable"), send("Page.enable")]);

    await evaluate(`(() => {
      localStorage.setItem("browseros-netcfg", JSON.stringify({
        enabled: true,
        attach: ${JSON.stringify(attachMode)},
        name: ${JSON.stringify(relayUrl)},
        type: "virtio",
        promisc: "deny",
        mac: "",
        mtu: "",
        cable: true,
        portfwd: []
      }));
      localStorage.setItem("browseros-os", "alpine9p");
      return true;
    })()`);
    const origin = await evaluate("location.origin");
    await send("Page.navigate", {
      url: `${origin}/?vm=network-smoke-${Date.now()}`,
    });
    let appReady = false;
    const appDeadline = Date.now() + 30000;
    while (Date.now() < appDeadline) {
      await sleep(500);
      appReady = await evaluate(
        `document.readyState === "complete" && typeof resolveDefaultInternetUrl === "function"`
      ).catch(() => false);
      if (appReady) break;
    }
    assert(appReady, "BrowserOS app did not finish loading");
    const networkConfig = await evaluate(`(async () => {
      const opts = {};
      await applyNetwork(opts);
      return {
        backend: opts.net_device.relay_url,
        instance: window.__browserOSInstance,
        device: opts.net_device
      };
    })()`);
    const selectedBackend = networkConfig.backend;
    const expectedIP = networkConfig.device.vm_ip;
    console.log("Selected guest network backend:", selectedBackend);
    if (attachMode === "nat") {
      console.log("Expected stable guest IP:", expectedIP);
      assert.equal(expectedIP, networkConfig.instance.natIP);
    }
    const ipCheck = expectedIP
      ? `ip -4 addr show dev eth0 | grep -q 'inet ${expectedIP}/'`
      : expectedPrefix
        ? `ip -4 addr show dev eth0 | grep -q 'inet ${expectedPrefix}'`
        : "ip -4 addr show dev eth0 | grep -q 'inet '";
    const guestCommand =
      "echo NET_BEGIN; ip -4 addr show dev eth0; ip route; " +
      "nslookup dl-cdn.alpinelinux.org; " +
      "wget -T 30 -O /dev/null https://dl-cdn.alpinelinux.org/alpine/v3.24/main/x86/APKINDEX.tar.gz " +
      "&& printf 'HTTPS_%s\\n' OK || printf 'HTTPS_%s\\n' FAIL; " +
      ipCheck + " && printf 'IP_%s\\n' OK || printf 'IP_%s\\n' FAIL; " +
      "printf 'NET_%s\\n' DONE\n";
    await evaluate(`document.getElementById("btnStart").click()`);

    let text = "";
    let deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(2000);
      text = await screenText();
      if (/login:/i.test(text)) break;
    }
    assert(/login:/i.test(text), "Alpine did not reach its login prompt");

    await evaluate(`(async () => {
      const emulator = window.__getEmulator();
      emulator.keyboard_set_enabled?.(true);
      await emulator.keyboard_send_text("root\\n", 40);
      await new Promise(resolve => setTimeout(resolve, 2500));
      await emulator.keyboard_send_text(${JSON.stringify(guestCommand)}, 8);
    })()`);

    deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      await sleep(2000);
      text = await screenText();
      if (/NET_DONE/.test(text)) break;
    }

    console.log(text);
    assert(/NET_DONE/.test(text), "Guest network command timed out");
    assert(/IP_OK/.test(text), "Guest did not receive an IPv4 address");
    const backend = attachMode === "bridged"
      ? "the launcher's host-LAN bridge"
      : relayUrl || "the launcher's automatic NAT backend";
    assert(/HTTPS_OK/.test(text), `Guest HTTPS failed through ${backend}`);
    assert(!/HTTPS_FAIL/.test(text), `Guest HTTPS failed through ${backend}`);
    console.log(`live guest network checks passed through ${backend}`);
    ws.close();
  } catch (error) {
    console.error(error.stack || error);
    ws.close();
    process.exitCode = 1;
  }
};
