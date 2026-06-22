"use strict";

const assert = require("assert");
const { create } = require("../public/screen-dock.js");

class Node {
  constructor(name) {
    this.name = name;
    this.parentNode = null;
    this.childNodes = [];
  }
  get nextSibling() {
    if (!this.parentNode) return null;
    const i = this.parentNode.childNodes.indexOf(this);
    return this.parentNode.childNodes[i + 1] || null;
  }
  appendChild(node) {
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this;
    this.childNodes.push(node);
    return node;
  }
  insertBefore(node, before) {
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this;
    const i = before ? this.childNodes.indexOf(before) : -1;
    if (i < 0) this.childNodes.push(node);
    else this.childNodes.splice(i, 0, node);
    return node;
  }
  removeChild(node) {
    const i = this.childNodes.indexOf(node);
    if (i >= 0) this.childNodes.splice(i, 1);
    node.parentNode = null;
  }
  contains(node) {
    return node === this || this.childNodes.some((child) => child.contains(node));
  }
}

const home = new Node("home");
const screen = new Node("screen_container");
const terminalHost = new Node("term-vm-host");
home.appendChild(screen);

const doc = {
  getElementById(id) {
    return id === "screen_container" ? screen : null;
  },
  createComment(text) {
    return new Node("#comment:" + text);
  },
};

const dock = create(doc);
assert.equal(dock.capture(), true);
assert.equal(dock.location(), "home");

assert.equal(dock.attach(terminalHost), true);
assert.equal(screen.parentNode, terminalHost);
assert.equal(dock.location(), "attached");

assert.equal(dock.restore(), true);
assert.equal(screen.parentNode, home);
assert.equal(dock.location(), "home");

assert.equal(dock.attach(terminalHost), true);
assert.equal(dock.restore(), true);
assert.equal(home.childNodes.filter((n) => n === screen).length, 1);

console.log("screen dock lifecycle checks passed");
