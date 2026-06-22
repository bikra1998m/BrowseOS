/* Serializes expensive v86 state captures and schedules conservative autosaves. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.BrowserOSSaveCoordinator = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  function create(options) {
    const now = options.now || Date.now;
    const setTimer = options.setTimer || setTimeout;
    const clearTimer = options.clearTimer || clearTimeout;
    const intervalMs = options.intervalMs || 5 * 60 * 1000;
    const lifecycleMinAgeMs = options.lifecycleMinAgeMs || 2 * 60 * 1000;
    const canAutosave = options.canAutosave || (() => true);

    let captureInFlight = null;
    let saveInFlight = null;
    let saveSnapshot = null;
    let timer = null;
    let running = false;
    let lastSavedAt = 0;

    function capture() {
      if (saveSnapshot) return Promise.resolve(saveSnapshot);
      if (captureInFlight) return captureInFlight;
      captureInFlight = Promise.resolve()
        .then(() => options.capture())
        .finally(() => { captureInFlight = null; });
      return captureInFlight;
    }

    function save(reason = "manual") {
      if (saveInFlight) return saveInFlight;
      options.onSaveStart?.(reason);
      saveInFlight = capture()
        .then((state) => {
          saveSnapshot = state;
          return options.persist(state, reason);
        })
        .then(() => {
          lastSavedAt = now();
          options.onSaveSuccess?.(reason, lastSavedAt);
          return { savedAt: lastSavedAt, reason };
        })
        .catch((error) => {
          options.onSaveError?.(reason, error);
          throw error;
        })
        .finally(() => {
          saveSnapshot = null;
          saveInFlight = null;
          options.onSaveEnd?.(reason);
        });
      return saveInFlight;
    }

    function schedule() {
      if (timer) clearTimer(timer);
      timer = null;
      if (!running || !canAutosave()) return;
      timer = setTimer(async () => {
        timer = null;
        try { await save("auto"); } catch (_) {}
        schedule();
      }, intervalMs);
    }

    function start() {
      if (running) return;
      running = true;
      // Avoid an immediate lifecycle snapshot right after boot.
      lastSavedAt = now();
      schedule();
    }

    function stop() {
      running = false;
      if (timer) clearTimer(timer);
      timer = null;
    }

    function lifecycle() {
      if (!running || !canAutosave()) return Promise.resolve({ skipped: true });
      if (now() - lastSavedAt < lifecycleMinAgeMs) {
        return Promise.resolve({ skipped: true });
      }
      return save("lifecycle");
    }

    function status() {
      return {
        running,
        capturing: !!captureInFlight,
        saving: !!saveInFlight,
        lastSavedAt,
      };
    }

    function idle() {
      return saveInFlight || captureInFlight || Promise.resolve();
    }

    return { capture, save, start, stop, lifecycle, idle, status };
  }

  return { create };
});
