/* BrowserOS page bootstrap: desktop toggle + hosted service-worker lifecycle. */
(function () {
  "use strict";

  const desktopButton = document.getElementById("btnDesktop");
  if (desktopButton) {
    desktopButton.onclick = function () {
      if (window.BrowserOSDesktop) window.BrowserOSDesktop.show();
    };
  }

  // Service workers are useful for hosted deployments, but local launchers are
  // already offline and should never be trapped behind a stale cached UI.
  const host = location.hostname;
  const isLocal = host === "localhost" || host === "127.0.0.1" || host === "" ||
                  host === "0.0.0.0" || host.endsWith(".local");
  if (!("serviceWorker" in navigator)) return;

  if (isLocal || !location.protocol.startsWith("http")) {
    navigator.serviceWorker.getRegistrations().then((registrations) => {
      let hadRegistration = false;
      registrations.forEach((registration) => {
        registration.unregister();
        hadRegistration = true;
      });
      if (window.caches) {
        caches.keys().then((keys) => keys.forEach((key) => caches.delete(key)));
      }
      if (hadRegistration) console.info("[BrowserOS] Disabled service worker for local use.");
    }).catch(() => {});
    return;
  }

  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").then((registration) => {
      registration.update();
      registration.addEventListener("updatefound", () => {
        const worker = registration.installing;
        if (!worker) return;
        worker.addEventListener("statechange", () => {
          if (worker.state === "installed" && navigator.serviceWorker.controller) {
            worker.postMessage("skipWaiting");
          }
        });
      });
    }).catch(() => {});

    let reloaded = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (reloaded) return;
      reloaded = true;
      location.reload();
    });
  });
})();
