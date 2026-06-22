/* Keeps the single v86 screen node safe while the UI moves it between views. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.BrowserOSScreenDock = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  function create(doc, screenId = "screen_container") {
    let screen = null;
    let home = null;
    let marker = null;

    function capture() {
      if (screen && home && marker) return true;
      screen = doc.getElementById(screenId);
      if (!screen || !screen.parentNode) return false;
      home = screen.parentNode;
      marker = doc.createComment("BrowserOS VM screen home");
      home.insertBefore(marker, screen);
      return true;
    }

    function attach(host) {
      if (!host || !capture()) return false;
      if (!host.contains(screen)) host.appendChild(screen);
      return true;
    }

    function restore() {
      if (!capture()) return false;
      if (screen.parentNode !== home) {
        home.insertBefore(screen, marker.nextSibling);
      }
      return true;
    }

    function location() {
      if (!capture()) return "missing";
      return screen.parentNode === home ? "home" : "attached";
    }

    return { capture, attach, restore, location };
  }

  return { create };
});
