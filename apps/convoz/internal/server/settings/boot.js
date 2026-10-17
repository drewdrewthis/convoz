// Sets the look of the app before the first paint. A classic script in <head>: it blocks parsing for a moment so no frame is
// painted in the wrong colours. The web app keeps the same three values in localStorage under "convoz.appearance"
// (apps/web/src/features/settings/appearance.ts); the choice of theme and text size is the device's own, the palette is
// the owner's, cached here from the last sync. "system" follows the OS scheme, also while the page is open.
(function () {
  var root = document.documentElement;
  var light = matchMedia("(prefers-color-scheme: light)");
  function read() {
    try { return JSON.parse(localStorage.getItem("convoz.appearance") || "{}") || {}; } catch (e) { return {}; }
  }
  function word(v, fallback) { return typeof v === "string" && /^[a-z]{1,12}$/.test(v) ? v : fallback; }
  function paint() {
    var s = read(), theme = word(s.theme, "system");
    root.dataset.mode = theme === "light" || theme === "dark" ? theme : "system"; // CSS follows the OS itself while it is "system"
    root.dataset.theme = theme === "light" || theme === "dark" ? theme : light.matches ? "light" : "dark";
    root.dataset.palette = word(s.palette, "iris");
    root.dataset.textSize = word(s.text_size, "m");
  }
  paint();
  light.addEventListener("change", paint);
  addEventListener("convoz-appearance", paint); // the app changed a choice
})();
