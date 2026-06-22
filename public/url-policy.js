/* BrowserOS URL policy helpers.
 * Keep navigation targets out of executable or embedded-data URL schemes.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.BrowserOSURLPolicy = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function externalLink(value, base) {
    if (typeof value !== "string" || !value.trim()) return "";
    try {
      const url = new URL(value, base || "http://localhost/");
      return ["http:", "https:", "mailto:"].includes(url.protocol) ? url.href : "";
    } catch (_) {
      return "";
    }
  }

  return { externalLink };
});
