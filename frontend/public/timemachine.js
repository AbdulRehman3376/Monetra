(() => {
  "use strict";
  /*
    Financial Time Machine
    - A graph of your balance and daily money in/out for any month (same numbers as the dashboard).
    - Tap a day on the graph, or pick a date: see that day's balance, loans, and every transaction.
    - "What if not?" shows the balance as if one transaction never happened.
    Nothing is stored here. Everything is rebuilt from your budget and loan data.
  */
  const BB = window.BB;
  if (!BB) return;
  const { esc, money, toast } = BB;
  const sheetOpen = () => !!(BB.$ && BB.$("#sheetBody .tm-root") && !BB.$("#sheetRoot").hidden);
  /* Redraw in place: keep the sheet scrolled where it was. */
  const openSheet = (html) => {
    const sheet = BB.$("#sheet"), keep = sheetOpen() && sheet ? sheet.scrollTop : 0;
    BB.openSheet(`<div class="gx tm-root">${html}</div>`);
    if (keep && sheet) sheet.scrollTop = keep;
  };

  const ENTRY_PREFIX = "udhaar-entry-";     // id prefix of a loan entry in the budget
  const PAY_PREFIX = "udhaar-payment-";     // id prefix of a loan repayment in the budget

  /* ---------- Small helpers ---------- */
  const pad = (v) => String(v).padStart(2, "0");
  const num = (v) => Number(v) || 0;
  const todayKey = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const shiftDays = (key, days) => {
    const [y, m, d] = key.split("-").map(Number);
    const dt = new Date(y, m - 1, d - days);
    return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
  };
  const niceDay = (key) => {
    const [y, m, d] = key.split("-").map(Number);
    return new Date(y, m - 1, d).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  };
  const addMonth = (mk, d) => { const [y, m] = mk.split("-").map(Number); const dt = new Date(y, m - 1 + d, 1); return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}`; };
  const daysIn = (mk) => { const [y, m] = mk.split("-").map(Number); return new Date(y, m, 0).getDate(); };
  const signed = (v) => (v >= 0 ? "+" : "-") + money(Math.abs(v));
  const mny = (v) => (v === null ? "Not set" : money(v));

  /* Budget data comes from budget.js (BB.budget.tm). */
  const tm = () => (BB.budget && BB.budget.tm) || null;
  const itemsOf = (t, mk) => t.items(mk).map((x) => ({ ...x, date: `${mk}-${pad(x.day)}` }));
  const loansState = () => (BB.udhaar && BB.udhaar._state && BB.udhaar._state()) || { people: [] };

  /* Balance at the end of a given day (null when no budget is saved yet). */
  function balanceOn(m, date) {
    if (!m.hasBudget) return null;
    return m.bal[Math.min(Number(date.slice(8, 10)), m.upTo)];
  }

  /* Open loans on a date: what people owe you and what you owe, optionally without one transaction. */
  function loansAt(date, excludedId) {
    const skipEntry = excludedId && excludedId.startsWith(ENTRY_PREFIX) ? excludedId.slice(ENTRY_PREFIX.length) : null;
    const skipPay = excludedId && excludedId.startsWith(PAY_PREFIX) ? excludedId.slice(PAY_PREFIX.length) : null;
    let receivable = 0, payable = 0;
    for (const p of loansState().people) {
      for (const e of p.entries || []) {
        if (!e.date || e.date > date || e.id === skipEntry) continue;
        const paid = (e.payments || []).filter((r) => r.date <= date && r.id !== skipPay).reduce((s, r) => s + num(r.amount), 0);
        const open = Math.max(0, num(e.amount) - paid);
        if (e.type === "gave") receivable += open; else payable += open;
      }
    }
    return { receivable, payable };
  }

  /* ---------- View state ---------- */
  let view = { date: todayKey(), without: null };

  function render() {
    const t = tm();
    if (!t) {
      openSheet(`<h2>Time Machine</h2><p class="hint">The budget is not ready yet. Open the Budget screen once, then try again.</p><div class="sheet-actions"><button class="btn ghost" type="button" data-action="sheet-close">Close</button></div>`);
      return;
    }
    const today = todayKey(), nowK = today.slice(0, 7);
    if (view.date > today) view.date = today;
    const date = view.date, mk = date.slice(0, 7), dayNum = Number(date.slice(8, 10));
    const m = t.compute(mk);
    const mNow = mk === nowK ? m : t.compute(nowK);
    const balThen = balanceOn(m, date);
    const balNow = mNow.hasBudget ? mNow.closing : null;
    const loansThen = loansAt(date, null);
    const idx = Math.min(dayNum, m.upTo);
    const dayChange = m.hasBudget && idx >= 1 ? m.bal[idx] - m.bal[idx - 1] : null;

    const all = itemsOf(t, mk).concat(itemsOf(t, addMonth(mk, -1)));
    const dayItems = all.filter((e) => e.date === date);
    const winStart = shiftDays(date, 30);
    const movers = all.filter((e) => e.date > winStart && e.date < date).sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount)).slice(0, 5);

    const evRow = (ev) => `<div class="row" style="align-items:center;gap:10px"><span>${esc(ev.label)}<br><small class="hint">${esc(niceDay(ev.date))}</small></span><span style="display:flex;align-items:center;gap:8px;flex:0 0 auto"><b>${signed(ev.amount)}</b><button class="btn ghost" type="button" data-action="tm-what" data-id="${esc(ev.id)}" style="height:32px;font-size:12px;padding:0 10px">What if not?</button></span></div>`;

    /* Counterfactual: same date, one transaction removed from history */
    let whatIf = "";
    if (view.without) {
      const ev = all.find((e) => e.id === view.without);
      if (ev) {
        const happened = ev.date <= date;
        const altThen = balThen === null ? null : balThen - (happened ? ev.amount : 0);
        const altNow = balNow === null ? null : balNow - ev.amount;
        const la = loansAt(date, ev.id);
        whatIf = `<div class="card">
          <b>If "${esc(ev.label)}" (${signed(ev.amount)}, ${esc(niceDay(ev.date))}) never happened</b>
          ${happened ? `<div class="row"><span>Balance on ${esc(niceDay(date))}</span><b>${mny(altThen)} <small class="hint">(was ${mny(balThen)})</small></b></div>
          <div class="row"><span>People owe you</span><b>${money(la.receivable)} <small class="hint">(was ${money(loansThen.receivable)})</small></b></div>
          <div class="row"><span>You owe people</span><b>${money(la.payable)} <small class="hint">(was ${money(loansThen.payable)})</small></b></div>` : `<p class="hint">This happened after the selected day, so that day would not change.</p>`}
          <div class="row"><span>Balance today</span><b>${mny(altNow)} <small class="hint">(is ${mny(balNow)})</small></b></div>
          ${ev.date.slice(0, 7) !== nowK ? `<p class="hint">Today's number is approximate for an older month, because unspent money carries over.</p>` : ""}
          <button class="btn ghost" type="button" data-action="tm-clear" style="margin-top:8px">Clear</button></div>`;
      }
    }

    /* The button that matches the chosen date glows (lime). The others stay plain. */
    const quick = [[7, "7 days ago"], [30, "30 days ago"], [0, "Today"]].map(([d, label]) => {
      const on = date === shiftDays(today, d);
      return `<button class="btn ${on ? "primary" : "ghost"}" type="button" data-action="tm-jump" data-days="${d}" aria-pressed="${on}">${label}</button>`;
    }).join("");

    const flowCard = (BB.budget && BB.budget.flowChart && BB.budget.flowChart("tm")) || `<p class="hint">Save your budget to see the graph.</p>`;
    openSheet(`<h2>Time Machine</h2>
      <p class="sheet-sub">Pick a date. The dashboard graph opens on that day.</p>
      <label class="field"><span>Date</span><input id="tmDate" type="date" value="${esc(date)}" max="${today}"></label>
      <div class="btn-pair" style="margin:8px 0">${quick}</div>
      <h3>${esc(niceDay(date))}</h3>
      <div class="row"><span>Balance</span><b>${mny(balThen)}</b></div>
      <div class="row"><span>Change that day</span><b>${dayChange === null ? "-" : Math.abs(dayChange) < 0.005 ? "No change" : signed(dayChange)}</b></div>
      <div class="row"><span>People owed you</span><b>${money(loansThen.receivable)}</b></div>
      <div class="row"><span>You owed people</span><b>${money(loansThen.payable)}</b></div>
      <div class="row"><span>Balance change since then</span><b>${balThen === null || balNow === null ? "-" : signed(balNow - balThen)}</b></div>
      ${whatIf}
      <h3>What happened on this day</h3>
      ${dayItems.length ? dayItems.map(evRow).join("") : `<p class="hint">No transactions on this day.</p>`}
      <h3>Biggest changes in the 30 days before</h3>
      ${movers.length ? movers.map(evRow).join("") : `<p class="hint">Nothing found in that period.</p>`}
      <div class="sheet-actions"><button class="btn ghost" type="button" data-action="sheet-close">Close</button></div>`);
  }

  /* ---------- Actions ---------- */
  /* One date drives both this screen and the dashboard graph. */
  let syncing = false;
  function goTo(date) {
    view = { date: date > todayKey() ? todayKey() : date, without: null };
    const f = BB.budget && BB.budget.flowState;
    syncing = true;
    try { if (f) f.setPick(view.date.slice(0, 7), Number(view.date.slice(8, 10))); } finally { syncing = false; }
    render();
  }
  /* Pick a day, close this sheet and show that day on the dashboard graph. */
  function goHome(date) {
    const d = date > todayKey() ? todayKey() : date;
    view = { date: d, without: null };
    const f = BB.budget && BB.budget.flowState;
    syncing = true;
    try { if (f) f.setPick(d.slice(0, 7), Number(d.slice(8, 10)), d < todayKey()); } finally { syncing = false; }
    syncing = true; setTimeout(() => { syncing = false; }, 800);
    if (BB.closeSheet) BB.closeSheet();
    const tab = document.querySelector('.tab[data-to="home"]');
    if (tab) tab.click();
    setTimeout(() => {
      try {
        const b = document.querySelector('#homeRoot [data-action="b-flow-month"]');
        const card = b && (b.closest("section") || b.closest(".card"));
        if (card) card.scrollIntoView({ block: "center", behavior: "smooth" });
      } catch (_) { /* ignore */ }
    }, 200);
  }
  Object.assign(BB.actions, {
    "tm-open": () => { const f = BB.budget && BB.budget.flowState; const fp = f && f.pick(); if (fp) { const d = `${fp.mk}-${pad(fp.day)}`; view = { date: d > todayKey() ? todayKey() : d, without: null }; } render(); },
    "tm-jump": (el) => goHome(shiftDays(todayKey(), Number(el.dataset.days) || 0)),
    "tm-what": (el) => { view.without = el.dataset.id; render(); },
    "tm-clear": () => { view.without = null; render(); }
  });

  /* The user tapped the graph or changed its month: follow it. */
  BB.on("budget", () => {
    if (syncing || !sheetOpen()) return;
    const f = BB.budget && BB.budget.flowState;
    if (!f) return;
    const fp = f.pick(), today = todayKey();
    let d = view.date;
    if (fp) d = `${fp.mk}-${pad(fp.day)}`;
    else {
      const mk = f.month();
      if (mk !== d.slice(0, 7)) d = mk === today.slice(0, 7) ? today : `${mk}-${pad(daysIn(mk))}`;
    }
    view.date = d > today ? today : d;
    render();
  });

  /* The date picker fires a "change" event, not a click. */
  document.addEventListener("change", (e) => {
    const t = e.target;
    if (!t || t.id !== "tmDate") return;
    const v = String(t.value || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return toast("Pick a valid date.", "error");
    goHome(v);
  });

  /* Card shown on the Loans screen. */
  function cardHtml() {
    return `<section class="card" id="timeMachineCard" style="margin-bottom:14px">
      <h2>Time Machine</h2>
      <p class="hint">See your balance graph, pick any day, and find what changed your money.</p>
      <div class="btn-pair" style="margin-top:14px"><button class="btn primary" type="button" data-action="tm-open">Open</button></div>
    </section>`;
  }

  BB.timeMachine = { cardHtml };
  /* Redraw Loans once, because udhaar.js drew itself before this file loaded. */
  try { BB.udhaar && BB.udhaar.render && BB.udhaar.render(); } catch (_) { /* ignore */ }
})();