(() => {
  "use strict";
  /* Keeps every money number inside its box. */
  const css = `
    .hero-row > div:first-child, .chart-title { min-width: 0; flex: 1 1 0; }
    .hero-stats > div, .ov-grid > div, .mini-stats > div, .mw-main > div, .mw-grid > div { min-width: 0; }
    .row { min-width: 0; gap: 10px; }
    .row > span { min-width: 0; flex: 1 1 auto; overflow-wrap: anywhere; }
    .row > b { min-width: 0; flex: 0 1 auto; max-width: 62%; text-align: right; overflow-wrap: anywhere; }
    .fit-one { display: block; max-width: 100%; overflow: hidden; white-space: nowrap !important; }
    .row > b.fit-one { display: block; }
  `;
  const style = document.createElement("style");
  style.id = "fit-numbers-css";
  style.textContent = css;
  document.head.appendChild(style);

  const SEL = ".amt, .chart-amt, .hero-stats b, .ov-grid b, .mini-stats b, .mw-main b, .mw-grid b, .row > b";
  const SMALL = ".hero-stats b, .mini-stats b, .ov-grid b, .mw-main b, .mw-grid b";

  /* "Rs. 10,000,000" becomes "Rs. 10M". Used only when the full number cannot stay readable. */
  function compact(text) {
    const m = /^(\D*?)(\d[\d,]*(?:\.\d+)?)(\D*)$/.exec(text.trim());
    if (!m) return null;
    const v = parseFloat(m[2].replace(/,/g, ""));
    if (!isFinite(v) || v < 10000) return null;
    const units = [[1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "K"]];
    const [div, sym] = units.find(([d]) => v >= d);
    const short = (v / div).toFixed(2).replace(/\.?0+$/, "");
    return m[1] + short + sym + m[3];
  }

  function fit(el) {
    el.style.fontSize = "";
    if (el.dataset.full) { el.textContent = el.dataset.full; delete el.dataset.full; el.removeAttribute("title"); }
    if (el.children.length) { el.classList.remove("fit-one"); return; }
    el.classList.add("fit-one");
    const base = parseFloat(getComputedStyle(el).fontSize) || 14;
    const over = () => el.scrollWidth > el.clientWidth + 0.5;
    const shrink = (to) => { let size = base, g = 0; el.style.fontSize = ""; while (over() && size > to && g++ < 80) { size -= 0.5; el.style.fontSize = size + "px"; } };

    shrink(Math.max(11, base * 0.6));
    if (!over()) return;
    if (el.matches(SMALL)) {
      const full = el.textContent, short = compact(full);
      if (short) {
        el.dataset.full = full; el.title = full; el.textContent = short;
        shrink(Math.max(9, base * 0.6));
        return;
      }
    }
    shrink(Math.max(9, base * 0.4));
  }

  let queued = false;
  const observer = new MutationObserver(() => run());
  const watch = () => observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["class", "hidden"] });
  function run() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      observer.disconnect();
      try { document.querySelectorAll(SEL).forEach(fit); } finally { watch(); }
    });
  }

  watch();
  window.addEventListener("resize", run);
  window.addEventListener("hashchange", run);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(run);
  run();
})();