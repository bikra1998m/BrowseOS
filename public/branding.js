/* ============================================================
 *  BRANDING — edit this file to white-label BrowserOS.
 *  Everything below feeds the UI (title, colors, logo, etc.).
 *  No build step needed; just change values and reload.
 * ============================================================ */
window.BRANDING = {
  // --- Identity ---------------------------------------------------------
  productName: "BrowserOS",                 // shown in the top bar & title
  tagline:     "Real Linux • runs in your browser",
  companyName: "Your Company",              // shown in the About panel/footer
  supportUrl:  "https://example.com",       // "Help" / about link

  // --- Logo -------------------------------------------------------------
  // Use the generated PNG, or set to "" to fall back to the CSS gradient mark.
  logoSrc: "logo.png",

  // --- Theme (a clean, professional corporate palette) ------------------
  // Override any of these; they are injected as CSS variables.
  theme: {
    "--bg":      "#0c1018",
    "--panel":   "#121826",
    "--panel2":  "#19212f",
    "--border":  "#26304a",
    "--text":    "#eaf0f7",
    "--muted":   "#94a2bd",
    "--accent":  "#3ea6ff",   // primary brand color
    "--accent2": "#34e0a1",   // secondary accent
    "--danger":  "#ff5d6c",
  },

  // --- Boot behavior ----------------------------------------------------
  // Auto-open the live boot log viewer on every boot (watch the kernel boot).
  // Set to false to keep it collapsed until the user clicks "Show logs".
  autoShowLogs: true,

  // --- Boot screen copy -------------------------------------------------
  bootHeadline: "",            // "" → uses productName
  bootBody: "Press Boot to start a real Linux machine inside your browser. " +
            "Your files and changes are saved locally — no server, no install.",
};
