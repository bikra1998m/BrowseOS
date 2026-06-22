/* Load the versioned v86 engine URL from the generated asset manifest. */
(function () {
  "use strict";

  window.BrowserOSEngineReady = new Promise((resolve, reject) => {
    const assets = window.BROWSEROS_ASSETS;
    if (!assets || !assets.libv86) {
      reject(new Error("BrowserOS asset manifest is missing the v86 engine URL"));
      return;
    }

    const script = document.createElement("script");
    script.src = assets.libv86;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Could not load the v86 engine"));
    document.head.appendChild(script);
  });
  // Mark early network failures as observed; boot() still awaits the original
  // promise and presents the user-facing engine error when they press Boot.
  window.BrowserOSEngineReady.catch(() => {});
})();
