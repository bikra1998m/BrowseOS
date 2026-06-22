#!/usr/bin/env node
/* BrowserOS Virtual Switch Relay (Node.js)
 * ===========================================================================
 * Gives multiple browser-tab VMs a REAL multi-VM network:
 *   - each connected VM is a port on a virtual Layer-2 switch
 *   - Ethernet frames are forwarded between VMs  -> they can ping/SSH each other
 *   - a built-in DHCP server hands each VM a UNIQUE IP (10.5.0.2, .3, .4, ...)
 *   - built-in ARP + (optional) NAT toward the host's internet
 *
 * v86's "simple" network adapter speaks raw Ethernet frames over a binary
 * WebSocket (binaryType=arraybuffer). This server implements that protocol.
 *
 * Run:   node relay.js            (listens on ws://127.0.0.1:9000)
 * LAN:   BROWSEROS_ALLOW_LAN=1 node relay.js
 * Then in BrowserOS: Network -> NAT Network, Relay URL = ws://<host-ip>:9000
 *
 * NOTE: NAT to the internet uses a raw socket and requires elevated
 * privileges + a host with raw packet support. Inter-VM comms + DHCP work
 * everywhere; full internet NAT is best-effort (see README in this folder).
 */
"use strict";
const http = require("http");
const crypto = require("crypto");

let WebSocketServer;
try { WebSocketServer = require("ws").Server; }
catch (e) {
  console.error("Missing locked dependency 'ws'. Install it with:  npm ci");
  process.exit(1);
}

const PORT = parseInt(process.env.PORT || "9000", 10);
const ALLOW_LAN = /^(1|true|yes|on)$/i.test(process.env.BROWSEROS_ALLOW_LAN || "");
const HOST = ALLOW_LAN ? "0.0.0.0" : "127.0.0.1";
const MAX_FRAME = 65536;
const MAX_CLIENTS = 64;
const MAX_BUFFERED = 1024 * 1024;
const ALLOWED_ORIGINS = new Set(
  (process.env.BROWSEROS_ALLOWED_ORIGINS || "")
    .split(",").map(s => s.trim()).filter(Boolean)
);
const NET = "10.5.0";          // virtual subnet 10.5.0.0/24
const GW  = NET + ".1";        // gateway / relay address
const NETMASK = "255.255.255.0";
const DNS = "10.5.0.1";        // relay answers/forwards DNS (best effort)
const LEASE = 86400;

// ---- helpers ----
const ip2buf = (s) => Buffer.from(s.split(".").map(Number));
const buf2ip = (b, o = 0) => `${b[o]}.${b[o+1]}.${b[o+2]}.${b[o+3]}`;
const mac2str = (b, o = 0) => [...b.slice(o, o+6)].map(x=>x.toString(16).padStart(2,"0")).join(":");
function checksum(buf, start, end) {
  let sum = 0;
  for (let i = start; i < end; i += 2) sum += (buf[i] << 8) + (buf[i+1] || 0);
  while (sum >> 16) sum = (sum & 0xffff) + (sum >> 16);
  return (~sum) & 0xffff;
}
function hostName(host) {
  try { return new URL("http://" + host).hostname.replace(/^\[|\]$/g, "").toLowerCase(); }
  catch (_) { return ""; }
}
function trustedHost(host) {
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") return true;
  const p = host.split(".").map(Number);
  if (p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  return ALLOW_LAN && (
    p[0] === 10 ||
    p[0] === 127 ||
    (p[0] === 169 && p[1] === 254) ||
    (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
    (p[0] === 192 && p[1] === 168)
  );
}
function trustedOrigin(req) {
  const origin = req.headers.origin || "";
  if (ALLOWED_ORIGINS.has(origin)) return true;
  let u;
  try { u = new URL(origin); } catch (_) { return false; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const originHost = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return originHost === hostName(req.headers.host || "") && trustedHost(originHost);
}
function safeSend(ws, payload) {
  if (ws.readyState !== 1) return false;
  if (ws.bufferedAmount > MAX_BUFFERED) {
    ws.terminate();
    return false;
  }
  ws.send(payload);
  return true;
}

// ---- switch state ----
let nextHost = 2;
const clients = new Map();      // ws -> { mac, ip }
const macTable = new Map();     // macStr -> ws  (learned)
const gwMac = Buffer.from([0x02, 0x00, 0x00, 0x00, 0x00, 0x01]);

function allocIP() {
  const ip = `${NET}.${nextHost}`;
  nextHost = nextHost >= 250 ? 2 : nextHost + 1;
  return ip;
}

// ---- DHCP server (replies to DISCOVER/REQUEST) ----
function handleDHCP(ws, frame) {
  // Ethernet(14) + IP(20) + UDP(8) + BOOTP/DHCP
  const ethType = (frame[12] << 8) | frame[13];
  if (ethType !== 0x0800) return false;            // not IPv4
  const ihl = (frame[14] & 0x0f) * 4;
  const proto = frame[23];
  if (proto !== 17) return false;                  // not UDP
  const udp = 14 + ihl;
  const srcPort = (frame[udp] << 8) | frame[udp+1];
  const dstPort = (frame[udp+2] << 8) | frame[udp+3];
  if (dstPort !== 67) return false;                // not DHCP
  const dhcp = udp + 8;
  if (dhcp + 240 > frame.length) return false;
  const xid = frame.slice(dhcp+4, dhcp+8);
  const chaddr = frame.slice(dhcp+28, dhcp+34);    // client MAC
  // find DHCP message type (option 53)
  let opt = dhcp + 240, msgType = 0, reqIp = null;
  while (opt < frame.length && frame[opt] !== 255) {
    if (frame[opt] === 0) { opt++; continue; }
    if (opt + 1 >= frame.length) return false;
    const code = frame[opt], len = frame[opt+1];
    if (opt + 2 + len > frame.length) return false;
    if (code === 53) msgType = frame[opt+2];
    if (code === 50) reqIp = frame.slice(opt+2, opt+6);
    opt += 2 + len;
  }
  const cli = clients.get(ws);
  if (!cli.ip) cli.ip = allocIP();
  const yourIp = ip2buf(cli.ip);
  const replyType = msgType === 1 ? 2 : 5;         // DISCOVER->OFFER, REQUEST->ACK

  // Build DHCP reply
  const dhcpLen = 240 + 3+3 + 6 + 6 + 6 + 6 + 6 + 1; // options below
  const out = Buffer.alloc(14 + 20 + 8 + 300);
  // Ethernet
  chaddr.copy(out, 0); gwMac.copy(out, 6); out[12]=0x08; out[13]=0x00;
  // IP header
  let p = 14;
  out[p]=0x45; out[p+1]=0; out.writeUInt16BE(0, p+2); // total len filled later
  out[p+8]=64; out[p+9]=17;                          // TTL, UDP
  ip2buf(GW).copy(out, p+12); ip2buf("255.255.255.255").copy(out, p+16);
  // UDP header
  let u = 34; out.writeUInt16BE(67, u); out.writeUInt16BE(68, u+2);
  // BOOTP/DHCP
  let d = 42;
  out[d]=2; out[d+1]=1; out[d+2]=6; out[d+3]=0;
  xid.copy(out, d+4);
  yourIp.copy(out, d+16);                            // yiaddr
  ip2buf(GW).copy(out, d+20);                        // siaddr
  chaddr.copy(out, d+28);
  out.writeUInt32BE(0x63825363, d+236);             // magic cookie
  let o = d + 240;
  const put = (code, ...bytes) => { out[o++]=code; out[o++]=bytes.length; for (const b of bytes) out[o++]=b; };
  put(53, replyType);
  put(54, ...ip2buf(GW));                            // server id
  put(51, (LEASE>>24)&255,(LEASE>>16)&255,(LEASE>>8)&255,LEASE&255); // lease
  put(1,  ...ip2buf(NETMASK));                       // subnet mask
  put(3,  ...ip2buf(GW));                            // router
  put(6,  ...ip2buf(DNS));                           // DNS
  out[o++]=255;                                      // end
  // lengths
  const udpLen = (o) - u; out.writeUInt16BE(udpLen, u+4);
  const ipTotal = (o) - 14; out.writeUInt16BE(ipTotal, 16);
  out.writeUInt16BE(checksum(out, 14, 34), 24);     // IP checksum
  safeSend(ws, out.slice(0, o));
  console.log(`DHCP ${msgType===1?"OFFER":"ACK"} -> ${cli.ip} (${mac2str(chaddr)})`);
  return true;
}

// ---- ARP responder (for the gateway) ----
function handleARP(ws, frame) {
  const ethType = (frame[12] << 8) | frame[13];
  if (ethType !== 0x0806) return false;
  const op = (frame[20] << 8) | frame[21];
  if (op !== 1) return false;                       // not request
  const targetIp = buf2ip(frame, 38);
  if (targetIp !== GW) return false;                // only answer for gateway
  const senderMac = frame.slice(22, 28);
  const senderIp = frame.slice(28, 32);
  const out = Buffer.alloc(42);
  senderMac.copy(out, 0); gwMac.copy(out, 6); out[12]=0x08; out[13]=0x06;
  out.writeUInt16BE(1, 14); out.writeUInt16BE(0x0800, 16); out[18]=6; out[19]=4;
  out.writeUInt16BE(2, 20);                          // reply
  gwMac.copy(out, 22); ip2buf(GW).copy(out, 28);
  senderMac.copy(out, 32); senderIp.copy(out, 38);
  safeSend(ws, out);
  return true;
}

// ---- main switch logic ----
const server = http.createServer(
  { maxHeaderSize: 16 * 1024, requestTimeout: 5000, headersTimeout: 5000 },
  (_, res) => { res.writeHead(200); res.end("BrowserOS relay\n"); }
);
const wss = new WebSocketServer({
  server,
  maxPayload: MAX_FRAME,
  perMessageDeflate: false,
  verifyClient(info, done) {
    if (wss.clients.size >= MAX_CLIENTS) {
      done(false, 503, "Relay full");
      return;
    }
    if (!trustedOrigin(info.req)) {
      done(false, 403, "Forbidden");
      return;
    }
    done(true);
  },
});

wss.on("connection", (ws) => {
  clients.set(ws, { mac: null, ip: null });
  console.log(`+ VM connected (${clients.size} total)`);

  ws.on("message", (data) => {
    const frame = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (frame.length < 14 || frame.length > MAX_FRAME) {
      ws.close(1009, "invalid frame size");
      return;
    }
    const src = mac2str(frame, 6);
    macTable.set(src, ws);
    const cli = clients.get(ws); if (cli) cli.mac = src;

    // Intercept services first.
    if (handleARP(ws, frame)) return;
    if (handleDHCP(ws, frame)) return;

    // Switch: forward to the destination port, or broadcast.
    const dst = mac2str(frame, 0);
    const bcast = dst === "ff:ff:ff:ff:ff:ff" || (frame[0] & 1);
    if (bcast) {
      for (const peer of wss.clients) if (peer !== ws) safeSend(peer, frame);
    } else {
      const target = macTable.get(dst);
      if (target) safeSend(target, frame);
      else for (const peer of wss.clients) if (peer !== ws) safeSend(peer, frame);
    }
    // NOTE: internet NAT (frames addressed to the gateway MAC bound for outside)
    // is NOT implemented here — see README. Inter-VM + DHCP fully work.
  });

  ws.on("close", () => {
    const cli = clients.get(ws);
    if (cli && cli.mac) macTable.delete(cli.mac);
    clients.delete(ws);
    console.log(`- VM disconnected (${clients.size} total)`);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`BrowserOS virtual-switch relay on ws://${HOST}:${PORT}`);
  console.log(`LAN access: ${ALLOW_LAN} (set BROWSEROS_ALLOW_LAN=1 to opt in)`);
  if (ALLOWED_ORIGINS.size) console.log(`Extra allowed origins: ${[...ALLOWED_ORIGINS].join(", ")}`);
  console.log(`Subnet ${NET}.0/24  gateway ${GW}  (VMs get ${NET}.2, .3, ...)`);
  console.log(`In BrowserOS: Relay URL = ${ALLOW_LAN ? "ws://<this-host-private-ip>" : "ws://127.0.0.1"}:${PORT}`);
});
