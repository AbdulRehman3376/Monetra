(() => {
  "use strict";

  /* ---------- Helpers ---------- */
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const money = (v) => "Rs. " + (Number(v) || 0).toLocaleString("en-PK", { maximumFractionDigits: 2 });
  const moneyR = (v) => "Rs. " + Math.round(Number(v) || 0).toLocaleString("en-PK");
  const icon = (name, cls = "") => `<svg class="i ${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;

  const listeners = {};
  const on = (e, f) => (listeners[e] = listeners[e] || []).push(f);
  const emit = (e, p) => (listeners[e] || []).forEach((f) => { try { f(p); } catch (err) { console.error(err); } });

  /* ---------- Toast & sheet ---------- */
  let toastTimer;
  function toast(message, type = "") {
    const el = $("#toast");
    el.textContent = message;
    el.className = `toast show ${type}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.className = "toast"; }, 2800);
  }
  const sheetRoot = $("#sheetRoot");
  const sheetBody = $("#sheetBody");
  let sheetToken = 0;
  let sheetClose = null;
  let confirmResolve = null;
  function openSheet(html, opts = {}) {
    sheetToken++;
    sheetBody.innerHTML = html;
    sheetClose = opts.onClose || null;
    sheetRoot.hidden = false;
    requestAnimationFrame(() => requestAnimationFrame(() => sheetRoot.classList.add("is-open")));
    $("#sheet").scrollTop = 0;
    const focus = $("[autofocus]", sheetBody);
    if (focus) setTimeout(() => focus.focus(), 320);
  }
  function closeSheet() {
    if (sheetRoot.hidden) return;
    const cb = sheetClose; sheetClose = null;
    sheetRoot.classList.remove("is-open");
    const token = ++sheetToken;
    setTimeout(() => { if (token === sheetToken) { sheetRoot.hidden = true; sheetBody.innerHTML = ""; } }, 280);
    if (cb) cb();
  }
  function confirmSheet({ title, message, confirmLabel = "Confirm", danger = true }) {
    return new Promise((resolve) => {
      confirmResolve = resolve;
      openSheet(`
        <h2>${esc(title)}</h2>
        <p class="sheet-sub">${esc(message)}</p>
        <div class="sheet-actions">
          <button class="btn ghost" type="button" data-action="sheet-close">Cancel</button>
          <button class="btn ${danger ? "danger" : "primary"}" type="button" data-action="confirm-yes">${esc(confirmLabel)}</button>
        </div>`, { onClose: () => { if (confirmResolve) { const r = confirmResolve; confirmResolve = null; r(false); } } });
    });
  }

  /* ---------- Navigation ---------- */
  const TABS = ["home", "budget", "diary", "udhaar"];
  let currentTab = "home";
  function route() {
    const tab = location.hash.replace(/^#\/?/, "").split("/")[0];
    const name = TABS.includes(tab) ? tab : "home";
    currentTab = name;
    $$(".screen").forEach((s) => s.classList.toggle("is-active", s.dataset.screen === name));
    $$(".tab").forEach((t) => { if (t.dataset.to === name) t.setAttribute("aria-current", "page"); else t.removeAttribute("aria-current"); });
    emit("screen", name);
  }
  const go = (to) => { location.hash = "#/" + to; };

  /* ---------- Home ---------- */
  const snap = () => (window.BB && BB.budget ? BB.budget.snapshot() : { hasBudget: false, perMeal: 0 });
  function greeting() {
    const h = new Date().getHours();
    return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
  }
  function renderHome() {
    const s = snap();
    let hero;
    if (s.hasBudget) {
      const pct = s.foodBudget > 0 ? Math.min(100, (s.spentTotal / s.foodBudget) * 100) : 0;
      hero = `<section class="hero-card" aria-label="Budget summary">
        <div class="hero-row"><div><span class="lbl">Food money left</span><strong class="amt ${s.remaining < 0 ? "neg" : ""}">${moneyR(s.remaining)}</strong></div>
        <button class="hero-go" type="button" data-action="go" data-to="budget" aria-label="Open budget">${icon("next")}</button></div>
        <div class="bar ${s.remaining < 0 ? "over" : ""}"><i style="width:${pct}%"></i></div>
        <div class="hero-stats"><div><span>Daily target</span><b>${moneyR(s.dailyTarget)}</b></div><div><span>Per meal</span><b>${moneyR(s.perMeal)}</b></div><div><span>Spent today</span><b>${moneyR(s.todaySpent)}</b></div></div>
        <p class="hero-hint">${s.daysLeft} of ${s.daysInMonth} days left this month. You can spend about <b>${moneyR(s.dailyLeft)}</b> a day for the rest of it. Daily target = food budget \u00f7 days it covers. Per meal = daily target \u00f7 meals per day.</p>
      </section>`;
    } else {
      hero = `<section class="hero-card"><div class="hero-empty"><div class="ring">${icon("wallet")}</div><div><h2>Set your food budget</h2><p>Know your daily and per-meal limit.</p></div></div>
        <button class="btn lime block" type="button" data-action="go" data-to="budget" style="margin-top:16px">Set up budget</button></section>`;
    }

    const chart = BB.budget && BB.budget.flowChart ? BB.budget.flowChart("home") : "";

    const meals = BB.budget ? BB.budget.todayMeals() : [];
    const rows = meals.map((m) => `<div class="meal"><span class="tile" aria-hidden="true">${m.category === "Other" ? "\u{1F9FE}" : "\u{1F37D}\uFE0F"}</span><div class="meal-main"><strong>${esc(m.name)}</strong><small>${m.category === "Other" ? "Other expense" : "Meal"}</small></div><b>${moneyR(m.price)}</b></div>`).join("");
    const today = `<div class="section"><div class="section-head"><h2>Today</h2><button class="link" type="button" data-action="go" data-to="diary">Open diary</button></div>
      <section class="card">${rows || `<p class="hint" style="text-align:center;padding:6px 0 12px">Nothing added today yet.</p>`}
        <div class="btn-pair"><button class="btn primary" type="button" data-action="b-add-meal">${icon("plus")}Add meal</button><button class="btn ghost" type="button" data-action="b-add-other">Other expense</button></div></section></div>`;

    $("#homeRoot").innerHTML = `<div class="home-top">
        <div class="brand-row"><div class="brand"><img src="./monetra-logo.svg" alt=""><div class="wordmark">MONETRA</div></div></div>
        <p class="greet">${greeting()}</p><h1>How is your food budget today?</h1></div>
      <div class="home-body">${hero}${chart}${today}</div>`;
  }

  /* ---------- Actions ---------- */
  const actions = {
    go: (el) => { if (el.dataset.to === currentTab) { const s = $(".screen.is-active .scroll"); if (s) s.scrollTo({ top: 0, behavior: "smooth" }); } closeSheet(); go(el.dataset.to); },
    "sheet-close": () => closeSheet(),
    "confirm-yes": () => { const r = confirmResolve; confirmResolve = null; sheetClose = null; closeSheet(); if (r) r(true); }
  };
  document.addEventListener("click", (e) => {
    const el = e.target.closest("[data-action]");
    if (!el) return;
    const fn = actions[el.dataset.action] || (window.BB && BB.actions && BB.actions[el.dataset.action]);
    if (fn) fn(el, e);
  });
  document.addEventListener("submit", (e) => {
    const form = e.target.closest("form[data-form]");
    if (!form) return;
    e.preventDefault();
    const handler = (BB.forms || {})[form.dataset.form];
    if (handler) handler(form);
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeSheet(); });

  /* ---------- Public API for budget.js ---------- */
  window.BB = Object.assign(window.BB || {}, { $, $$, esc, money, moneyR, icon, on, emit, toast, openSheet, closeSheet, confirmSheet, go, actions: {}, forms: {} });

  /* ---------- Boot ---------- */
  on("budget", renderHome);
  window.addEventListener("hashchange", route);
  /* Always start on Home, even after a refresh or when the app is opened again. */
  try { history.replaceState(null, "", location.pathname + location.search); } catch (_) { location.hash = ""; }
  /* Coming back to the app after being away for a while also lands on Home. */
  let hiddenAt = 0;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") { hiddenAt = Date.now(); return; }
    if (hiddenAt && Date.now() - hiddenAt > 30000 && currentTab !== "home") { closeSheet(); go("home"); }
    hiddenAt = 0;
  });
  renderHome();
  route();
  setTimeout(() => {
    const splash = $("#splash");
    if (!splash) return;
    splash.classList.add("is-hidden");
    setTimeout(() => splash.remove(), 450);
  }, 1900);
})();