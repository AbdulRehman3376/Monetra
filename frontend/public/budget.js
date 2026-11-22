(() => {
  "use strict";
  const BB = window.BB;
  const Native = window.BudgetNative || null;
  if (!BB) return;
  const { $, esc, moneyR, icon, toast, openSheet, closeSheet, confirmSheet } = BB;
  const tile = (cat) => `<span class="tile" aria-hidden="true">${cat === "Other" ? "\u{1F9FE}" : "\u{1F37D}\uFE0F"}</span>`;

  /* ---------- Profile & storage (same keys as before, so saved data is kept) ---------- */
  const PROFILE_KEY = "budgetbite_profile_id_v1";
  const PROFILE = (() => {
    let id = localStorage.getItem(PROFILE_KEY);
    if (!id) {
      id = window.crypto && typeof window.crypto.randomUUID === "function" ? window.crypto.randomUUID() : `student-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
      localStorage.setItem(PROFILE_KEY, id);
    }
    return id;
  })();
  const STORE_KEY = `budgetbite_budget_fallback_v3_${PROFILE}`;
  const FIXED = ["Room rent", "Electricity", "Water", "Internet", "Transport", "Study expenses", "Other essentials"];
  const today = new Date();
  const pad = (x) => String(x).padStart(2, "0");
  const dateKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const defaultState = () => ({ month: dateKey(today).slice(0, 7), startBudget: null, addedFunds: 0, mealsPerDay: 3, fixed: {}, records: {}, budgetLocked: false, periodMode: "month", periodStartDate: "", periodEndDate: "", budgetStartDate: "", goals: [], transfers: [], external: [] });
  let state = defaultState();
  let selectedDate = dateKey(today);
  let loaded = false;
  const n = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.min(Number(v), 1e8) : 0);
  const uid = (p) => `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  /* ---------- Month helpers ---------- */
  const monthOf = (key) => String(key).slice(0, 7);
  const daysInMonthKey = (m) => new Date(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0).getDate();
  const addMonthKey = (m, k) => { const d = new Date(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1 + k, 1); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; };
  const nextMonthKey = (m) => addMonthKey(m, 1);
  const monthLabel = (m) => new Date(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1, 1).toLocaleDateString("en-GB", { month: "short", year: "numeric" });
  const monthRange = (a, b) => { const out = []; let m = a, g = 0; while (m <= b && g++ < 600) { out.push(m); m = nextMonthKey(m); } return out; };
  const monthsBetween = (a, b) => (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + (Number(b.slice(5, 7)) - Number(a.slice(5, 7)));
  const thisMonthKey = () => monthOf(dateKey(new Date()));
  /* First day of month m that the budget covers. A budget entered on the 20th covers the 20th to the end of that month. */
  const startDayOf = (m) => {
    const bs = state.budgetStartDate;
    if (bs && monthOf(bs) === m) return Math.min(daysInMonthKey(m), Number(String(bs).slice(8, 10)) || 1);
    if (!bs && !state.budgetLocked && m === thisMonthKey()) return new Date().getDate();
    return 1;
  };
  /* Days the budget covers in month m: real length of that month minus the days before the start day. */
  const daysForMonth = (m) => Math.max(1, daysInMonthKey(m) - startDayOf(m) + 1);

  /* ---------- Calculations ---------- */
  const isMonthMode = () => state.periodMode !== "custom";
  const totalAvailable = () => n(state.startBudget) + n(state.addedFunds);
  const fixedTotal = () => FIXED.reduce((s, c) => s + n(state.fixed[c]), 0);
  const foodBudget = () => Math.max(0, totalAvailable() - fixedTotal());
  const periodDays = () => {
    if (state.periodMode === "custom" && state.periodStartDate && state.periodEndDate) {
      const start = new Date(state.periodStartDate + "T00:00:00");
      const end = new Date(state.periodEndDate + "T00:00:00");
      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) return 1;
      return Math.floor((end - start) / 86400000) + 1;
    }
    // Real days of the real current month, counted from the day the budget started (if that was this month).
    return daysForMonth(thisMonthKey());
  };
  const dailyTarget = () => foodBudget() / Math.max(1, periodDays());
  /* Daily target for any month shown on the Diary or graph (28/29, 30 or 31 real days). */
  const dailyTargetFor = (m) => (state.periodMode === "custom" ? dailyTarget() : foodBudget() / Math.max(1, daysForMonth(m)));
  const perMeal = () => dailyTarget() / Math.max(1, n(state.mealsPerDay) || 1);
  const recordsTotal = () => Object.values(state.records).reduce((s, r) => s + n(r.spent), 0);
  const spentInMonth = (m) => Object.keys(state.records).filter((k) => monthOf(k) === m).reduce((t, k) => t + n(state.records[k].spent), 0);

  /* ---------- Month budget, saved money and transfers (nothing resets by itself) ---------- */
  const transfers = () => (Array.isArray(state.transfers) ? state.transfers : []);
  const tIn = (m) => transfers().filter((t) => t.to === m).reduce((s, t) => s + n(t.amount), 0);
  const tOut = (m) => transfers().filter((t) => t.from === m).reduce((s, t) => s + n(t.amount), 0);
  const monthBase = () => foodBudget();
  const startMonthKey = () => {
    const first = Object.keys(state.records).sort()[0];
    return monthOf(state.budgetStartDate || first || dateKey(today));
  };

  /* ---------- Lend & Borrow budget adjustments ----------
     Each one is a signed amount on a date: money you lent (-), money received back (+),
     borrowed money you chose to add (+), repayments you chose to deduct (-).
     They are kept in state.external with the id of the ledger entry they came from. */
  const externals = () => (Array.isArray(state.external) ? state.external : []);
  const extSum = (list) => list.reduce((t, x) => t + (Number(x.amount) || 0), 0);
  /* Adjustments dated before the budget started count in the first budget month. */
  const extMonth = (x) => { const m = monthOf(x.date), s0 = startMonthKey(); return m < s0 ? s0 : m; };
  const extDay = (x, mk) => (monthOf(x.date) === mk ? Number(String(x.date).slice(8, 10)) || 1 : 1);
  const extIn = (m) => extSum(externals().filter((x) => extMonth(x) === m));
  const extNet = () => extSum(externals());
  const extBefore = (m) => extSum(externals().filter((x) => extMonth(x) < m));

  /* Unspent money of every finished month before month "upto", added together (minus what the user moved elsewhere). */
  const carryInto = (upto) => {
    if (!isMonthMode() || !state.budgetLocked || dailyTarget() <= 0) return 0;
    let m = startMonthKey(), total = 0, guard = 0;
    while (m < upto && guard++ < 240) {
      total = Math.max(0, total + monthBase(m) + tIn(m) - tOut(m) + extIn(m) - spentInMonth(m));
      m = nextMonthKey(m);
    }
    return total;
  };
  const carryOver = () => carryInto(thisMonthKey());
  const thisMonthAvailable = () => monthBase(thisMonthKey()) + carryOver() + tIn(thisMonthKey()) - tOut(thisMonthKey()) + extIn(thisMonthKey()) - spentInMonth(thisMonthKey());
  const monthPool = () => monthBase(thisMonthKey()) + carryOver() + tIn(thisMonthKey()) - tOut(thisMonthKey()) + extIn(thisMonthKey());
  const loanReceived = () => { if (!(BB.udhaar && BB.udhaar.totals)) return 0; const t = BB.udhaar.totals(); return Math.round((t.budgetIn - t.budgetOut) * 100) / 100; };
  const periodSpent = () => (isMonthMode() ? spentInMonth(thisMonthKey()) : recordsTotal());
  const remaining = () => (isMonthMode() ? thisMonthAvailable() : foodBudget() - recordsTotal() + extNet());
  const daysLeftThisMonth = () => Math.max(1, daysInMonthKey(thisMonthKey()) - new Date().getDate() + 1);
  const daysThisMonth = () => daysInMonthKey(thisMonthKey());
  /* How much of a month's money can still be moved to another month. */
  const transferable = (m) => {
    const cur = thisMonthKey();
    if (m === cur) return Math.max(0, thisMonthAvailable());
    if (m > cur) return 0;
    return Math.min(Math.max(0, monthBase(m) + tIn(m) - tOut(m) + extIn(m) - spentInMonth(m)), Math.max(0, thisMonthAvailable()));
  };

  /* ---------- Installment goals (save for an expensive item over N months) ---------- */
  const goals = () => (Array.isArray(state.goals) ? state.goals : []);
  const goalStart = (g) => g.startMonth || thisMonthKey();
  const goalElapsed = (g) => Math.max(0, monthsBetween(goalStart(g), thisMonthKey()));
  const goalFinish = (g) => addMonthKey(goalStart(g), Math.max(0, n(g.months) - 1));
  const goalMonthsLeft = (g) => Math.max(1, n(g.months) - goalElapsed(g));
  const goalLeft = (g) => Math.max(0, n(g.price) - n(g.saved));
  const goalSavedThisMonth = (g) => n((g.savedByMonth || {})[thisMonthKey()]);
  /* Monthly amount stays steady during the month: (price - saved before this month) / months left. */
  const goalMonthly = (g) => Math.max(0, n(g.price) - (n(g.saved) - goalSavedThisMonth(g))) / goalMonthsLeft(g);
  const goalOverdue = (g) => goalLeft(g) > 0 && thisMonthKey() > goalFinish(g);
  const goalBehind = (g) => goalLeft(g) > 0 && !goalOverdue(g) &&
    (n(g.saved) - goalSavedThisMonth(g)) < (n(g.price) * Math.min(goalElapsed(g), n(g.months)) / Math.max(1, n(g.months))) - 0.5;
  const goalsMonthlyTotal = () => goals().filter((g) => goalLeft(g) > 0).reduce((t, g) => t + goalMonthly(g), 0);
  /* Still to be set aside THIS month for all goals. */
  const goalsDueThisMonth = () => goals().filter((g) => goalLeft(g) > 0).reduce((t, g) => t + Math.max(0, Math.ceil(goalMonthly(g)) - goalSavedThisMonth(g)), 0);
  const dailyWithCarry = () => Math.max(0, thisMonthAvailable()) / daysLeftThisMonth();
  const dailyAfterGoals = () => Math.max(0, thisMonthAvailable() - goalsDueThisMonth()) / daysLeftThisMonth();

  const goalCard = (g) => {
    const pct = n(g.price) > 0 ? Math.min(100, (n(g.saved) / n(g.price)) * 100) : 0;
    const done = goalLeft(g) <= 0;
    const badge = done ? ["Completed"] : goalOverdue(g) ? ["Overdue"] : goalBehind(g) ? ["Behind plan"] : ["On track"];
    const monthly = Math.ceil(goalMonthly(g));
    const need = done ? "Goal reached. You can buy it."
      : goalOverdue(g) ? `Deadline passed. Save <b>${moneyR(goalLeft(g))}</b> more to finish`
      : `Save <b>${moneyR(monthly)}</b> every month<br><small>This month: ${moneyR(goalSavedThisMonth(g))} of ${moneyR(monthly)} saved</small>`;
    return `<div class="goal"><div class="goal-top"><strong>${esc(g.name)} <small>· ${badge[0]}</small></strong><button class="x" type="button" data-action="b-goal-del" data-id="${esc(g.id)}" aria-label="Delete ${esc(g.name)}">${icon("close")}</button></div>
      <div class="bar"><i style="width:${pct}%"></i></div>
      <div class="goal-grid"><div><span>Total Price</span><b>${moneyR(g.price)}</b></div><div><span>Total Saved</span><b>${moneyR(g.saved)} <small>(${Math.round(pct)}%)</small></b></div><div><span>Remaining Balance</span><b>${moneyR(goalLeft(g))}</b></div><div><span>Months Remaining</span><b>${String(done ? 0 : goalMonthsLeft(g)).padStart(2, "0")}</b></div></div>
      <p class="hint" style="margin:6px 0 0">Plan: ${moneyR(Math.ceil(n(g.price) / Math.max(1, n(g.months))))} × ${n(g.months)} months · finish by ${esc(monthLabel(goalFinish(g)))}</p>
      <div class="goal-need ${done ? "ok" : ""}">${need}</div>
      ${done ? "" : `<button class="btn soft block" type="button" data-action="b-goal-fund" data-id="${esc(g.id)}" style="margin-top:8px">${icon("plus")}Add to savings</button>`}</div>`;
  };

  const goalsHtml = () => `
      <section class="card">
        <h2>Installments &amp; savings goals</h2>
        <p class="sub">Want something expensive? Choose the price and the number of months. We show how much to save every month.</p>
        ${goals().map(goalCard).join("") || `<p class="hint" style="text-align:center;padding:6px 0 10px">No goals yet.</p>`}
        ${goals().length ? `<div class="row"><span>Total to save each month</span><b>${moneyR(Math.ceil(goalsMonthlyTotal()))}</b></div><div class="row"><span>Still to set aside this month</span><b>${moneyR(goalsDueThisMonth())}</b></div>` : ""}
        <button class="btn primary block" type="button" data-action="b-goal-add" style="margin-top:10px">${icon("plus")}New installment goal</button>
      </section>
      ${isMonthMode() ? `<section class="card">
        <h2>Saved money &amp; month budgets</h2>
        <p class="sub">Whatever you do not spend in a month stays with you. You can also move saved money to any other month. Your budget never resets by itself.</p>
        <div class="row"><span>Saved from earlier months</span><b>${moneyR(carryOver())}</b></div>
        <div class="row"><span>Available this month<small>Month budget + savings + moved money − spent</small></span><b>${moneyR(thisMonthAvailable())}</b></div>
        <div class="row"><span>Days left this month<small>Today included, out of ${daysThisMonth()} days in ${esc(monthLabel(thisMonthKey()))}</small></span><b>${daysLeftThisMonth()}</b></div>
        <div class="row"><span>Daily target with savings<small>Available money \u00f7 days left</small></span><b>${moneyR(dailyWithCarry())}</b></div>
        ${goals().length ? `<div class="row total"><span>Daily target after goals<small>Keeps this month's goal savings aside</small></span><b>${moneyR(dailyAfterGoals())}</b></div>` : ""}
        ${state.budgetLocked ? `<button class="btn soft block" type="button" data-action="b-transfer-add" style="margin-top:10px">Move saved money to another month</button>` : ""}
        ${transfers().length ? `<h3>Moved money</h3>${transfers().slice().reverse().map((t) => `<div class="row"><span>${esc(monthLabel(t.from))} → ${esc(monthLabel(t.to))}</span><b>${moneyR(t.amount)} <button class="x" type="button" data-action="b-transfer-del" data-id="${esc(t.id)}" aria-label="Undo move">${icon("close")}</button></b></div>`).join("")}` : ""}
      </section>` : ""}`;

  const blank = () => ({ spent: 0, ate: false, items: [], meals: [], note: "", time: "" });
  const rec = (key = selectedDate) => state.records[key] || blank();
  /* A day = the typed food amount ("base") + every meal added on top of it. */
  const mealsSum = (r) => (r.meals || []).reduce((t, m) => t + n(m.price), 0);
  const baseOf = (r) => (r.base !== undefined && r.base !== null ? n(r.base) : Math.max(0, n(r.spent) - mealsSum(r)));
  const syncSpent = (r) => { r.base = baseOf(r); r.spent = r.base + mealsSum(r); };
  function ensureRecord(key = selectedDate) {
    if (!state.records[key]) state.records[key] = blank();
    const r = state.records[key];
    if (!Array.isArray(r.meals)) r.meals = [];
    if (!Array.isArray(r.items)) r.items = [];
    return r;
  }
  const snapshot = () => ({
    hasBudget: Boolean(state.budgetLocked && n(state.startBudget) > 0),
    foodBudget: foodBudget(), remaining: remaining(), spentTotal: periodSpent(),
    dailyTarget: dailyTarget(), dailyLeft: dailyWithCarry(), daysLeft: daysLeftThisMonth(), daysInMonth: daysThisMonth(), perMeal: perMeal(), todaySpent: n((state.records[dateKey(new Date())] || {}).spent)
  });

  /* ---------- Persistence (this device only, no server) ---------- */
  let saveTimer = null;
  function load() {
    try { state = { ...defaultState(), ...JSON.parse(localStorage.getItem(STORE_KEY) || "{}") }; } catch (_) { state = defaultState(); }
    loaded = true;
    /* SANITIZE_AMOUNTS: remove impossible amounts (above 1 billion) left by typing mistakes */
    try {
      const BIG = 1e9;
      state.external = (Array.isArray(state.external) ? state.external : []).filter((x) => Math.abs(Number(x.amount) || 0) <= BIG);
      for (const k of Object.keys(state.records || {})) {
        const r = state.records[k];
        if (!r) continue;
        const bad = Number(r.spent) > BIG || Number(r.base) > BIG || (r.meals || []).some((m) => Number(m.price) > BIG);
        if (!bad) continue;
        r.meals = (r.meals || []).filter((m) => Number(m.price) <= BIG);
        r.items = r.meals.map((m) => m.name);
        r.base = Number(r.base) <= BIG ? n(r.base) : 0;
        r.spent = r.base + mealsSum(r);
      }
      if (Number(state.addedFunds) > BIG) state.addedFunds = 0;
      if (Number(state.startBudget) > BIG) state.startBudget = 0;
      saveDraft();
    } catch (_) { /* ignore */ }
    renderAll();
    scheduleReminder();
  }
  function persist(rerender = true) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (_) { toast("Could not save on this device.", "error"); }
    if (rerender) renderAll(); else BB.emit("budget");
  }
  const saveDraft = () => { try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (_) { /* ignore */ } };
  function persistSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { persist(false); const el = $("#savedNote"); if (el) el.textContent = "Saved on this device"; }, 350);
  }

  /* ---------- Budget screen ---------- */
  function renderBudget() {
    const root = $("#budgetRoot");
    const locked = state.budgetLocked;
    const pool = isMonthMode() ? monthPool() : foodBudget();
    const spentPct = pool > 0 ? Math.min(100, (periodSpent() / pool) * 100) : 0;
    const notifOn = localStorage.getItem("budgetbite_native_reminder") === "on" || ("Notification" in window && Notification.permission === "granted");
    root.innerHTML = `
      <header class="screen-head" style="padding-left:0;padding-right:0">
        <div><p class="eyebrow">Student money planner</p><h1>Budget</h1></div>
        <span class="sync offline" id="syncPill">Saved on this device</span>
      </header>
      <section class="card overview">
        <span class="lbl">${isMonthMode() ? "Food money left this month" : "Food money left"}</span>
        <strong class="amt ${remaining() < 0 ? "neg" : ""}">${moneyR(remaining())}</strong>
        <div class="bar ${remaining() < 0 ? "over" : ""}"><i style="width:${spentPct}%"></i></div>
        <div class="ov-grid">
          <div><span>Total available</span><b>${moneyR(totalAvailable())}</b></div>
          <div><span>Essentials</span><b>${moneyR(fixedTotal())}</b></div>
          <div><span>Food budget</span><b>${moneyR(foodBudget())}</b></div>
          <div><span>${isMonthMode() ? "Spent this month" : "Spent in period"}</span><b>${moneyR(periodSpent())}</b></div>
          ${isMonthMode() ? `<div><span>Saved from earlier months</span><b>${moneyR(carryOver())}</b></div>
          <div><span>Available this month</span><b>${moneyR(thisMonthAvailable())}</b></div>` : ""}
          ${loanReceived() > 0.5 ? `<div class="t-in wide"><span>Loan money in your budget<small>Net: added minus repaid</small></span><b>+ ${moneyR(loanReceived())}</b></div>` : ""}
        </div>
      </section>

      <section class="card">
        <h2>Monthly plan</h2>
        <p class="sub">Your starting budget is locked once saved. You can add money later.</p>
        <div class="period-settings">
          <div class="field">
            <span>Budget period</span>
            <div class="seg" role="group" aria-label="Budget period">
              <button type="button" data-action="b-period" data-v="month" aria-pressed="${(state.periodMode || "month") === "month"}">1 month</button>
              <button type="button" data-action="b-period" data-v="custom" aria-pressed="${state.periodMode === "custom"}">Custom dates</button>
            </div>
          </div>
          ${state.periodMode === "custom" ? `
          <div class="field period-date-field">
            <span>Period start date</span>
            <input id="bPeriodStart" type="date" value="${esc(state.periodStartDate || "")}" aria-label="Custom budget period start date">
            <span>Period end date</span>
            <input id="bPeriodEnd" type="date" value="${esc(state.periodEndDate || "")}" min="${esc(state.periodStartDate || "")}" aria-label="Custom budget period end date">
            <small class="hint">Daily budget is calculated using both selected dates, including the start and end day.</small>
          </div>
          ` : `
          <p class="hint period-hint">Your budget uses one calendar month by default. Choose Custom dates to set a different period.</p>
          `}
        </div>
        <div class="row"><span>Starting budget<small>PKR</small></span>
          <input id="bStart" type="number" inputmode="numeric" min="1" step="100" placeholder="0" value="${state.startBudget === null ? "" : n(state.startBudget)}" ${locked ? "disabled" : ""} aria-label="Starting budget in rupees"></div>
        <div class="row" style="flex-direction:column;align-items:stretch"><span>Meals per day</span>
          <div class="seg" style="margin-top:8px">${[1, 2, 3].map((v) => `<button type="button" data-action="b-meals" data-v="${v}" aria-pressed="${Number(state.mealsPerDay) === v}" ${locked ? "disabled" : ""}>${v} meal${v > 1 ? "s" : ""}</button>`).join("")}</div></div>
        <div class="row"><span>Added funds<small>Extra money you received</small></span><b>${moneyR(state.addedFunds)}</b></div>
        <button class="btn soft block" type="button" data-action="b-add-funds" style="margin-top:10px">${icon("plus")}Add funds</button>
        <div class="mini-stats"><div><span>Daily food target</span><b>${moneyR(dailyTarget())}</b></div><div><span>Per meal</span><b>${moneyR(perMeal())}</b></div></div>
        <h3>Essential monthly expenses</h3>
        ${FIXED.map((c) => `<div class="row"><span>${esc(c)}</span><input type="number" inputmode="numeric" min="0" step="50" data-fixed="${esc(c)}" value="${n(state.fixed[c]) || ""}" placeholder="0" aria-label="${esc(c)} in rupees"></div>`).join("")}
        <button class="btn primary block" type="button" data-action="b-save" style="margin-top:16px">${locked ? "Save expense changes" : "Save and lock starting budget"}</button>
        ${locked ? `<div class="lock-note">${icon("lock")}<span>Starting budget is locked. Use “Add funds” to increase your available amount.</span></div>` : ""}
      </section>

      <section class="card">
        <h2>Expense receipt</h2>
        <p class="sub">A summary of where your money stands.</p>
        <div class="row"><span>Starting budget</span><b>${moneyR(state.startBudget)}</b></div>
        <div class="row"><span>Additional funds</span><b>${moneyR(state.addedFunds)}</b></div>
        <div class="row"><span>Essential expenses</span><b>${moneyR(fixedTotal())}</b></div>
        <div class="row"><span>${isMonthMode() ? "Food spending this month" : "Recorded food spending"}</span><b>${moneyR(periodSpent())}</b></div>
        ${Math.abs(extNet()) > 0.004 ? `<div class="row"><span>Lend &amp; Borrow adjustments<small>Money given, received back, borrowed or repaid that you counted in your budget</small></span><b>${extNet() > 0 ? "+" : "\u2212"}${moneyR(Math.abs(extNet()))}</b></div>` : ""}
        <div class="row total"><span>Remaining balance</span><b>${moneyR(remaining())}</b></div>
      </section>
${goalsHtml()}

      <section class="card" style="padding-top:6px;padding-bottom:6px">
        <button class="row-btn" type="button" data-action="b-export"><span class="ico">${icon("download")}</span><span style="flex:1">Export expense history<small>Download as CSV (opens in Excel)</small></span></button>
        <button class="row-btn" type="button" data-action="b-reminder"><span class="ico">${icon("bell")}</span><span style="flex:1">${notifOn ? "9:00 PM reminder is on" : "Enable 9:00 PM reminder"}<small>Daily reminder at 9:00 PM</small></span></button>
        <button class="row-btn danger" type="button" data-action="b-reset"><span class="ico">${icon("trash")}</span><span style="flex:1">Reset budget<small>Clears your budget and daily records (goals are kept)</small></span></button>
      </section>
      <p class="fine-print">Your budget is never reset automatically. Only “Reset budget” clears it.</p>`;
  }

  /* ---------- Diary screen ---------- */
  function renderDiary() {
    const root = $("#diaryRoot");
    const [y, m] = state.month.split("-").map(Number);
    const first = new Date(y, m - 1, 1);
    const days = new Date(y, m, 0).getDate();
    const lead = first.getDay();
    const target = dailyTargetFor(state.month);
    const cells = Array.from({ length: lead }, () => `<span class="day empty-cell"></span>`)
      .concat(Array.from({ length: days }, (_, i) => {
        const key = `${y}-${pad(m)}-${pad(i + 1)}`;
        const r = state.records[key];
        const over = r && target > 0 && n(r.spent) > target;
        const cls = ["day", key === dateKey(today) ? "today" : "", key === selectedDate ? "selected" : "", r ? "has" : "", over ? "over" : ""].join(" ");
        return `<button type="button" class="${cls}" data-action="b-day" data-date="${key}" aria-label="${key}${r ? `, spent ${moneyR(r.spent)}` : ""}" aria-pressed="${key === selectedDate}">${i + 1}${r ? "<i></i>" : ""}</button>`;
      })).join("");
    const r = rec();
    const sel = new Date(selectedDate + "T00:00:00");
    const spent = n(r.spent);
    let delta = "";
    if (target > 0 && state.budgetLocked) delta = spent > target ? `<span class="delta over">${moneyR(spent - target)} over your daily target</span>` : `<span class="delta ok">${moneyR(target - spent)} under your daily target</span>`;
    const meals = (r.meals || []).map((meal, idx) => {
      const cat = meal.category || "Food";
      return `<div class="meal">${tile(cat)}<div class="meal-main"><strong>${esc(meal.name)}</strong><small>${meal.category === "Other" ? "Other expense" : "Meal"}</small></div><b>${moneyR(meal.price)}</b>
        <button class="x" type="button" data-action="b-remove-meal" data-i="${idx}" aria-label="Remove ${esc(meal.name)}">${icon("close")}</button></div>`;
    }).join("");
    const legacy = !(r.meals || []).length && (r.items || []).length ? `<p class="hint" style="margin-bottom:6px">Meals noted: ${esc(r.items.join(", "))}</p>` : "";
    root.innerHTML = `
      <header class="screen-head" style="padding-left:0;padding-right:0">
        <div><p class="eyebrow">Daily tracker</p><h1>Diary</h1></div>
        <div class="month-nav"><button type="button" data-action="b-month" data-d="-1" aria-label="Previous month">${icon("back")}</button><strong>${first.toLocaleDateString("en-GB", { month: "long", year: "numeric" })}</strong><button type="button" data-action="b-month" data-d="1" aria-label="Next month">${icon("next")}</button></div>
      </header>
      <section class="card"><div class="cal">${["S", "M", "T", "W", "T", "F", "S"].map((d) => `<span class="wd">${d}</span>`).join("")}${cells}</div>
        <div class="legend"><span>Within target</span><span class="o">Over target</span></div></section>
      ${chartHtml("diary", state.month)}
      <section class="card">
        <div class="day-head"><h2>${sel.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })}</h2>${selectedDate === dateKey(new Date()) ? `<span class="tag verified">Today</span>` : ""}</div>
        <div class="day-total">${moneyR(spent)}</div>${delta}
        <div class="btn-pair"><button class="btn primary" type="button" data-action="b-add-meal">${icon("plus")}Add meal</button><button class="btn ghost" type="button" data-action="b-add-other">Other expense</button></div>
        ${legacy}${meals || (legacy ? "" : `<p class="hint" style="text-align:center;padding:6px 0 12px">No meals added for this day yet.</p>`)}
        <div class="field" style="margin-top:14px"><span>Total spent on food (PKR)</span><input id="dSpent" type="number" inputmode="decimal" min="0" step="10" value="${baseOf(r) || ""}" placeholder="0"><small class="hint">Meals you add above are counted on top of this amount.</small></div>
        <div class="field"><span>Note <i>optional</i></span><input id="dNote" maxlength="300" value="${esc(r.note || "")}" placeholder="e.g. breakfast and dinner"></div>
        <div class="switch-row"><span>I ate today</span><label class="switch"><input id="dAte" type="checkbox" ${r.ate ? "checked" : ""} aria-label="I ate today"><span></span></label></div>
        <p class="saved" id="savedNote"></p>
      </section>`;
  }

  /* ---------- Monthly spending graph ---------- */
  let chartMode = "daily";
  let chartPick = null; // { mk, day }
  const fmtK = (v) => { const a = Math.abs(v); if (!isFinite(a) || a >= 1e12) return ">1T"; const f = (x, s) => String(Math.round(x * 10) / 10).replace(/\.0$/, "") + s; return a >= 1e9 ? f(v / 1e9, "B") : a >= 1e6 ? f(v / 1e6, "M") : a >= 1e3 ? f(v / 1e3, "k") : String(Math.round(v)); };
  const niceMax = (v) => {
    if (!(v > 0)) return 100;
    const p = Math.pow(10, Math.floor(Math.log10(v))), f = v / p;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
  };
  const r1 = (v) => Math.round(v * 10) / 10;
  /* Smooth curve through points without overshooting (monotone cubic). */
  function smoothPath(pts) {
    const k = pts.length;
    if (!k) return "";
    if (k === 1) return `M${r1(pts[0][0])} ${r1(pts[0][1])}`;
    const dx = [], m = [], t = [];
    for (let i = 0; i < k - 1; i++) { dx[i] = pts[i + 1][0] - pts[i][0]; m[i] = (pts[i + 1][1] - pts[i][1]) / dx[i]; }
    t[0] = m[0]; t[k - 1] = m[k - 2];
    for (let i = 1; i < k - 1; i++) t[i] = m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2;
    for (let i = 0; i < k - 1; i++) {
      if (m[i] === 0) { t[i] = 0; t[i + 1] = 0; continue; }
      const a = t[i] / m[i], b = t[i + 1] / m[i], q = a * a + b * b;
      if (q > 9) { const c = 3 / Math.sqrt(q); t[i] = c * a * m[i]; t[i + 1] = c * b * m[i]; }
    }
    let d = `M${r1(pts[0][0])} ${r1(pts[0][1])}`;
    for (let i = 0; i < k - 1; i++) {
      const h = dx[i] / 3;
      d += ` C${r1(pts[i][0] + h)} ${r1(pts[i][1] + t[i] * h)} ${r1(pts[i + 1][0] - h)} ${r1(pts[i + 1][1] - t[i + 1] * h)} ${r1(pts[i + 1][0])} ${r1(pts[i + 1][1])}`;
    }
    return d;
  }
  const dayLabel = (mk, d) => new Date(Number(mk.slice(0, 4)), Number(mk.slice(5, 7)) - 1, d).toLocaleDateString("en-GB", { day: "numeric", month: "short" });

  function chartHtml(idp, mk = thisMonthKey()) {
    const days = daysInMonthKey(mk), nowK = thisMonthKey();
    const todayDay = mk === nowK ? new Date().getDate() : mk > nowK ? 0 : days;
    /* Last day of this month that has a saved record. Entries added for upcoming dates must show on the graph too. */
    const lastRecDay = Object.keys(state.records).reduce((mx, k) => (monthOf(k) === mk ? Math.max(mx, Number(k.slice(8, 10))) : mx), 0);
    const upTo = Math.min(days, Math.max(todayDay, lastRecDay));
    const asOf = upTo > todayDay ? dayLabel(mk, upTo) : "today";
    const target = state.budgetLocked ? dailyTargetFor(mk) : 0;
    const daily = Array.from({ length: upTo }, (_, i) => n((state.records[`${mk}-${pad(i + 1)}`] || {}).spent));
    let run = 0;
    const cum = daily.map((v) => (run += v));
    const total = run, est = target * upTo;
    const mode = chartMode;

    /* header numbers */
    let chip = "";
    if (est > 0 && total > 0) {
      const pc = Math.round(Math.abs(total - est) / est * 100);
      chip = total > est ? `<span class="chip over">\u2191 ${pc}% over estimate</span>` : `<span class="chip ok">\u2193 ${pc}% under estimate</span>`;
    }
    const sub = target > 0
      ? `Compared to ${moneyR(est)} estimated ${mk === nowK ? (upTo > todayDay ? "through " + dayLabel(mk, upTo) : "by today") : "for this month"}`
      : "Save your budget to see your daily estimate on the graph.";

    /* geometry */
    const W = 340, H = 206, L = 38, R = 10, T = 14, B = 28, pw = W - L - R, ph = H - T - B;
    const X = (d) => L + (days > 1 ? (d - 1) / (days - 1) : 0) * pw;
    const maxV = mode === "daily" ? Math.max(...daily, target, 0) * 1.12 : Math.max(total, target * days, 0) * 1.06;
    const yMax = niceMax(maxV);
    const Y = (v) => T + ph - (Math.min(v, yMax) / yMax) * ph;
    const base = Y(0), id = (s2) => `${idp}-${s2}`;

    let g = `<defs>
      <linearGradient id="${id("lo")}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#c8fb4c"/><stop offset="1" stop-color="#8fcf1a"/></linearGradient>
      <linearGradient id="${id("hi")}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffb15a"/><stop offset="1" stop-color="#ff4d3d"/></linearGradient>
      <linearGradient id="${id("alo")}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#c8fb4c" stop-opacity=".30"/><stop offset="1" stop-color="#c8fb4c" stop-opacity="0"/></linearGradient>
      <linearGradient id="${id("ahi")}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ff5b4a" stop-opacity=".42"/><stop offset="1" stop-color="#ffb15a" stop-opacity=".08"/></linearGradient>`;

    /* grid + axes */
    let grid = "";
    for (let i = 0; i <= 2; i++) {
      const v = (yMax / 2) * i, yy = Y(v);
      grid += `<line x1="${L}" x2="${W - R}" y1="${r1(yy)}" y2="${r1(yy)}" class="ch-grid"/><text x="${L - 7}" y="${r1(yy + 3)}" text-anchor="end" class="ch-ax">${fmtK(v)}</text>`;
    }
    const xl = [...new Set([1, 5, 10, 15, 20, 25, days].filter((d) => d <= days))];
    grid += xl.map((d) => `<text x="${r1(X(d))}" y="${H - 8}" text-anchor="middle" class="ch-ax">${d}</text>`).join("");

    let body = "", estLine = "";
    const pts = daily.map((v, i) => [X(i + 1), Y(mode === "daily" ? v : cum[i])]);
    const first = pts[0], last = pts[pts.length - 1];
    const line = smoothPath(pts);
    const area = pts.length > 1 ? `${line} L${r1(last[0])} ${r1(base)} L${r1(first[0])} ${r1(base)} Z` : "";

    if (mode === "daily") {
      if (target > 0 && target <= yMax) {
        const ty = r1(Y(target));
        g += `<clipPath id="${id("up")}"><rect x="0" y="0" width="${W}" height="${ty}"/></clipPath><clipPath id="${id("dn")}"><rect x="0" y="${ty}" width="${W}" height="${H}"/></clipPath>`;
        estLine = `<line x1="${L}" x2="${W - R}" y1="${ty}" y2="${ty}" class="ch-est"/><text x="${W - R}" y="${ty - 5}" text-anchor="end" class="ch-estl">estimate ${moneyR(target)}/day</text>`;
        if (pts.length > 1) {
          body += `<g clip-path="url(#${id("dn")})"><path d="${area}" fill="url(#${id("alo")})"/><path d="${line}" class="ch-line" stroke="url(#${id("lo")})"/></g>`;
          body += `<g clip-path="url(#${id("up")})"><path d="${area}" fill="url(#${id("ahi")})"/><path d="${line}" class="ch-line" stroke="url(#${id("hi")})"/></g>`;
        }
        body += daily.map((v, i) => (v > target ? `<circle cx="${r1(X(i + 1))}" cy="${r1(Y(v))}" r="3.2" class="ch-dot-over"/>` : "")).join("");
      } else if (pts.length > 1) {
        body += `<path d="${area}" fill="url(#${id("alo")})"/><path d="${line}" class="ch-line" stroke="url(#${id("lo")})"/>`;
      }
    } else {
      if (target > 0) {
        estLine = `<line x1="${r1(X(1))}" y1="${r1(Y(target))}" x2="${r1(X(days))}" y2="${r1(Y(target * days))}" class="ch-est"/><text x="${W - R}" y="${r1(Y(target * days) - 6)}" text-anchor="end" class="ch-estl">estimate ${moneyR(target * days)}</text>`;
        const stops = cum.map((v, i) => {
          const col = v > target * (i + 1) + 0.5 ? "#ff5b4a" : "#c8fb4c";
          const a = i === 0 ? 0 : (X(i) + X(i + 1)) / 2, b = i === cum.length - 1 ? L + pw : (X(i + 1) + X(i + 2)) / 2;
          return `<stop offset="${r1((a - L) / pw * 1000) / 1000}" stop-color="${col}"/><stop offset="${r1((b - L) / pw * 1000) / 1000}" stop-color="${col}"/>`;
        }).join("");
        g += `<linearGradient id="${id("tot")}" gradientUnits="userSpaceOnUse" x1="${L}" y1="0" x2="${L + pw}" y2="0">${stops}</linearGradient>`;
        if (pts.length > 1) body += `<path d="${area}" fill="url(#${id("alo")})"/><path d="${line}" class="ch-line" stroke="url(#${id("tot")})"/>`;
      } else if (pts.length > 1) {
        body += `<path d="${area}" fill="url(#${id("alo")})"/><path d="${line}" class="ch-line" stroke="url(#${id("lo")})"/>`;
      }
    }
    g += `</defs>`;
    if (pts.length === 1) body += `<circle cx="${r1(first[0])}" cy="${r1(first[1])}" r="4" fill="#c8fb4c"/>`;

    /* tapped day */
    let pickHtml = "", readout = "";
    const pk = chartPick && chartPick.mk === mk && chartPick.day <= upTo ? chartPick.day : null;
    if (pk) {
      const px = r1(X(pk)), py = r1(pts[pk - 1][1]), v = daily[pk - 1], c = cum[pk - 1];
      const over = mode === "daily" ? target > 0 && v > target : target > 0 && c > target * pk + 0.5;
      pickHtml = `<line x1="${px}" x2="${px}" y1="${T}" y2="${r1(base)}" class="ch-pick"/><circle cx="${px}" cy="${py}" r="5" class="ch-pick-dot ${over ? "over" : ""}"/>`;
      if (mode === "daily") {
        const diff = target > 0 ? (v > target ? ` \u00b7 <b class="o">${moneyR(v - target)} over estimate</b>` : ` \u00b7 <b class="k">${moneyR(target - v)} under estimate</b>`) : "";
        readout = `<b>${dayLabel(mk, pk)}</b> \u2014 ${moneyR(v)} spent${diff}`;
      } else {
        const e = target * pk, diff = target > 0 ? (c > e ? ` \u00b7 <b class="o">${moneyR(c - e)} above estimate</b>` : ` \u00b7 <b class="k">${moneyR(e - c)} below estimate</b>`) : "";
        readout = `By <b>${dayLabel(mk, pk)}</b> \u2014 ${moneyR(c)} spent${diff}`;
      }
    } else if (!upTo || total <= 0) {
      readout = "Add meals in the Diary and your month graph appears here.";
    } else if (mode === "daily") {
      if (target > 0) {
        const overDays = daily.map((v, i) => [v, i + 1]).filter(([v]) => v > target);
        const top = daily.reduce((a, v, i) => (v > a[0] ? [v, i + 1] : a), [0, 0]);
        readout = overDays.length
          ? `<b class="o">${overDays.length} day${overDays.length > 1 ? "s" : ""} went above</b> your estimate. Highest: <b>${dayLabel(mk, top[1])}</b> (${moneyR(top[0])}).`
          : `<b class="k">Every day so far is within your estimate.</b> Keep it up.`;
      } else readout = `Highest day: <b>${dayLabel(mk, daily.reduce((a, v, i) => (v > daily[a - 1] ? i + 1 : a), 1))}</b>. Tap any day for details.`;
    } else {
      readout = target > 0
        ? (total > est ? `You are <b class="o">${moneyR(total - est)} above</b> where you planned to be ${asOf === "today" ? "today" : "by " + asOf}.` : `You are <b class="k">${moneyR(est - total)} below</b> where you planned to be ${asOf === "today" ? "today" : "by " + asOf}. Nice.`)
        : "Your running total for the month.";
    }

    const hit = Array.from({ length: upTo }, (_, i) => {
      const w = pw / Math.max(1, days - 1);
      return `<rect x="${r1(X(i + 1) - w / 2)}" y="${T}" width="${r1(w)}" height="${ph}" class="ch-hit" data-action="b-chart-pick" data-mk="${mk}" data-day="${i + 1}"/>`;
    }).join("");

    return `<section class="card chart-card" aria-label="Spending graph for ${esc(monthLabel(mk))}">
      <div class="chart-head">
        <div class="chart-title"><span class="lbl">Spent in ${esc(monthLabel(mk))}</span><strong class="chart-amt">${moneyR(total)}</strong>${chip}</div>
        <div class="seg mini" role="group" aria-label="Graph type">
          <button type="button" data-action="b-chart-mode" data-mode="daily" aria-pressed="${mode === "daily"}">Daily</button>
          <button type="button" data-action="b-chart-mode" data-mode="total" aria-pressed="${mode === "total"}">Total</button>
        </div>
      </div>
      <p class="chart-sub">${esc(sub)}</p>
      <svg class="chart-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${mode === "daily" ? "Daily spending" : "Running total"} against your estimate">${g}${grid}${estLine}${body}${pickHtml}${hit}</svg>
      <div class="chart-legend"><span class="lo">Within estimate</span><span class="hi">Above estimate</span>${target > 0 ? `<span class="es">Estimate</span>` : ""}</div>
      <p class="chart-read" aria-live="polite">${readout}</p>
    </section>`;
  }

  /* ---------- Money flow graph: balance (area + up/down line) and daily activity lines ----------
     Pinch with two fingers to zoom, drag to move along the month, tap a day or any line for details.
     The graph is redrawn for the visible days, so text and dots never get stretched. */
  let flowMonth = null;
  let flowPick = null; // { mk, day, key }  key: "bal" or an activity key
  let flowModel = null;
  const flowHide = {};
  const flowZoom = { z: 1, c: 0, mk: null };
  const FLOW = {
    spent: { label: "Spent", color: "#ffb15a", out: true },
    gave: { label: "Lent", color: "#ff6b9d", out: true },
    recv: { label: "Received back", color: "#c8fb4c", out: false },
    took: { label: "Borrowed", color: "#6ea8ff", out: false },
    paid: { label: "Repaid", color: "#b48cff", out: true },
    gout: { label: "Group paid", color: "#2dd4bf", out: true },
    gin: { label: "Group received", color: "#facc15", out: false }
  };
  const FLOW_KEYS = ["spent", "gave", "recv", "took", "paid", "gout", "gin"];
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const dirText = (k) => (FLOW[k].out ? "money out" : "money in");
  const sMoney = (v) => (v > 0.004 ? "+" : v < -0.004 ? "\u2212" : "") + moneyR(Math.abs(v));
  const earliestFlowMonth = () => {
    const evs = BB.udhaar && BB.udhaar.events ? BB.udhaar.events() : [];
    return evs.reduce((m, e) => (monthOf(e.date) < m ? monthOf(e.date) : m), startMonthKey());
  };

  /* All the numbers for one month. */
  function flowCompute(mk) {
    const days = daysInMonthKey(mk), nowK = thisMonthKey();
    const todayDay = mk === nowK ? new Date().getDate() : mk > nowK ? 0 : days;
    const evs = (BB.udhaar && BB.udhaar.events ? BB.udhaar.events() : []).filter((e) => monthOf(e.date) === mk);
    const act = {};
    const actRec = {};
    FLOW_KEYS.forEach((k) => { act[k] = Array(days + 1).fill(0); actRec[k] = Array(days + 1).fill(0); });
    for (const key of Object.keys(state.records)) if (monthOf(key) === mk) act.spent[Number(key.slice(8, 10))] += n(state.records[key].spent);
    for (const e of evs) { const d = Number(e.date.slice(8, 10)); if (act[e.kind] && d >= 1 && d <= days) { act[e.kind][d] += e.amount; if (e.counted === false) actRec[e.kind][d] += e.amount; } }
    for (const x of externals().filter((q) => q.kind === "group" && extMonth(q) === mk)) {
      const gd = Math.min(days, extDay(x, mk)), ga = Number(x.amount) || 0;
      if (ga < 0) act.gout[gd] += -ga; else if (ga > 0) act.gin[gd] += ga;
    }
    const net = Array(days + 1).fill(0);
    for (let d = 1; d <= days; d++) net[d] -= act.spent[d];
    for (const x of externals().filter((q) => extMonth(q) === mk)) net[Math.min(days, extDay(x, mk))] += Number(x.amount) || 0;
    let lastAct = 0;
    for (let d = 1; d <= days; d++) if (FLOW_KEYS.some((k) => act[k][d] > 0) || Math.abs(net[d]) > 0.004) lastAct = d;
    const upTo = Math.min(days, Math.max(todayDay, lastAct));
    const hasBudget = Boolean(state.budgetLocked);
    let opening = 0;
    if (hasBudget && mk >= startMonthKey()) {
      if (isMonthMode()) opening = monthBase(mk) + carryInto(mk) + tIn(mk) - tOut(mk);
      else {
        const before = Object.keys(state.records).filter((k) => monthOf(k) < mk).reduce((t, k) => t + n(state.records[k].spent), 0);
        opening = foodBudget() + extBefore(mk) - before;
      }
    }
    const bal = [opening];
    for (let d = 1; d <= upTo; d++) bal.push(bal[d - 1] + net[d]);
    const totals = {};
    FLOW_KEYS.forEach((k) => { totals[k] = act[k].reduce((a, b) => a + b, 0); });
    return { mk, days, upTo, hasBudget, opening, bal, closing: bal[upTo], act, actRec, net, totals, shown: FLOW_KEYS.filter((k) => totals[k] > 0) };
  }

  /* Which days are visible, and the scales for both panels. */
  function flowGeom(m) {
    if (flowZoom.mk !== m.mk) { flowZoom.mk = m.mk; flowZoom.z = 1; }
    const zMax = Math.max(1, m.days / 3);
    const z = clamp(flowZoom.z, 1, zMax), span = m.days / z;
    const c = z === 1 ? m.days / 2 : clamp(flowZoom.c, span / 2, m.days - span / 2);
    flowZoom.z = z; flowZoom.c = c;
    const d0 = c - span / 2, d1 = c + span / 2;
    const W = 340, L = 40, R = 120, pw = W - L - R;
    const X = (d) => L + ((d - d0) / span) * pw;
    const i0 = Math.max(0, Math.floor(d0)), i1 = Math.min(m.upTo, Math.ceil(d1));
    const g = { z, span, d0, d1, W, L, R, pw, X, i0, i1 };
    if (m.shown.length) {
      const H = 200, T = 12, B = 22, ph = H - T - B, vis = m.shown.filter((k) => !flowHide[k]);
      let mx = 0;
      for (const k of vis) for (let i = Math.max(1, i0); i <= i1; i++) mx = Math.max(mx, m.act[k][i]);
      const yMax = niceMax(mx * 1.1);
      const vals = [];
      for (const k of vis) for (let i = Math.max(1, i0); i <= i1; i++) if (m.act[k][i] > 0) vals.push(m.act[k][i]);
      vals.sort((a, b) => a - b);
      const med = vals.length ? vals[Math.floor(vals.length / 2)] : 0;
      /* One very large value would flatten all the small ones, so the scale is compressed (square root) in that case. */
      const sq = vals.length > 1 && mx > med * 6;
      g.act = { H, T, ph, yMax, vis, sq, Y: (v) => { const r = Math.min(v, yMax) / yMax; return T + ph - (sq ? Math.sqrt(r) : r) * ph; } };
    }
    return g;
  }
  const lerpAt = (arr, d, upTo) => {
    const x = clamp(d, 1, Math.max(1, upTo)), a = Math.floor(x), b = Math.min(upTo, a + 1);
    return arr[a] + ((arr[b] === undefined ? arr[a] : arr[b]) - arr[a]) * (x - a);
  };

  /* The two SVG panels for the visible days. */
  function flowSvgs(m, idp = "flow") {
    const g = flowGeom(m), { X, L, W, pw } = g;
    const sel = flowPick && flowPick.mk === m.mk && flowPick.day <= m.upTo ? flowPick : null;
    const pk = sel ? sel.day : null, selKey = sel && sel.key && sel.key !== "bal" ? sel.key : null;
    const step = g.span > 24 ? 5 : g.span > 12 ? 2 : 1;
    const ticks = [];
    for (let d = Math.max(1, Math.ceil(g.d0)); d <= Math.floor(g.d1); d++) if (d % step === 0 || (step === 5 && d === 1) || (step === 5 && d === m.days && m.days % 5 >= 3)) ticks.push(d);
    const xAxis = (H) => ticks.map((d) => `<text x="${r1(X(d))}" y="${H - 6}" text-anchor="middle" class="ch-ax">${d}</text>`).join("");
    const clip = (id, T, ph) => `<clipPath id="${idp}-${id}"><rect x="${L}" y="${T - 6}" width="${pw + 3}" height="${ph + 12}"/></clipPath>`;
    let out = "";

    if (m.shown.length) {
      const { H, T, ph, yMax, vis, Y } = g.act;
      let grid = "";
      for (let i = 0; i <= 2; i++) {
        const v = g.act.sq ? yMax * Math.pow(i / 2, 2) : (yMax / 2) * i, yy = Y(v);
        grid += `<line x1="${L}" x2="${W - g.R}" y1="${r1(yy)}" y2="${r1(yy)}" class="ch-grid"/><text x="${L - 7}" y="${r1(yy + 3)}" text-anchor="end" class="ch-ax">${fmtK(v)}</text>`;
      }
      let body = "", defs = "", lblOut = "";
      for (const k of vis) {
        const c = FLOW[k].color, dim = selKey && selKey !== k, strong = selKey === k;
        const pts = [];
        for (let d = 1; d <= m.upTo; d++) pts.push([X(d), Y(m.act[k][d])]);
        const op = dim ? ' opacity=".22"' : "";
        if (pts.length > 1) {
          defs += `<linearGradient id="${idp}-g-${k}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${c}" stop-opacity=".30"/><stop offset="1" stop-color="${c}" stop-opacity="0"/></linearGradient>`;
          body += `<path d="${pts.map((q, i) => `${i ? "L" : "M"}${r1(q[0])} ${r1(q[1])}`).join(" ")} L${r1(pts[pts.length - 1][0])} ${r1(T + ph)} L${r1(pts[0][0])} ${r1(T + ph)} Z" fill="url(#${idp}-g-${k})"${op}/>`;
        }
        if (pts.length > 1) body += `<path d="${pts.map((q, i) => `${i ? "L" : "M"}${r1(q[0])} ${r1(q[1])}`).join(" ")}" class="ch-act-line${strong ? " strong" : ""}" stroke="${c}"${op}/>`;
        for (let d = Math.max(1, g.i0); d <= g.i1; d++) if (m.act[k][d] > 0 || m.upTo <= 2) body += `<circle cx="${r1(X(d))}" cy="${r1(Y(m.act[k][d]))}" r="${strong ? 3.6 : 2.8}" class="ch-act-dot" fill="${c}"${op}/>`;
      }
      /* Line names sit in the free space to the right of the graph, one under another, so they never cover the lines or the amounts. */
      const endD = Math.max(1, Math.min(m.upTo, g.i1));
      const lab = vis.map((k) => ({ k, y: Y(m.act[k][endD]) })).sort((a, b) => a.y - b.y);
      const lo = T + 6, hi = T + ph - 2, gap = 12;
      let prevY = lo - gap;
      for (const l of lab) { l.ly = Math.max(l.y + 3, prevY + gap, lo); prevY = l.ly; }
      let nextY = hi + gap;
      for (let i = lab.length - 1; i >= 0; i--) { lab[i].ly = Math.min(lab[i].ly, nextY - gap); nextY = lab[i].ly; }
      const lx = W - g.R + 12;
      for (const l of lab) {
        const dim = selKey && selKey !== l.k ? ' opacity=".35"' : "";
        lblOut += `<g class="ch-end"${dim}><circle cx="${lx - 7}" cy="${r1(l.ly - 3)}" r="2.6" fill="${FLOW[l.k].color}"/><text x="${lx}" y="${r1(l.ly)}" text-anchor="start" class="ch-series-label" style="font-size:9px" fill="${FLOW[l.k].color}">${FLOW[l.k].out ? "\u2193" : "\u2191"} ${FLOW[l.k].label}</text></g>`;
      }
      const lh = 11;
let nzc = 0;
for (let d = Math.max(1, g.i0); d <= g.i1; d++) if (vis.some((k) => m.act[k][d] > 0)) nzc++;
if (g.span <= 10 || nzc <= 5) {
for (let d = Math.max(1, g.i0); d <= g.i1; d++) {
const its = vis.filter((k) => m.act[k][d] > 0 && (!selKey || selKey === k)).map((k) => ({ k, y: Y(m.act[k][d]), t: fmtK(m.act[k][d]) })).sort((a, b) => a.y - b.y);
const px = X(d), sty = "paint-order:stroke;stroke:#17181a;stroke-width:2.5px", grp = [];
its.forEach((it) => { const last = grp[grp.length - 1]; if (last && it.y - last[last.length - 1].y < lh) last.push(it); else grp.push([it]); });
for (const gr of grp) {
const ws = gr.map((it) => it.t.length * 5.8 + 5), tot = ws.reduce((a, b) => a + b, 0);
let cx = clamp(px - tot / 2, L + 2, W - g.R - tot - 2);
gr.forEach((it, i) => { body += `<text x="${r1(cx + ws[i] / 2)}" y="${r1(Math.max(T + 8, it.y - 7))}" text-anchor="middle" class="ch-series-label" style="${sty}" fill="${FLOW[it.k].color}">${it.t}</text>`; cx += ws[i]; });
}
}
}
      let pick = "";
      if (pk && X(pk) >= L - 1 && X(pk) <= L + pw + 1) {
        const px = r1(X(pk));
        pick = `<line x1="${px}" x2="${px}" y1="${T}" y2="${r1(T + ph)}" class="ch-pick"/>`;
        if (selKey) {
          const v = m.act[selKey][pk];
          pick += `<circle cx="${px}" cy="${r1(Y(v))}" r="5" class="ch-pick-dot" style="fill:${FLOW[selKey].color}"/><text x="${clamp(px, L + 24, W - g.R - 24)}" y="${r1(Math.max(T + 8, Y(v) - 9))}" text-anchor="middle" class="ch-series-label" fill="${FLOW[selKey].color}">${moneyR(v)}</text>`;
        }
      }
      out += `<div class="flow-cap"><span>Money in and out, per day</span><span class="flow-key">\u2191 in \u00b7 \u2193 out</span></div>
        <svg class="chart-svg" data-panel="act" viewBox="0 0 ${W} ${H}" role="img" aria-label="Daily money activity for ${esc(monthLabel(m.mk))}"><defs>${defs}${clip("ca", T, ph)}</defs>${grid}${xAxis(H)}<g clip-path="url(#${idp}-ca)">${body}</g>${lblOut}${pick}</svg>`;
    }
    else {
      /* No entries yet: an empty graph with only the axes. It fills in as entries are added. */
      const H = 200, T = 12, B = 22, ph = H - T - B;
      let grid = "";
      for (let i = 0; i <= 2; i++) {
        const yy = T + ph - (i / 2) * ph;
        grid += `<line x1="${L}" x2="${W - g.R}" y1="${r1(yy)}" y2="${r1(yy)}" class="ch-grid"/><text x="${L - 7}" y="${r1(yy + 3)}" text-anchor="end" class="ch-ax">${fmtK(2500 * i)}</text>`;
      }
      out += `<div class="flow-cap"><span>Money in and out, per day</span><span class="flow-key">\u2191 in \u00b7 \u2193 out</span></div>
        <svg class="chart-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Empty graph for ${esc(monthLabel(m.mk))}">${grid}${xAxis(H)}</svg>`;
    }
    return out;
  }

  /* When the Time Machine picks a past day, the dashboard graph shows data only up to that day. */
  let flowCutPick = null;
  function flowCut(m) {
    const c = flowCutPick;
    if (!c) return m;
    if (c.mk !== m.mk || !(flowPick && flowPick.mk === c.mk && flowPick.day === c.day)) { flowCutPick = null; return m; }
    if (c.day >= m.upTo) return m;
    const cd = c.day, act = {}, actRec = {}, totals = {};
    FLOW_KEYS.forEach((k) => {
      act[k] = m.act[k].map((v, i) => (i > cd ? 0 : v));
      actRec[k] = m.actRec[k].map((v, i) => (i > cd ? 0 : v));
      totals[k] = act[k].reduce((a, b) => a + b, 0);
    });
    const bal = m.bal.slice(0, cd + 1);
    return { ...m, upTo: cd, bal, closing: bal[cd], act, actRec, net: m.net.map((v, i) => (i > cd ? 0 : v)), totals, shown: FLOW_KEYS.filter((k) => totals[k] > 0) };
  }

  function flowChartHtml(idp = "flow") {
    if (!state.budgetLocked) { flowModel = null; return ""; }
    const nowK = thisMonthKey();
    const mk = flowMonth && flowMonth <= nowK ? flowMonth : nowK;
    const m = flowCut(flowCompute(mk));
    flowModel = m;
    const { days, upTo, hasBudget, opening, closing, bal, act, totals, shown } = m;
    const g = flowGeom(m);
    const any = shown.length > 0;

    const change = closing - opening;
    const chip = hasBudget && upTo > 0 && Math.abs(change) > 0.5
      ? `<span class="chip ${change > 0 ? "ok" : "over"}">${change > 0 ? "\u2191" : "\u2193"} ${moneyR(Math.abs(change))} this month</span>` : "";
    const earliest = earliestFlowMonth();
    const nav = `<div class="month-nav flow-nav"><button type="button" data-action="b-flow-month" data-d="-1" aria-label="Previous month" ${mk <= earliest ? "disabled" : ""}>${icon("back")}</button><strong>${esc(monthLabel(mk))}</strong><button type="button" data-action="b-flow-month" data-d="1" aria-label="Next month" ${mk >= nowK ? "disabled" : ""}>${icon("next")}</button></div>`;
    const chips = shown.map((k) => `<button type="button" class="flow-chip" data-action="b-flow-toggle" data-k="${k}" aria-pressed="${!flowHide[k]}" style="--c:${FLOW[k].color}"><i></i>${FLOW[k].out ? "\u2193" : "\u2191"} ${FLOW[k].label} <b>${moneyR(totals[k])}</b></button>`).join("");

    const sel = flowPick && flowPick.mk === mk && flowPick.day <= upTo ? flowPick : null;
    let readout;
    if (sel) {
      const pk = sel.day, d = bal[pk] - bal[pk - 1];
      if (sel.key && sel.key !== "bal" && FLOW[sel.key]) {
        const k = sel.key;
        const rec = m.actRec[k][pk], cnt = act[k][pk] - rec;
        const note = k === "spent" ? "taken from your budget" : rec > 0.004 && cnt > 0.004 ? `${moneyR(cnt)} ${FLOW[k].out ? "taken from" : "added to"} your budget, ${moneyR(rec)} record only` : rec > 0.004 ? "record only, budget not changed" : FLOW[k].out ? "taken from your budget" : "added to your budget";
        readout = `<span class="rd" style="--c:${FLOW[k].color}"><i></i><b>${FLOW[k].label}</b></span> (${dirText(k)}) on <b>${dayLabel(mk, pk)}</b>: <b>${moneyR(act[k][pk])}</b><div class="rd-row"><span>${note}</span><span>Month total ${moneyR(totals[k])}</span>${hasBudget ? `<span>Balance that day <b>${moneyR(bal[pk])}</b></span>` : ""}</div>`;
      } else {
        const parts = FLOW_KEYS.filter((k) => act[k][pk] > 0).map((k) => `<span class="rd" style="--c:${FLOW[k].color}"><i></i>${FLOW[k].label} (${FLOW[k].out ? "out" : "in"}) ${moneyR(act[k][pk])}</span>`).join("");
        readout = `<b>${dayLabel(mk, pk)}</b>${hasBudget ? ` \u2014 balance <b>${moneyR(bal[pk])}</b> (<b class="${d > 0.004 ? "k" : d < -0.004 ? "o" : ""}">${Math.abs(d) < 0.005 ? "no change" : sMoney(d)}</b>)` : ""}<div class="rd-row">${parts || "No activity this day."}</div>`;
      }
    } else if (!any && !hasBudget) {
      readout = "Save your budget and add meals or Lend &amp; Borrow entries. Your money flow appears here.";
    } else if (!any && Math.abs(change) < 0.5) {
      readout = "";
    } else if (hasBudget && upTo > 0) {
      let dropD = 0, riseD = 0, dropV = 0, riseV = 0;
      for (let d = 1; d <= upTo; d++) {
        const dv = bal[d] - bal[d - 1];
        if (dv < dropV) { dropV = dv; dropD = d; }
        if (dv > riseV) { riseV = dv; riseD = d; }
      }
      readout = `Balance went from <b>${moneyR(opening)}</b> to <b>${moneyR(closing)}</b>.${dropV < -0.5 ? ` Biggest drop: <b class="o">${dayLabel(mk, dropD)} (${sMoney(dropV)})</b>.` : ""}${riseV > 0.5 ? ` Biggest rise: <b class="k">${dayLabel(mk, riseD)} (${sMoney(riseV)})</b>.` : ""} Tap a day or a line for details.`;
    } else {
      readout = "Tap a day or a line for details.";
    }

    return `<section class="card chart-card flow-card" aria-label="Money flow for ${esc(monthLabel(mk))}">
      <div class="chart-head"><div class="chart-title"><span class="lbl">Available balance</span><strong class="chart-amt">${hasBudget ? moneyR(closing) : moneyR(totals.spent)}</strong>${chip}</div>${nav}</div>
      <p class="chart-sub">${hasBudget ? "Your money day by day. Pinch to zoom, drag to move, tap a line to see details." : "Save your budget to see your available balance."}</p>
      <div class="flow-host" data-idp="${idp}">${flowSvgs(m, idp)}</div>
      ${chips ? `<div class="flow-chips" role="group" aria-label="Show or hide lines">${chips}</div>` : ""}
      ${readout ? `<p class="chart-read" aria-live="polite">${readout}</p>` : ""}
    </section>`;
  }

  /* Redraw only the graph while zooming or dragging (no full screen refresh). */
  let flowRaf = 0;
  function flowRefresh() {
    if (flowRaf) return;
    flowRaf = requestAnimationFrame(() => {
      flowRaf = 0;
      if (!flowModel) return;
      document.querySelectorAll(".flow-host").forEach((h) => { h.innerHTML = flowSvgs(flowModel, h.dataset.idp || "flow"); });
    });
  }
  /* Zoom so the day "focalDay" stays under horizontal position f (0 to 1 across the plot). */
  function flowZoomTo(z, f, focalDay) {
    if (!flowModel) return;
    const zMax = Math.max(1, flowModel.days / 3);
    const nz = clamp(z, 1, zMax), span = flowModel.days / nz;
    flowZoom.z = nz;
    flowZoom.c = nz === 1 ? flowModel.days / 2 : clamp(focalDay - f * span + span / 2, span / 2, flowModel.days - span / 2);
    flowRefresh();
  }

  /* Tap: pick the nearest day, and the nearest line when the tap is on the activity panel. */
  function flowTap(host, cx, cy) {
    const m = flowModel;
    if (!m || m.upTo < 1) return;
    const g = flowGeom(m);
    for (const svg of host.querySelectorAll("svg[data-panel]")) {
      const r = svg.getBoundingClientRect();
      if (cy < r.top - 6 || cy > r.bottom + 6) continue;
      const vbH = Number(String(svg.getAttribute("viewBox")).split(" ")[3]) || r.height;
      const sx = (cx - r.left) * g.W / r.width, sy = (cy - r.top) * vbH / r.height;
      const d = g.d0 + ((sx - g.L) / g.pw) * g.span;
      const day = clamp(Math.round(d), 1, m.upTo);
      let key = null;
      if (svg.dataset.panel === "bal") key = "bal";
      else if (g.act) {
        let best = 16;
        for (const k of g.act.vis) {
          if (!(m.act[k][day] > 0)) continue;
          const dy = Math.abs(g.act.Y(lerpAt(m.act[k], d, m.upTo)) - sy);
          if (dy < best) { best = dy; key = k; }
        }
      }
      const same = flowPick && flowPick.mk === m.mk && flowPick.day === day && flowPick.key === key;
      flowPick = same ? null : { mk: m.mk, day, key };
      renderAll();
      return;
    }
  }

  const flowPtr = new Map();
  let flowGest = null;
  const flowHostOf = (e) => (e.target && e.target.closest ? e.target.closest(".flow-host") : null);
  const flowMid = (a, b, host) => {
    const svg = host.querySelector("svg"); if (!svg) return 0.5;
    const r = svg.getBoundingClientRect(), g = flowGeom(flowModel);
    return clamp((((a + b) / 2 - r.left) * g.W / r.width - g.L) / g.pw, 0, 1);
  };
  document.addEventListener("pointerdown", (e) => {
    const host = flowHostOf(e);
    if (!host || !flowModel) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    try { host.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    flowPtr.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, t: Date.now(), host });
    if (!flowGest) flowGest = { moved: false };
    if (flowPtr.size === 2) {
      const [a, b] = [...flowPtr.values()], g = flowGeom(flowModel), f = flowMid(a.x, b.x, host);
      flowGest.moved = true;
      flowGest.pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, z: g.z, day: g.d0 + f * g.span };
    }
  });
  document.addEventListener("pointermove", (e) => {
    const p = flowPtr.get(e.pointerId);
    if (!p || !flowModel) return;
    const prevX = p.x; p.x = e.clientX; p.y = e.clientY;
    const svg = p.host.querySelector("svg"); if (!svg) return;
    const rect = svg.getBoundingClientRect(), g = flowGeom(flowModel);
    if (flowPtr.size >= 2 && flowGest && flowGest.pinch) {
      const [a, b] = [...flowPtr.values()], dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      flowZoomTo(flowGest.pinch.z * dist / flowGest.pinch.dist, flowMid(a.x, b.x, p.host), flowGest.pinch.day);
      return;
    }
    if (Math.hypot(e.clientX - p.sx, e.clientY - p.sy) > 8) flowGest.moved = true;
    if (flowGest.moved && g.z > 1) {
      flowZoom.c -= (((e.clientX - prevX) * g.W / rect.width) / g.pw) * g.span;
      flowRefresh();
    }
  });
  const flowEnd = (e) => {
    const p = flowPtr.get(e.pointerId);
    if (!p) return;
    flowPtr.delete(e.pointerId);
    const tap = e.type === "pointerup" && flowGest && !flowGest.moved && Date.now() - p.t < 700;
    if (!flowPtr.size) flowGest = null;
    if (tap) flowTap(p.host, e.clientX, e.clientY);
  };
  document.addEventListener("pointerup", flowEnd);
  document.addEventListener("pointercancel", flowEnd);
  /* Stop the page from scrolling while two fingers are on the graph. */
  document.addEventListener("touchmove", (e) => { if (e.touches.length >= 2 && flowHostOf(e)) e.preventDefault(); }, { passive: false });
  /* Mouse / trackpad: Ctrl + wheel (or pinch on a trackpad) zooms. */
  document.addEventListener("wheel", (e) => {
    const host = flowHostOf(e);
    if (!host || !flowModel || !(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const g = flowGeom(flowModel), svg = host.querySelector("svg");
    const r = svg.getBoundingClientRect();
    const f = clamp(((e.clientX - r.left) * g.W / r.width - g.L) / g.pw, 0, 1);
    flowZoomTo(g.z * (e.deltaY < 0 ? 1.25 : 0.8), f, g.d0 + f * g.span);
  }, { passive: false });

  /* ---------- Hooks for the Lend & Borrow ledger ---------- */
  const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));
  function addExternalTransaction(id, date, amount, label, kind = "") {
    const a = Math.round((Number(amount) || 0) * 100) / 100;
    if (!id || !a) return;
    state.external = externals().filter((x) => x.id !== id).concat({ id: String(id), date: isDay(date) ? date : dateKey(new Date()), amount: a, label: String(label || ""), kind });
    persist();
  }
  function removeExternalTransaction(id) {
    const before = externals().length;
    state.external = externals().filter((x) => x.id !== id);
    if (state.external.length !== before) persist();
  }
  /* Adds missing adjustments in one go (used once for older ledger entries). */
  function ensureExternal(list) {
    const have = new Set(externals().map((x) => x.id));
    const add = list.filter((x) => x && x.id && !have.has(x.id) && Number(x.amount)).map((x) => ({ id: String(x.id), date: isDay(x.date) ? x.date : dateKey(new Date()), amount: Math.round(Number(x.amount) * 100) / 100, label: String(x.label || ""), kind: x.kind || "" }));
    if (!add.length) return;
    state.external = externals().concat(add);
    persist();
  }

  /* ---------- Rendering ---------- */
  function renderAll() {
    renderBudget();
    renderDiary();
    BB.emit("budget");
  }

  /* ---------- Diary helpers ---------- */
  const nowTime = () => new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
  const todayMeals = () => ((state.records[dateKey(new Date())] || {}).meals || []).slice();

  /* ---------- Actions ---------- */
  Object.assign(BB.actions, {
    "b-period": async (el) => {
      const v = el.dataset.v === "custom" ? "custom" : "month";
      if (state.periodMode === v || (v === "month" && !state.periodMode)) return;
      state.periodMode = v;
      if (v === "custom") {
        if (!state.periodStartDate) state.periodStartDate = state.budgetStartDate || dateKey(new Date());
        if (!state.periodEndDate) state.periodEndDate = dateKey(new Date(today.getFullYear(), today.getMonth() + 1, 0));
      }
      await persist();
    },
    "b-flow-month": (el) => {
      const nowK = thisMonthKey(), cur = flowMonth && flowMonth <= nowK ? flowMonth : nowK;
      const next = addMonthKey(cur, Number(el.dataset.d) || 0);
      if (next > nowK || next < earliestFlowMonth()) return;
      flowMonth = next; flowPick = null; renderAll();
    },
    "b-flow-toggle": (el) => { const k = el.dataset.k; if (FLOW[k]) { flowHide[k] = !flowHide[k]; renderAll(); } },
    "b-chart-mode": (el) => { chartMode = el.dataset.mode === "total" ? "total" : "daily"; renderAll(); },
    "b-chart-pick": (el) => {
      const day = Number(el.dataset.day), mk = el.dataset.mk;
      chartPick = chartPick && chartPick.mk === mk && chartPick.day === day ? null : { mk, day };
      renderAll();
    },
    "b-meals": (el) => { if (!state.budgetLocked) { state.mealsPerDay = Number(el.dataset.v); saveDraft(); renderBudget(); } },
    "b-save": async () => {
      if (!state.budgetLocked) {
        const start = $("#bStart");
        if (n(start.value) <= 0) { start.focus(); toast("Enter a starting budget greater than zero.", "error"); return; }
        state.startBudget = n(start.value);
        state.budgetLocked = true;
        state.budgetStartDate = state.budgetStartDate || dateKey(new Date());
      }
      document.querySelectorAll("[data-fixed]").forEach((el) => { state.fixed[el.dataset.fixed] = n(el.value); });
      await persist();
      toast("Budget saved", "success");
    },
    "b-add-funds": () => openSheet(`<h2>Add funds</h2><p class="sheet-sub">Add extra money to your available budget.</p>
      <form data-form="funds" novalidate><label class="field"><span>Amount (PKR)</span><input name="amount" type="number" inputmode="numeric" min="1" step="100" placeholder="e.g. 2000" autofocus></label>
      <p class="form-error" hidden></p><button class="btn primary block" type="submit">Add funds</button></form>`),
    "b-export": () => exportCsv(),
    "b-reminder": async () => {
      try {
        if (Native && window.Capacitor && window.Capacitor.isNativePlatform()) {
          const plugin = Native.LocalNotifications;
          let permission = await plugin.checkPermissions();
          if (permission.display !== "granted") permission = await plugin.requestPermissions();
          if (permission.display !== "granted") {
            toast("Notification permission was not granted.", "error");
            return;
          }

          const now = new Date();
          const at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 21, 0, 0, 0);
          if (at <= now) at.setDate(at.getDate() + 1);

          await plugin.cancel({ notifications: [{ id: 2100 }] });
          await plugin.schedule({
            notifications: [{
              id: 2100,
              title: "MONETRA daily reminder",
              body: "Remember to record today's food spending.",
              schedule: { at, repeats: true, every: "day", allowWhileIdle: true }
            }]
          });
          localStorage.setItem("budgetbite_native_reminder", "on");
          toast("Daily 9 PM reminder scheduled.", "success");
        } else if ("Notification" in window) {
          const permission = await Notification.requestPermission();
          if (permission !== "granted") {
            toast("Notifications were not allowed by the browser.", "error");
            return;
          }
          localStorage.setItem("budgetbite_native_reminder", "on");
          toast("Browser reminder enabled while the app is open.", "success");
        } else {
          toast("Native notifications are unavailable. Open the Android app build.", "error");
        }
      } catch (e) {
        console.error("Reminder setup failed:", e);
        toast("Could not schedule reminder: " + (e.message || e), "error");
      }
      renderBudget();
    },
    "b-reset": async () => {
      if (!(await confirmSheet({ title: "Reset budget?", message: "This permanently clears your saved budget, daily records and moved money. Your savings goals and your Lend & Borrow records are kept, but old loans no longer change the new budget.", confirmLabel: "Reset budget" }))) return;
      const keepGoals = goals();
      state = { ...defaultState(), goals: keepGoals }; selectedDate = dateKey(new Date());
      await persist(); toast("Budget reset", "success");
    },
    "b-day": (el) => { selectedDate = el.dataset.date; state.month = selectedDate.slice(0, 7); renderDiary(); },
    "b-month": (el) => { const [y, m] = state.month.split("-").map(Number); const d = new Date(y, m - 1 + Number(el.dataset.d), 1); state.month = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; renderDiary(); },
    "b-add-meal": () => openSheet(`<h2>Add a meal</h2><p class="sheet-sub">What did you eat and how much did it cost? It is added to the selected day.</p>
      <form data-form="meal" novalidate><label class="field"><span>What you ate</span><input name="dish" maxlength="150" placeholder="e.g. Daal chawal" autofocus></label>
      <label class="field"><span>Price (PKR)</span><input name="price" type="number" inputmode="decimal" min="1" step="any" placeholder="e.g. 120"></label>
      <p class="form-error" hidden></p><button class="btn primary block" type="submit">Add to diary</button></form>`),
    "b-add-other": () => openSheet(`<h2>Other expense</h2><p class="sheet-sub">Add any other food spending.</p>
      <form data-form="other" novalidate><label class="field"><span>What was it?</span><input name="label" maxlength="80" placeholder="e.g. Tea and snacks" autofocus></label>
      <label class="field"><span>Amount (PKR)</span><input name="amount" type="number" inputmode="decimal" min="1" step="any" placeholder="e.g. 150"></label>
      <p class="form-error" hidden></p><button class="btn primary block" type="submit">Add expense</button></form>`),
    "b-goal-add": () => openSheet(`<h2>New installment goal</h2><p class="sheet-sub">Tell us what you want and in how many months. We calculate the monthly saving.</p>
      <form data-form="goal" novalidate><label class="field"><span>What do you want to buy?</span><input name="name" maxlength="60" placeholder="e.g. Laptop" autofocus></label>
      <label class="field"><span>Price (PKR)</span><input name="price" type="number" inputmode="numeric" min="1" step="any" placeholder="e.g. 60000"></label>
      <label class="field"><span>Already saved (PKR) <i>optional</i></span><input name="saved" type="number" inputmode="numeric" min="0" step="any" placeholder="0"></label>
      <label class="field"><span>Months to save</span><input name="months" type="number" inputmode="numeric" min="1" max="120" step="1" placeholder="e.g. 6"></label>
      <p class="form-error" hidden></p><button class="btn primary block" type="submit">Create goal</button></form>`),
    "b-goal-fund": (el) => openSheet(`<h2>Add to savings</h2><p class="sheet-sub">How much did you set aside for this goal?</p>
      <form data-form="goalfund" novalidate><input type="hidden" name="id" value="${esc(el.dataset.id)}"><label class="field"><span>Amount (PKR)</span><input name="amount" type="number" inputmode="numeric" min="1" step="any" autofocus></label>
      <p class="form-error" hidden></p><button class="btn primary block" type="submit">Save</button></form>`),
    "b-goal-del": async (el) => {
      const g = goals().find((x) => x.id === el.dataset.id);
      if (!g) return;
      if (!(await confirmSheet({ title: "Delete this goal?", message: `“${g.name}” and its saved progress will be removed.`, confirmLabel: "Delete" }))) return;
      state.goals = goals().filter((x) => x.id !== g.id); await persist();
    },
    "b-transfer-add": () => {
      const cur = thisMonthKey(), start = startMonthKey();
      const fromOpts = monthRange(start, cur).reverse().map((m) => `<option value="${m}" ${m === cur ? "selected" : ""}>${esc(monthLabel(m))} (${moneyR(Math.floor(transferable(m)))} available)</option>`).join("");
      const toOpts = monthRange(start, addMonthKey(cur, 12)).map((m) => `<option value="${m}" ${m === nextMonthKey(cur) ? "selected" : ""}>${esc(monthLabel(m))}</option>`).join("");
      openSheet(`<h2>Move saved money</h2><p class="sheet-sub">Take unspent money from one month and add it to another month's budget.</p>
        <form data-form="transfer" novalidate>
          <label class="field"><span>From month</span><select name="from">${fromOpts}</select></label>
          <label class="field"><span>To month</span><select name="to">${toOpts}</select></label>
          <label class="field"><span>Amount (PKR)</span><input name="amount" type="number" inputmode="numeric" min="1" step="any" placeholder="e.g. 1000" autofocus></label>
          <p class="form-error" hidden></p><button class="btn primary block" type="submit">Move money</button></form>`);
    },
    "b-transfer-del": async (el) => {
      const t = transfers().find((x) => x.id === el.dataset.id);
      if (!t) return;
      state.transfers = transfers().filter((x) => x.id !== t.id);
      if (thisMonthAvailable() < -0.5) { state.transfers = transfers().concat(t); toast("Part of that money is already spent, so it cannot be moved back.", "error"); return; }
      await persist(); toast("Move undone", "success");
    },
    "b-remove-meal": (el) => {
      const r = ensureRecord(); const idx = Number(el.dataset.i); const meal = r.meals[idx];
      if (!meal) return;
      r.base = baseOf(r);
      r.meals.splice(idx, 1); r.items = r.meals.map((x) => x.name);
      syncSpent(r);
      persist();
    }
  });
  Object.assign(BB.forms, {
    meal: async (form) => {
      const fd = new FormData(form); const err = $(".form-error", form);
      const fail = (m) => { err.textContent = m; err.hidden = false; };
      const dish = String(fd.get("dish") || "").trim(); const price = n(fd.get("price"));
      if (!dish) return fail("Enter what you ate.");
      if (price <= 0) return fail("Enter the price you paid.");
      const r = ensureRecord();
      r.base = baseOf(r);
      r.meals.push({ name: dish, price, category: "Food" });
      r.items = r.meals.map((x) => x.name);
      syncSpent(r); r.ate = true; r.time = nowTime();
      closeSheet(); persist(); toast("Added to your diary", "success");
    },
    goal: async (form) => {
      const fd = new FormData(form); const err = $(".form-error", form);
      const name = String(fd.get("name") || "").trim(); const price = n(fd.get("price")); const months = Math.floor(n(fd.get("months"))); const saved = n(fd.get("saved"));
      const fail = (m) => { err.textContent = m; err.hidden = false; };
      if (!name) return fail("Enter what you want to buy.");
      if (price <= 0) return fail("Enter a price greater than zero.");
      if (saved >= price) return fail("Already saved must be less than the price.");
      if (months < 1 || months > 120) return fail("Months must be between 1 and 120.");
      const g = { id: uid("g"), name, price, months, startMonth: thisMonthKey(), saved: 0 };
      if (saved > 0) { g.saved = saved; g.savedByMonth = { [thisMonthKey()]: saved }; }
      state.goals = goals().concat(g);
      closeSheet(); await persist(); toast("Goal created", "success");
    },
    goalfund: async (form) => {
      const fd = new FormData(form); const err = $(".form-error", form); const amount = n(fd.get("amount"));
      if (amount <= 0) { err.textContent = "Enter an amount greater than zero."; err.hidden = false; return; }
      const g = goals().find((x) => x.id === String(fd.get("id")));
      if (!g) { closeSheet(); return; }
      g.saved = n(g.saved) + amount; g.savedByMonth = { ...(g.savedByMonth || {}), [thisMonthKey()]: goalSavedThisMonth(g) + amount }; closeSheet(); await persist(); toast(`${moneyR(amount)} saved`, "success");
    },
    transfer: async (form) => {
      const fd = new FormData(form); const err = $(".form-error", form);
      const fail = (m) => { err.textContent = m; err.hidden = false; };
      const from = String(fd.get("from")), to = String(fd.get("to")), amount = n(fd.get("amount"));
      if (!state.budgetLocked || !isMonthMode()) return fail("Save your monthly budget first.");
      if (from === to) return fail("Choose a different month to move the money to.");
      if (amount <= 0) return fail("Enter an amount greater than zero.");
      const avail = Math.floor(transferable(from));
      if (amount > avail) return fail(`Only ${moneyR(avail)} is available to move from ${monthLabel(from)}.`);
      state.transfers = transfers().concat({ id: uid("t"), from, to, amount, date: dateKey(new Date()) });
      closeSheet(); await persist(); toast(`${moneyR(amount)} moved to ${monthLabel(to)}`, "success");
    },
    funds: async (form) => {
      const amount = n(new FormData(form).get("amount"));
      const err = $(".form-error", form);
      if (amount <= 0) { err.textContent = "Enter an amount greater than zero."; err.hidden = false; return; }
      state.addedFunds = n(state.addedFunds) + amount;
      closeSheet(); await persist(); toast(`${moneyR(amount)} added`, "success");
    },
    other: async (form) => {
      const fd = new FormData(form);
      const amount = n(fd.get("amount"));
      const err = $(".form-error", form);
      if (amount <= 0) { err.textContent = "Enter an amount greater than zero."; err.hidden = false; return; }
      const r = ensureRecord();
      r.base = baseOf(r);
      r.meals.push({ name: String(fd.get("label") || "").trim() || "Other expense", price: amount, category: "Other" });
      r.items = r.meals.map((x) => x.name);
      syncSpent(r); r.ate = true;
      r.time = new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
      closeSheet(); await persist(); toast("Expense added", "success");
    }
  });

  /* Field drafts: update state without re-rendering so typing is never interrupted */
  document.addEventListener("input", (e) => {
    const t = e.target;
    if (t.id === "bStart") { if (!state.budgetLocked) state.startBudget = t.value === "" ? null : n(t.value); saveDraft(); }
    else if (t.dataset && t.dataset.fixed) { state.fixed[t.dataset.fixed] = t.value === "" ? 0 : n(t.value); saveDraft(); }
  });
  document.addEventListener("change", (e) => {
    const t = e.target;
    if (t.id === "dSpent") { const r = ensureRecord(); r.base = n(t.value); syncSpent(r); r.ate = r.ate || r.spent > 0; if (r.spent > 0) r.time = new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false }); persist(); }
    else if (t.id === "dNote") { const r = ensureRecord(); r.note = t.value.trim(); persistSoon(); }
    else if (t.id === "dAte") { const r = ensureRecord(); r.ate = t.checked; persistSoon(); }
    else if (t.dataset && t.dataset.fixed && state.budgetLocked) { state.fixed[t.dataset.fixed] = n(t.value); persistSoon(); }
  });

  /* Budget period controls (one handler; the old duplicate handlers called an undefined save()) */
  document.addEventListener("change", async (e) => {
    const t = e.target;
    if (!t) return;
    if (t.id === "bPeriodMode") {
      if (t.value !== "month" && t.value !== "custom") return;
      state.periodMode = t.value;
      if (t.value === "custom") {
        if (!state.periodStartDate) state.periodStartDate = state.budgetStartDate || dateKey(new Date());
        if (!state.periodEndDate) state.periodEndDate = dateKey(new Date(today.getFullYear(), today.getMonth() + 1, 0));
      }
      await persist();
    } else if (t.id === "bPeriodStart") {
      state.periodStartDate = String(t.value || "");
      if (state.periodEndDate && state.periodEndDate < state.periodStartDate) state.periodEndDate = "";
      await persist();
    } else if (t.id === "bPeriodEnd") {
      const value = String(t.value || "");
      if (value && state.periodStartDate && value < state.periodStartDate) {
        toast("Choose an end date on or after the start date.", "error");
        t.value = state.periodEndDate || "";
        return;
      }
      state.periodEndDate = value;
      state.periodMode = "custom";
      await persist();
    }
  });

  /* ---------- CSV export ---------- */
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const niceDay = (key) => `${Number(key.slice(8, 10))} ${MON[Number(key.slice(5, 7)) - 1]} ${key.slice(0, 4)}`;

  /* Builds the export as sheets with plain headings: Summary, Daily Spending, Lend & Borrow, People. */
  function exportSheets() {
    const records = state.records || {};
    const keys = Object.keys(records).sort();
    const isOther = (m) => String(m.category || "").toLowerCase() === "other";
    const otherNames = [...new Set(keys.flatMap((k) => ((records[k] && records[k].meals) || []).filter(isOther).map((m) => String(m.name || "Other expense").trim() || "Other expense")))];
    const blankZero = (v) => (v > 0 ? v : "");

    const daily = [{ kind: "header", cells: ["Date", "Food total typed (Rs.)", "Meals added (Rs.)", ...otherNames.map((x) => x + " (Rs.)"), "Day total (Rs.)", "Ate today", "What you ate or bought"] }];
    const months = {}; const all = { base: 0, meals: 0, total: 0, cat: {} };
    for (const key of keys) {
      const r = records[key] || {};
      const list = Array.isArray(r.meals) ? r.meals : [];
      const cat = {}; let other = 0, foodMeals = 0;
      for (const m of list) {
        const price = n(m.price), name = String(m.name || "Other expense").trim() || "Other expense";
        if (isOther(m)) { cat[name] = (cat[name] || 0) + price; other += price; } else foodMeals += price;
      }
      const base = baseOf(r), total = base + foodMeals + other, mk = key.slice(0, 7);
      const mo = months[mk] = months[mk] || { base: 0, meals: 0, total: 0, cat: {} };
      mo.base += base; mo.meals += foodMeals; mo.total += total; all.base += base; all.meals += foodMeals; all.total += total;
      for (const nm of otherNames) { mo.cat[nm] = (mo.cat[nm] || 0) + (cat[nm] || 0); all.cat[nm] = (all.cat[nm] || 0) + (cat[nm] || 0); }
      const items = list.length ? list.map((m) => `${m.name} (${n(m.price)})`).join(", ") : (r.items || []).join(", ");
      daily.push({ kind: "data", cells: [niceDay(key), blankZero(base), blankZero(foodMeals), ...otherNames.map((nm) => blankZero(cat[nm] || 0)), total, r.ate ? "Yes" : "No", [items, r.note].filter(Boolean).join(" | ")] });
    }
    const now = new Date(), curM = now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0");
    const showMonths = Object.keys(months).sort();
    if (showMonths.length > 1) for (const mk of showMonths) {
      const mo = months[mk], done = mk < curM;
      daily.push({ kind: "sub", cells: [monthLabel(mk) + (done ? " total" : " so far"), blankZero(mo.base), blankZero(mo.meals), ...otherNames.map((nm) => blankZero(mo.cat[nm] || 0)), mo.total, "", ""] });
    }
    daily.push({ kind: "total", cells: ["All days together", blankZero(all.base), blankZero(all.meals), ...otherNames.map((nm) => blankZero(all.cat[nm] || 0)), all.total, "", ""] });

    const lb = BB.udhaar && BB.udhaar.exportSheets ? BB.udhaar.exportSheets() : { sheets: [], totals: null, net: 0 };
    const t = lb.totals;
    const sum = [{ kind: "header", cells: ["Item", "Amount (Rs.)", "What it means"] }];
    sum.push({ kind: "sub", cells: ["Your spending", "", ""] });
    sum.push({ kind: "data", cells: ["Total spent", all.total, "Food and other expenses of all days"] });
    if (state.budgetLocked) sum.push({ kind: "data", cells: [isMonthMode() ? "Food money left this month" : "Food money left", Math.round(remaining()), "What you can still spend from your budget"] });
    if (t && lb.sheets.length) {
      sum.push({ kind: "sub", cells: ["Lend & Borrow", "", ""] });
      sum.push({ kind: "data", cells: ["You lent", t.given, "Money you gave to people"] });
      sum.push({ kind: "data", cells: ["They paid back", t.received, "Money you got back from them"] });
      sum.push({ kind: "data", cells: ["They still owe you", t.toReceive, "Still to get"] });
      sum.push({ kind: "data", cells: ["You borrowed", t.borrowed, "Money you took from people"] });
      sum.push({ kind: "data", cells: ["You paid back", t.repaid, "Money you returned"] });
      sum.push({ kind: "data", cells: ["You still owe", t.toPay, "Still to pay"] });
      sum.push({ kind: "data", cells: ["Effect on your budget", lb.net, "Plus (+) = budget grew, minus (-) = budget shrank, 0 = no change"] });
    }
    sum.push({ kind: "blank", cells: [] });
    sum.push({ kind: "note", cells: ["Exported " + niceDay(dateKey(now)) + ". Other sheets: Daily Spending" + (lb.sheets.length ? ", Lend & Borrow, People" : "") + "."] });

    return [{ name: "Summary", rows: sum }, { name: "Daily Spending", rows: daily }, ...lb.sheets, ...(BB.group && BB.group.exportSheet && BB.group.exportSheet() ? [BB.group.exportSheet()] : [])];
  }

  async function exportCsv() {
    const sheets = exportSheets();
    const stamp = "monetra-expense-history";
    const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    const csvCell = (value) => '"' + String(value ?? "").replace(/"/g, '""') + '"';
    const toCsv = (bom) => (bom ? "\uFEFF" : "") + sheets.flatMap((sh) => [[sh.name.toUpperCase()], ...sh.rows.map((r) => r.cells || []), []]).map((row) => row.map(csvCell).join(",")).join("\r\n");
    const toBase64 = (bytes) => { let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); };
    const isNative = !!(Native && window.Capacitor && window.Capacitor.isNativePlatform());

    try {
      /* Phone app: a real Excel file (same as on the laptop: tabs, colours, widths), opened through the share sheet. */
      if (isNative && BB.xlsx && BB.xlsx.build) {
        /* 1) Straight into the Downloads folder, no share menu. */
        try {
          const dl = window.Capacitor.Plugins.MonetraDownloads;
          if (dl && dl.saveBase64) {
            const name = `${stamp}-${dateKey(new Date())}.xlsx`;
            await dl.saveBase64({ filename: name, mimeType: XLSX_TYPE, data: toBase64(BB.xlsx.build(sheets)) });
            toast("Saved in Downloads: " + name, "success");
            return;
          }
        } catch (err) { console.warn("Direct save failed, trying the share menu:", err); }
      }
      /* 2) Fallback: share menu. */
      if (isNative && BB.xlsx && BB.xlsx.build && Native.Filesystem && Native.Share) {
        try {
          const saved = await Native.Filesystem.writeFile({ path: stamp + ".xlsx", data: toBase64(BB.xlsx.build(sheets)), directory: Native.Directory.Cache });
          await Native.Share.share({ title: "MONETRA expense history", url: saved.uri, dialogTitle: "Open or save the Excel file" });
          toast("Excel file ready.", "success");
          return;
        } catch (err) {
          if (err && /cancel|dismiss/i.test(String(err.message || err))) return;
          console.warn("Excel share failed, saving CSV instead:", err);
        }
      }
      if (isNative) {
        await window.Capacitor.Plugins.CsvDownloads.save({ filename: stamp + ".csv", data: toCsv(false) });
        toast("Saved to Downloads (CSV).", "success");
        return;
      }
      let blob, fname;
      if (BB.xlsx && BB.xlsx.build) {
        blob = new Blob([BB.xlsx.build(sheets)], { type: XLSX_TYPE });
        fname = stamp + ".xlsx";
      } else {
        blob = new Blob([toCsv(true)], { type: "text/csv;charset=utf-8;" });
        fname = stamp + ".csv";
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = fname;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast("Expense history exported.", "success");
    } catch (e) {
      console.error("Export failed:", e);
      toast("Export failed: " + (e.message || e), "error");
    }
  }

  /* ---------- Reminder (while the app is open) ---------- */
  let reminderTimer = null;
  function scheduleReminder() {
    if (reminderTimer) clearInterval(reminderTimer);
    reminderTimer = setInterval(() => {
      const now = new Date(); const key = dateKey(now);
      if (now.getHours() === 21 && now.getMinutes() === 0 && state._remindedDate !== key && "Notification" in window && Notification.permission === "granted") {
        if (!state.records[key]) new Notification("MONETRA daily reminder", { body: "You have not recorded today's food spending yet." });
        state._remindedDate = key; saveDraft();
      }
    }, 30000);
  }

  /* Time Machine support: every item (daily spending, loans, groups) that changed the budget in month mk. */
  function tmItems(mk) {
    const out = [];
    for (const key of Object.keys(state.records)) {
      if (monthOf(key) !== mk) continue;
      const s = n(state.records[key].spent);
      if (s) out.push({ id: "spent-" + key, day: Number(key.slice(8, 10)), amount: -s, label: "Daily spending", kind: "spent" });
    }
    for (const x of externals()) {
      if (extMonth(x) !== mk) continue;
      out.push({ id: String(x.id), day: Math.min(daysInMonthKey(mk), extDay(x, mk)), amount: Number(x.amount) || 0, label: x.label || "Adjustment", kind: x.kind || "" });
    }
    return out;
  }
  BB.budget = { snapshot, todayMeals, render: renderAll, chart: chartHtml, flowChart: flowChartHtml, addExternalTransaction, removeExternalTransaction, ensureExternal, externalNet: extNet, flowState: { pick: () => flowPick, month: () => flowMonth || thisMonthKey(), setPick: (mk, day) => { flowMonth = mk; flowPick = { mk, day, key: "bal" }; renderAll(); } }, tm: { compute: flowCompute, items: tmItems, earliest: earliestFlowMonth, nowKey: thisMonthKey } };
  /* Lets the Time Machine drive and follow the dashboard graph (same selected day and month). */
  BB.budget.flowState = {
    pick: () => flowPick,
    month: () => flowMonth || thisMonthKey(),
    setPick(mk, day, cut) { flowMonth = mk; flowPick = { mk, day, key: "bal" }; flowCutPick = cut ? { mk, day } : null; renderAll(); }
  };
  BB.on("udhaar", () => { if (loaded) renderAll(); });
  renderAll();
  load();
})();

/* FIT_NUMBERS: very long numbers are shown in short form (like 9.82e24) so they never leave their box. */
(() => {
  const RX = /(\d{1,3}(?:,\d{3}){4,})(\.\d+)?/g;
  const TEST = /\d{1,3}(?:,\d{3}){4,}/;
  let queued = false;
  function compact() {
    queued = false;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const hits = [];
    while (walker.nextNode()) { const nd = walker.currentNode; if (TEST.test(nd.nodeValue)) hits.push(nd); }
    for (const nd of hits) {
      const full = nd.nodeValue.trim();
      nd.nodeValue = nd.nodeValue.replace(RX, (m, whole) => { const s = whole.replace(/,/g, ""); return s[0] + "." + s.slice(1, 3) + "e" + (s.length - 1); });
      if (nd.parentElement) nd.parentElement.title = full;
    }
  }
  const schedule = () => { if (!queued) { queued = true; requestAnimationFrame(compact); } };
  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true, characterData: true });
  setTimeout(schedule, 0);
  setTimeout(schedule, 1000);
})();

/* KEYBOARD_FIX: on touch phones, hide the bottom tab bar while the keyboard is open and keep the focused field in view. */
(() => {
  const root = document.documentElement;
  const touch = () => window.matchMedia("(pointer: coarse)").matches;
  const isField = (el) => el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) && !/^(checkbox|radio|button|submit|range)$/.test(el.type || "");
  let timer = 0, maxH = window.innerHeight;
  const show = () => root.classList.remove("kb-open");
  document.addEventListener("focusin", (e) => {
    if (!touch() || !isField(e.target)) return;
    clearTimeout(timer);
    root.classList.add("kb-open");
    setTimeout(() => { try { e.target.scrollIntoView({ block: "center", behavior: "smooth" }); } catch (_) { /* ignore */ } }, 250);
  });
  document.addEventListener("focusout", () => { clearTimeout(timer); timer = setTimeout(show, 150); });
  /* Safety: the bar always comes back when the keyboard closes or the user taps outside a field. */
  window.addEventListener("resize", () => { maxH = Math.max(maxH, window.innerHeight); if (window.innerHeight >= maxH - 80) show(); });
  document.addEventListener("pointerdown", (e) => { if (!isField(e.target) && !isField(document.activeElement)) show(); });
  window.addEventListener("pageshow", show);
})();

/* BACK_BUTTON_V3: Android calls this on every back press. It returns true when it handled the press inside the app. */
(() => {
  const visible = (el) => !!el && !el.hidden && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
  window.monetraBack = () => {
    try {
      if (visible(document.getElementById("sheetRoot"))) { if (window.BB && BB.closeSheet) BB.closeSheet(); return true; }
      const personBack = document.querySelector('.screen.is-active [data-action="u-back"]');
      if (personBack) { personBack.click(); return true; }
      const active = document.querySelector(".screen.is-active");
      if (active && active.dataset.screen !== "home") {
        const home = document.querySelector('.tab[data-to="home"]');
        if (home) { home.click(); return true; }
      }
    } catch (_) { /* ignore */ }
    return false;
  };
})();