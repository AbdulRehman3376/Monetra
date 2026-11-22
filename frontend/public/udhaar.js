(() => {
  "use strict";
  const BB = window.BB;
  if (!BB) return;
  const { $, esc, icon, toast, openSheet, closeSheet, confirmSheet } = BB;

  /* ======================================================================
     LEND & BORROW LEDGER
     A separate ledger of money lent to people and money borrowed from them.
     It has its own storage key. Each entry or repayment can change your budget
     (see budgetEffect); the food diary and "Other expense" are never touched.
     ====================================================================== */

  /* ---------- Storage (own key, this device only) ---------- */
  const PROFILE = (() => { try { return localStorage.getItem("budgetbite_profile_id_v1") || "default"; } catch (_) { return "default"; } })();
  const STORE_KEY = `monetra_udhaar_v1_${PROFILE}`;

  /*
    Data shape:
    state.people = [{
      id, name, created,
      entries: [{
        id, type: "gave" | "took",      // gave = I gave money (I will receive), took = I took money (I must pay)
        amount, purpose, date, due, created,
        payments: [{ id, amount, date, note, created, batch }]
      }]
    }]
  */
  let state = { people: [] };
  const view = { tab: "active", personId: null };

  /* ---------- Helpers ---------- */
  const pad = (x) => String(x).padStart(2, "0");
  const dateKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const todayKey = () => dateKey(new Date());
  const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
  const num = (v) => { const x = Number(v); return Number.isFinite(x) && x > 0 ? round2(Math.min(x, 1e8)) : 0; };
  const uid = (p) => `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const money = (v) => "Rs. " + (Number(v) || 0).toLocaleString("en-PK", { maximumFractionDigits: 2 });
  const isDateKey = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));
  const fmtDate = (k) => {
    if (!isDateKey(k)) return "";
    return new Date(Number(k.slice(0, 4)), Number(k.slice(5, 7)) - 1, Number(k.slice(8, 10))).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  };
  const csvDate = (k) => (isDateKey(k) ? `${k.slice(8, 10)}/${k.slice(5, 7)}/${k.slice(0, 4)}` : "");
  const initials = (name) => String(name).trim().split(/\s+/).slice(0, 2).map((w) => w.charAt(0).toUpperCase()).join("") || "?";
  const nowTime = () => new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
  const sameName = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

  /* ---------- Entry maths (remaining balance is always calculated, never stored) ---------- */
  const paid = (e) => round2((e.payments || []).reduce((s, p) => s + num(p.amount), 0));
  const left = (e) => Math.max(0, round2(num(e.amount) - paid(e)));
  const isOpen = (e) => left(e) > 0;
  const isOverdue = (e) => Boolean(e.due) && isOpen(e) && e.due < todayKey();
  const lastPaymentDate = (e) => (e.payments || []).reduce((m, p) => (p.date > m ? p.date : m), "");
  const byDate = (a, b) => (a.date === b.date ? (a.created || 0) - (b.created || 0) : a.date < b.date ? -1 : 1);

  const sums = (p) => {
    let get = 0, owe = 0, gaveTotal = 0, tookTotal = 0, gaveBack = 0, tookBack = 0;
    for (const e of p.entries) {
      if (e.type === "gave") { gaveTotal += num(e.amount); gaveBack += paid(e); get += left(e); }
      else { tookTotal += num(e.amount); tookBack += paid(e); owe += left(e); }
    }
    return { get: round2(get), owe: round2(owe), gaveTotal: round2(gaveTotal), tookTotal: round2(tookTotal), gaveBack: round2(gaveBack), tookBack: round2(tookBack) };
  };
  const openEntries = (p) => p.entries.filter(isOpen);
  const hasOpen = (p) => p.entries.some(isOpen);
  const findPerson = (id) => state.people.find((p) => p.id === id);
  const findByName = (name) => state.people.find((p) => sameName(p.name, name));
  const nextDue = (p) => openEntries(p).map((e) => e.due).filter(Boolean).sort()[0] || "";

  /* ---------- Persistence ---------- */
  function load() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
      state = { people: Array.isArray(raw.people) ? raw.people : [] };
    } catch (_) { state = { people: [] }; }
    state.people.forEach((p) => {
      if (!Array.isArray(p.entries)) p.entries = [];
      p.entries.forEach((e) => { if (!Array.isArray(e.payments)) e.payments = []; });
    });
  }
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }
    catch (_) { toast("Could not save on this device.", "error"); }
    render();
    BB.emit("udhaar");
  }

  /* ---------- Rendering ---------- */
  const typeLabel = (t) => (t === "gave" ? "You gave" : "You took");
  const dueChip = (e) => {
    if (!e.due || !isOpen(e)) return "";
    return isOverdue(e) ? `<span class="chip over">Overdue</span>` : `<span class="chip ok">Due ${esc(fmtDate(e.due))}</span>`;
  };

  function render() {
    const root = $("#udhaarRoot");
    if (!root) return;
    const person = view.personId ? findPerson(view.personId) : null;
    if (view.personId && !person) view.personId = null;
    root.innerHTML = person ? personHtml(person) : listHtml();
    if (!person) root.insertAdjacentHTML("afterbegin", [BB.timeMachine, BB.group].map((m) => (m && m.cardHtml ? m.cardHtml() : "")).join(""));
  }
  function resetScroll() { const r = $("#udhaarRoot"); if (r) r.scrollTop = 0; }

  function listHtml() {
    const all = state.people.map((p) => ({ p, s: sums(p) }));
    const totalGet = round2(all.reduce((t, x) => t + x.s.get, 0));
    const totalOwe = round2(all.reduce((t, x) => t + x.s.owe, 0));
    const tot = totals();
    const active = all.filter((x) => hasOpen(x.p)).sort((a, b) => (b.s.get + b.s.owe) - (a.s.get + a.s.owe));

    const activeRows = active.map(({ p, s }) => {
      const due = nextDue(p);
      const overdue = openEntries(p).some(isOverdue);
      const count = openEntries(p).length;
      const sub = `${count} open ${count === 1 ? "entry" : "entries"}${due ? " · due " + esc(fmtDate(due)) : ""}`;
      const amts = [
        s.get > 0 ? `<b class="u-get">${money(s.get)}</b><small>owes you</small>` : "",
        s.owe > 0 ? `<b class="u-owe">${money(s.owe)}</b><small>you owe</small>` : ""
      ].filter(Boolean).join("");
      return `<button class="u-person" type="button" data-action="u-open" data-id="${esc(p.id)}">
        <span class="u-avatar" aria-hidden="true">${esc(initials(p.name))}</span>
        <span class="u-main"><strong>${esc(p.name)}</strong><small>${sub}${overdue ? ` <span class="chip over">Overdue</span>` : ""}</small></span>
        <span class="u-amt">${amts}</span></button>`;
    }).join("");

    const settled = [];
    for (const p of state.people) for (const e of p.entries) if (!isOpen(e)) settled.push({ p, e, at: lastPaymentDate(e) || e.date });
    settled.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    const historyRows = settled.map(({ p, e, at }) => `<button class="u-person" type="button" data-action="u-open" data-id="${esc(p.id)}">
        <span class="u-avatar" aria-hidden="true">${esc(initials(p.name))}</span>
        <span class="u-main"><strong>${esc(p.name)}</strong><small>${esc(e.purpose)} · ${e.type === "gave" ? "you gave" : "you took"} · settled ${esc(fmtDate(at))}</small></span>
        <span class="u-amt"><b>${money(e.amount)}</b><small>settled</small></span></button>`).join("");

    const body = view.tab === "active"
      ? (activeRows || `<p class="hint" style="text-align:center;padding:14px 0 6px">Nothing active. Tap “Add entry” to record money you gave or took.</p>`)
      : (historyRows || `<p class="hint" style="text-align:center;padding:14px 0 6px">No settled entries yet. Fully paid entries move here and stay saved.</p>`);

    return `
      <header class="screen-head" style="padding-left:0;padding-right:0">
        <div><p class="eyebrow">People ledger</p><h1>Lend &amp; Borrow</h1></div>
        <span class="sync online">Budget connected</span>
      </header>
      <section class="card overview">
        <span class="lbl">Open balance</span>
        <div class="ov-grid">
          <div><span>You will get</span><b class="u-get">${money(totalGet)}</b></div>
          <div><span>You have to pay</span><b class="u-owe">${money(totalOwe)}</b></div>
          <div><span>Lent (given)</span><b>${money(tot.given)}</b></div>
          <div><span>Received back</span><b>${money(tot.received)}</b></div>
          <div><span>Borrowed</span><b>${money(tot.borrowed)}</b></div>
          <div><span>Repaid</span><b>${money(tot.repaid)}</b></div>
          <div class="t-in"><span>Added to your budget<small>Net, after repayments</small></span><b>+ ${money(Math.max(0, tot.budgetIn - tot.budgetOut))}</b></div>
          <div class="t-out"><span>Taken from your budget<small>Net, after money received back</small></span><b>\u2212 ${money(Math.max(0, tot.budgetOut - tot.budgetIn))}</b></div>
        </div>
        <p class="hint" style="margin-top:10px">Both are net. Money in (received back, borrowed money you added) and money out (money you lent, repayments you deducted) cancel each other, so a loan you added and then repaid shows as nothing.</p>
      </section>
      <button class="btn primary block" type="button" data-action="u-add" style="margin:14px 0">${icon("plus")}Add entry</button>
      <section class="card">
        <div class="seg" role="group" aria-label="Lend and borrow view" style="margin-bottom:12px">
          <button type="button" data-action="u-tab" data-v="active" aria-pressed="${view.tab === "active"}">Active</button>
          <button type="button" data-action="u-tab" data-v="history" aria-pressed="${view.tab === "history"}">History</button>
        </div>
        ${body}
      </section>
      <p class="fine-print">Budget adjustments follow the options selected when each entry or repayment is recorded. Full ledger history remains available in CSV export.</p>`;
  }

  function personHtml(p) {
    const s = sums(p);
    const open = openEntries(p).sort(byDate);
    const closed = p.entries.filter((e) => !isOpen(e)).sort((a, b) => (lastPaymentDate(b) || b.date).localeCompare(lastPaymentDate(a) || a.date));

    const entryCard = (e) => {
      const pct = num(e.amount) > 0 ? Math.min(100, (paid(e) / num(e.amount)) * 100) : 0;
      return `<div class="u-entry">
        <div class="u-entry-top"><div><span class="tag ${e.type === "gave" ? "verified" : ""}">${typeLabel(e.type)}</span> ${dueChip(e)}<strong class="u-purpose">${esc(e.purpose)}</strong><small class="hint">${esc(fmtDate(e.date))}${e.due ? " · due " + esc(fmtDate(e.due)) : ""}</small></div>
          <button class="x u-x" type="button" data-action="u-del-entry" data-pid="${esc(p.id)}" data-id="${esc(e.id)}" aria-label="Delete entry">${icon("trash")}</button></div>
        <div class="bar"><i style="width:${pct}%"></i></div>
        <div class="u-rows">
          <div><span>Original amount</span><b>${money(e.amount)}</b></div>
          <div><span>${e.type === "gave" ? "Received back" : "Paid back"}</span><b>${money(paid(e))}</b></div>
          <div class="u-left"><span>Remaining balance</span><b>${money(left(e))}</b></div>
        </div>
        <button class="btn soft block" type="button" data-action="u-pay" data-pid="${esc(p.id)}" data-eid="${esc(e.id)}" style="margin-top:10px">${icon("plus")}${e.type === "gave" ? "Add received amount" : "Add repayment"}</button>
      </div>`;
    };

    /* Complete history: every loan and every repayment, newest first. */
    const events = [];
    for (const e of open) {
      events.push({ k: "loan", date: e.date, created: e.created || 0, e });
      for (const pay of e.payments) events.push({ k: "pay", date: pay.date, created: pay.created || 0, e, pay });
    }
    events.sort((a, b) => (a.date === b.date ? b.created - a.created : a.date < b.date ? 1 : -1));
    const timeline = events.map((ev) => {
      if (ev.k === "loan") {
        return `<div class="meal"><span class="tile" aria-hidden="true">${ev.e.type === "gave" ? "\u{1F4B8}" : "\u{1F91D}"}</span><div class="meal-main"><strong>${ev.e.type === "gave" ? "You gave" : "You took"} · ${esc(ev.e.purpose)}</strong><small>${esc(fmtDate(ev.date))}${isOpen(ev.e) ? "" : " · settled"}</small></div><b>${money(ev.e.amount)}</b></div>`;
      }
      return `<div class="meal"><span class="tile" aria-hidden="true">\u2705</span><div class="meal-main"><strong>${ev.e.type === "gave" ? "Received back" : "Paid back"} · ${esc(ev.e.purpose)}</strong><small>${esc(fmtDate(ev.date))}${ev.pay.note ? " · " + esc(ev.pay.note) : ""}</small></div><b>${money(ev.pay.amount)}</b>
        <button class="x" type="button" data-action="u-del-pay" data-pid="${esc(p.id)}" data-eid="${esc(ev.e.id)}" data-id="${esc(ev.pay.id)}" aria-label="Delete repayment">${icon("close")}</button></div>`;
    }).join("");

    return `
      <header class="screen-head" style="padding-left:0;padding-right:0">
        <div class="u-head"><button class="icon-btn" type="button" data-action="u-back" aria-label="Back to Lend and Borrow">${icon("back")}</button><div><p class="eyebrow">Person account</p><h1>${esc(p.name)}</h1></div></div>
        <button class="icon-btn" type="button" data-action="u-del-person" data-pid="${esc(p.id)}" aria-label="Delete ${esc(p.name)}">${icon("trash")}</button>
      </header>
      <section class="card overview">
        <span class="lbl">Balance with ${esc(p.name)}</span>
        <div class="ov-grid">
          <div><span>To receive</span><b class="u-get">${money(s.get)}</b></div>
          <div><span>To pay</span><b class="u-owe">${money(s.owe)}</b></div>
          <div><span>Received back so far</span><b>${money(s.gaveBack)}</b></div>
          <div><span>Paid back so far</span><b>${money(s.tookBack)}</b></div>
        </div>
      </section>
      <div class="btn-pair">
        <button class="btn primary" type="button" data-action="u-add" data-name="${esc(p.name)}">${icon("plus")}New entry</button>
        <button class="btn ghost" type="button" data-action="u-pay" data-pid="${esc(p.id)}" ${open.length ? "" : "disabled"}>Add repayment</button>
      </div>
      <section class="card">
        <h2>Open entries</h2>
        <p class="sub">${open.length ? "Add repayments here. A fully paid entry moves to history automatically." : "Nothing is pending with this person."}</p>
        ${open.map(entryCard).join("")}
      </section>
      <section class="card">
        <h2>Transaction history</h2>
        <p class="sub">Only pending entries and their repayments are shown. Settled entries leave this list and stay saved in the CSV export.${closed.length ? ` ${closed.length} settled ${closed.length === 1 ? "entry" : "entries"} saved in CSV.` : ""}</p>
        ${timeline || `<p class="hint">Nothing pending.</p>`}
      </section>`;
  }

  /* ---------- Sheets ---------- */
  const namesList = () => `<datalist id="uPeople">${state.people.map((p) => `<option value="${esc(p.name)}"></option>`).join("")}</datalist>`;

  function openAddSheet(prefillName = "") {
    openSheet(`<h2>Add entry</h2>
      <p class="sheet-sub">Every entry is saved in this ledger with its full history.</p>
      <form data-form="udhaar" novalidate>
        <div class="field"><span>What happened?</span>
          <div class="seg" role="group" aria-label="Entry type">
            <label><input type="radio" name="type" value="gave" checked><span>I gave money</span></label>
            <label><input type="radio" name="type" value="took"><span>I took money</span></label>
          </div></div>
        <label class="field"><span>Person name</span><input name="name" maxlength="60" autocomplete="off" placeholder="e.g. Ali" value="${esc(prefillName)}" ${prefillName ? "" : "autofocus"}></label>${namesList()}
        <label class="field"><span>Amount (PKR)</span><input name="amount" type="number" inputmode="decimal" min="1" step="any" placeholder="e.g. 1500" ${prefillName ? "autofocus" : ""}></label>
        <label class="field"><span>Purpose</span><input name="purpose" maxlength="120" placeholder="e.g. Lunch, books, rent share"></label>
        <p class="hint" style="margin:-8px 0 14px">Same name and same purpose as an open entry the other way? It is matched with it automatically.</p>
        <label class="field"><span>Date</span><input name="date" type="date" value="${todayKey()}"></label>
        <label class="field"><span>Due date <i>optional</i></span><input name="due" type="date"></label>
        <p class="hint u-opt-gave" style="margin:-4px 0 14px">This amount is deducted from your available budget automatically.</p>
        <label class="field u-opt-took" hidden><span><input type="checkbox" name="includeBudget" value="yes"> Add to my budget</span></label>
        <p class="hint u-opt-took" style="margin:-8px 0 14px" hidden>Leave it unticked to only save the record. Your budget will not change.</p>
        <p class="form-error" hidden></p>
        <button class="btn primary block" type="submit">Save entry</button>
      </form>`);
  }

  function openPaySheet(pid, eid) {
    const p = findPerson(pid);
    if (!p) return;
    const entry = eid ? p.entries.find((e) => e.id === eid) : null;
    if (eid && (!entry || !isOpen(entry))) { toast("That entry is already settled.", "error"); return; }
    const pool = (type) => (entry ? [entry] : openEntries(p).filter((e) => e.type === type));
    const leftOf = (type) => round2(pool(type).reduce((t, e) => t + left(e), 0));
    const gaveLeft = entry ? (entry.type === "gave" ? left(entry) : 0) : leftOf("gave");
    const tookLeft = entry ? (entry.type === "took" ? left(entry) : 0) : leftOf("took");
    if (gaveLeft <= 0 && tookLeft <= 0) { toast("Nothing is pending with this person.", "error"); return; }
    const both = gaveLeft > 0 && tookLeft > 0;
    const first = gaveLeft > 0 ? "gave" : "took";
    const firstLeft = first === "gave" ? gaveLeft : tookLeft;
    /* If the borrowed money was added to the budget, repaying it should normally take it out again. */
    const tookAdded = pool("took").some((e) => e.type === "took" && Number(e.budgetEffect) > 0);

    const typePicker = both
      ? `<div class="field"><span>Who paid?</span><div class="seg" role="group" aria-label="Repayment direction">
          <label><input type="radio" name="ptype" value="gave" checked><span>They paid me</span></label>
          <label><input type="radio" name="ptype" value="took"><span>I paid them</span></label></div></div>`
      : `<input type="hidden" name="ptype" value="${first}">`;
    const intro = both ? "Choose who paid, then enter the amount."
      : first === "gave" ? `Money received back from ${esc(p.name)}.` : `Money you paid back to ${esc(p.name)}.`;
    const scope = entry ? ` for “${esc(entry.purpose)}”` : "";

    openSheet(`<h2>Add repayment</h2>
      <p class="sheet-sub">${intro}${scope} The remaining balance updates automatically.</p>
      <form data-form="upay" data-gave="${gaveLeft}" data-took="${tookLeft}" novalidate>
        <input type="hidden" name="pid" value="${esc(p.id)}"><input type="hidden" name="eid" value="${esc(eid || "")}">
        ${typePicker}
        <label class="field"><span>Amount (PKR)</span><input name="amount" type="number" inputmode="decimal" min="0.01" step="any" placeholder="e.g. 500" autofocus></label>
        <p class="hint u-left-hint" style="margin:-6px 0 14px">Remaining: <b data-role="left">${money(firstLeft)}</b> · <button class="link inline" type="button" data-action="u-fill" data-fill="${firstLeft}">Use full amount</button></p>
        <label class="field"><span>Date</span><input name="date" type="date" value="${todayKey()}"></label>
        <label class="field"><span>Note <i>optional</i></span><input name="note" maxlength="120" placeholder="e.g. Sent by bank transfer"></label>
        <p class="hint u-opt-gave" style="margin:-4px 0 14px" ${first === "gave" ? "" : "hidden"}>The money you receive is added back to your available budget automatically.</p>
        <label class="field u-opt-took" ${first === "took" ? "" : "hidden"}><span><input type="checkbox" name="includeBudget" value="yes" ${tookAdded ? "checked" : ""}> Deduct from my budget</span></label>
        <p class="hint u-opt-took" style="margin:-8px 0 14px" ${first === "took" ? "" : "hidden"}>Leave it unticked to only save the record. Your budget will not change.</p>
        <p class="form-error" hidden></p>
        <button class="btn primary block" type="submit">Save repayment</button>
      </form>`);
  }

  /* ---------- Actions ---------- */
  Object.assign(BB.actions, {
    "u-add": (el) => openAddSheet(el.dataset.name || ""),
    "u-pay": (el) => openPaySheet(el.dataset.pid, el.dataset.eid || ""),
    "u-fill": (el) => {
      const form = el.closest("form"); const input = form && form.querySelector('input[name="amount"]');
      if (input) { input.value = el.dataset.fill; input.focus(); }
    },
    "u-open": (el) => { view.personId = el.dataset.id; render(); resetScroll(); },
    "u-back": () => { view.personId = null; render(); resetScroll(); },
    "u-tab": (el) => { view.tab = el.dataset.v === "history" ? "history" : "active"; render(); },
    "u-del-entry": async (el) => {
      const p = findPerson(el.dataset.pid); const e = p && p.entries.find((x) => x.id === el.dataset.id);
      if (!e) return;
      if (!(await confirmSheet({ title: "Delete this entry?", message: `“${e.purpose}” (${money(e.amount)}) and its repayments will be removed from the ledger.`, confirmLabel: "Delete" }))) return;
      if (BB.budget && BB.budget.removeExternalTransaction) {
        BB.budget.removeExternalTransaction(`udhaar-entry-${e.id}`);
        (e.payments || []).forEach((payment) =>
          BB.budget.removeExternalTransaction(`udhaar-payment-${payment.id}`)
        );
      }
      p.entries = p.entries.filter((x) => x.id !== e.id); save(); toast("Entry deleted", "success");
    },
    "u-del-pay": async (el) => {
      const p = findPerson(el.dataset.pid); const e = p && p.entries.find((x) => x.id === el.dataset.eid);
      const pay = e && e.payments.find((x) => x.id === el.dataset.id);
      if (!pay) return;
      if (!(await confirmSheet({ title: "Delete this repayment?", message: `${money(pay.amount)} will be added back to the remaining balance.`, confirmLabel: "Delete" }))) return;
      if (BB.budget && BB.budget.removeExternalTransaction) {
        BB.budget.removeExternalTransaction(`udhaar-payment-${pay.id}`);
      }
      e.payments = e.payments.filter((x) => x.id !== pay.id); save(); toast("Repayment deleted", "success");
    },
    "u-del-person": async (el) => {
      const p = findPerson(el.dataset.pid);
      if (!p) return;
      if (!(await confirmSheet({ title: `Delete ${p.name}?`, message: "This permanently removes this person account and all of its entries and repayments.", confirmLabel: "Delete person" }))) return;
      if (BB.budget && BB.budget.removeExternalTransaction) {
        p.entries.forEach((entry) => {
          BB.budget.removeExternalTransaction(`udhaar-entry-${entry.id}`);
          (entry.payments || []).forEach((payment) =>
            BB.budget.removeExternalTransaction(`udhaar-payment-${payment.id}`)
          );
        });
      }
      state.people = state.people.filter((x) => x.id !== p.id); view.personId = null; save(); resetScroll(); toast("Person deleted", "success");
    }
  });

  /* ---------- Forms ---------- */
  const failWith = (form) => (m) => { const err = $(".form-error", form); err.textContent = m; err.hidden = false; };

  Object.assign(BB.forms, {
    udhaar: (form) => {
      const fd = new FormData(form); const fail = failWith(form);
      const type = fd.get("type") === "took" ? "took" : "gave";
      const name = String(fd.get("name") || "").trim().replace(/\s+/g, " ");
      const amount = num(fd.get("amount"));
      const purpose = String(fd.get("purpose") || "").trim();
      const date = String(fd.get("date") || ""); const due = String(fd.get("due") || "");
      if (!name) return fail("Enter the person's name.");
      if (amount <= 0) return fail("Enter an amount greater than zero.");
      if (!purpose) return fail("Enter what the money was for.");
      if (!isDateKey(date)) return fail("Choose the date.");
      if (due && !isDateKey(due)) return fail("Choose a valid due date.");
      if (due && due < date) return fail("The due date cannot be before the entry date.");
      let person = findByName(name);
      if (!person) { person = { id: uid("p"), name, created: Date.now(), entries: [] }; state.people.push(person); }
      /* Same person + same purpose, opposite direction (e.g. you lent Usman 7600 for pizza, he gives 4000 for pizza):
         match it against the open entry instead of making a new one. Only the extra amount, if any, becomes a new entry. */
      const norm = (t) => String(t || "").toLowerCase().replace(/\s+/g, " ").trim();
      const pn = norm(purpose), opp = type === "gave" ? "took" : "gave";
      const same = (e) => { if (e.auto && e.noTitle) return false; const q = norm(e.purpose); return q === pn || (pn.length >= 3 && q.length >= 3 && (q.includes(pn) || pn.includes(q))); };
      const matches = person.entries.filter((e) => e.type === opp && isOpen(e) && same(e))
        .sort((x, y) => ((norm(y.purpose) === pn) - (norm(x.purpose) === pn)) || byDate(x, y));
      let rest = amount, matched = 0, matchedName = "", leftAfter = 0;
      for (const e of matches) {
        if (rest <= 0) break;
        const take = Math.min(left(e), rest);
        if (take <= 0) continue;
        const paymentId = uid("r");
        const budgetEffect = e.type === "gave" ? take : (Number(e.budgetEffect) > 0 ? -take : 0);
        e.payments.push({ id: paymentId, amount: round2(take), date, note: purpose, created: Date.now(), time: nowTime(), batch: uid("b"), budgetEffect, synced: true });
        if (budgetEffect && BB.budget && BB.budget.addExternalTransaction) {
          BB.budget.addExternalTransaction(`udhaar-payment-${paymentId}`, date, budgetEffect, `${person.name}: ${purpose}`, e.type === "gave" ? "recv" : "paid");
        }
        rest = round2(rest - take); matched = round2(matched + take); matchedName = e.purpose; leftAfter = left(e);
      }
      if (matched > 0 && rest <= 0) {
        closeSheet(); save();
        toast(leftAfter > 0 ? `${money(matched)} matched with “${matchedName}”. ${money(leftAfter)} still remaining` : `${money(matched)} matched. “${matchedName}” is fully settled`, "success");
        return;
      }
      const newAmt = rest;
      const entryId = uid("e");
      const includeBudget = fd.get("includeBudget") === "yes";
      const budgetEffect = type === "gave" ? -newAmt : (includeBudget ? newAmt : 0);
      person.entries.push({
        id: entryId, type, amount: newAmt, purpose, date, due,
        created: Date.now(), time: nowTime(), payments: [], budgetEffect, synced: true
      });
      if (budgetEffect && BB.budget && BB.budget.addExternalTransaction) {
        BB.budget.addExternalTransaction(
          `udhaar-entry-${entryId}`, date, budgetEffect, `${person.name}: ${purpose}`, type
        );
      }
      closeSheet(); save();
      toast(type === "gave" ? `${money(newAmt)} recorded: ${person.name} owes you` : `${money(newAmt)} recorded: you owe ${person.name}`, "success");
    },
    upay: (form) => {
      const fd = new FormData(form); const fail = failWith(form);
      const p = findPerson(String(fd.get("pid") || ""));
      if (!p) { closeSheet(); return; }
      const eid = String(fd.get("eid") || "");
      const amount = num(fd.get("amount")); const date = String(fd.get("date") || ""); const note = String(fd.get("note") || "").trim();
      const type = fd.get("ptype") === "took" ? "took" : "gave";
      const pool = (eid ? p.entries.filter((e) => e.id === eid) : p.entries.filter((e) => e.type === type)).filter(isOpen).sort(byDate);
      const max = round2(pool.reduce((t, e) => t + left(e), 0));
      if (!pool.length) return fail("Nothing is pending for this selection.");
      if (amount <= 0) return fail("Enter an amount greater than zero.");
      if (!isDateKey(date)) return fail("Choose the date.");
      if (amount > max) return fail(`Only ${money(max)} is remaining. Enter ${money(max)} or less.`);

      /* Apply to the oldest open entries first, so one repayment can clear several entries. */
      let rest = amount; const batch = uid("b");
      for (const e of pool) {
        if (rest <= 0) break;
        const take = Math.min(left(e), rest);
        if (take <= 0) continue;
        const paymentId = uid("r");
        const includeBudget = fd.get("includeBudget") === "yes";
        const budgetEffect = e.type === "gave" ? take : (includeBudget ? -take : 0);
        e.payments.push({
          id: paymentId, amount: round2(take), date, note,
          created: Date.now(), time: nowTime(), batch, budgetEffect, synced: true
        });
        if (budgetEffect && BB.budget && BB.budget.addExternalTransaction) {
          BB.budget.addExternalTransaction(
            `udhaar-payment-${paymentId}`, date, budgetEffect, `${p.name}: ${note || e.purpose}`, e.type === "gave" ? "recv" : "paid"
          );
        }
        rest = round2(rest - take);
      }
      const settledNow = !pool.some(isOpen);
      closeSheet(); save();
      toast(settledNow ? "Fully settled. Moved to history." : `${money(amount)} added. ${money(round2(max - amount))} remaining`, "success");
    }
  });

  /* Show the budget option that belongs to the selected direction. */
  document.addEventListener("change", (e) => {
    const t = e.target;
    if (!t || t.type !== "radio" || (t.name !== "type" && t.name !== "ptype")) return;
    const form = t.closest("form"); if (!form) return;
    const took = t.value === "took";
    form.querySelectorAll(".u-opt-took").forEach((el) => { el.hidden = !took; });
    form.querySelectorAll(".u-opt-gave").forEach((el) => { el.hidden = took; });
    const box = form.querySelector('input[name="includeBudget"]');
    if (box && t.name === "type") box.checked = false;
  });

  /* Update the "remaining" hint when the repayment direction changes. */
  document.addEventListener("change", (e) => {
    const t = e.target;
    if (!t || t.name !== "ptype" || t.type !== "radio") return;
    const form = t.closest("form[data-form=\"upay\"]"); if (!form) return;
    const val = t.value === "took" ? Number(form.dataset.took) : Number(form.dataset.gave);
    const b = form.querySelector('[data-role="left"]'); if (b) b.textContent = money(val);
    const fill = form.querySelector('[data-action="u-fill"]'); if (fill) fill.dataset.fill = String(val);
  });

  /* ---------- Chronological ledger: one row per loan and per repayment ---------- */
  const effectOf = (kind, amount, stored) => (stored !== undefined && stored !== null ? Number(stored) || 0 : kind === "gave" ? -amount : kind === "recv" ? amount : 0);
  const budgetText = (v) => (v > 0 ? "Added to budget" : v < 0 ? "Deducted from budget" : "Record only (budget not changed)");
  function ledgerList() {
    const list = [];
    for (const p of state.people) {
      for (const e of p.entries) {
        const amt = num(e.amount);
        const eff = effectOf(e.type, amt, e.budgetEffect);
        list.push({ date: e.date, time: e.time || "", created: e.created || 0, person: p.name, id: e.id,
          type: e.type === "gave" ? "Lent (money given)" : "Borrowed (money taken)",
          from: e.type === "gave" ? "Me" : p.name, to: e.type === "gave" ? p.name : "Me",
          given: e.type === "gave" ? amt : 0, received: 0, borrowed: e.type === "took" ? amt : 0, repaid: 0,
          purpose: e.purpose, due: e.due, eff, remaining: amt, status: "", eOpen: isOpen(e), eOver: isOverdue(e) });
        let run = amt;
        for (const pay of e.payments.slice().sort(byDate)) {
          const pa = num(pay.amount); run = Math.max(0, round2(run - pa));
          const kind = e.type === "gave" ? "recv" : "paid";
          list.push({ date: pay.date, time: pay.time || "", created: pay.created || 0, person: p.name, id: pay.id,
            type: e.type === "gave" ? "Received back" : "Repaid (paid back)",
            from: e.type === "gave" ? p.name : "Me", to: e.type === "gave" ? "Me" : p.name,
            given: 0, received: e.type === "gave" ? pa : 0, borrowed: 0, repaid: e.type === "took" ? pa : 0,
            purpose: "Repayment for: " + e.purpose + (pay.note ? " (" + pay.note + ")" : ""), due: "",
            eff: effectOf(kind, pa, pay.budgetEffect), remaining: run, status: run <= 0 ? "Settled" : "", eOpen: isOpen(e), eOver: isOverdue(e) });
        }
      }
    }
    return list.sort((a, b) => (a.date === b.date ? a.created - b.created : a.date < b.date ? -1 : 1));
  }

  /* Totals for the Home / Budget / Loans summary cards. */
  function totals() {
    const t = { given: 0, received: 0, borrowed: 0, repaid: 0, toReceive: 0, toPay: 0, count: 0 };
    for (const p of state.people) {
      const s = sums(p);
      t.given += s.gaveTotal; t.received += s.gaveBack; t.borrowed += s.tookTotal; t.repaid += s.tookBack; t.toReceive += s.get; t.toPay += s.owe; t.count += p.entries.length;
    }
    t.budgetIn = 0; t.budgetOut = 0;
    for (const r of ledgerList()) { if (r.eff > 0) t.budgetIn += r.eff; else t.budgetOut += -r.eff; }
    Object.keys(t).forEach((k) => { t[k] = round2(t[k]); });
    return t;
  }
  /* Every movement with its date, for the graph. kinds: gave, recv, took, paid */
  function events() {
    const out = [];
    for (const p of state.people) for (const e of p.entries) {
      out.push({ date: e.date, kind: e.type, amount: num(e.amount), person: p.name, counted: effectOf(e.type, num(e.amount), e.budgetEffect) !== 0 });
      for (const pay of e.payments) { const k = e.type === "gave" ? "recv" : "paid"; out.push({ date: pay.date, kind: k, amount: num(pay.amount), person: p.name, counted: effectOf(k, num(pay.amount), pay.budgetEffect) !== 0 }); }
    }
    return out;
  }
  /* Older entries saved before the budget link existed: add their budget effect once. */
  function syncBudget() {
    if (!(BB.budget && BB.budget.ensureExternal)) return;
    const add = []; let changed = false;
    for (const p of state.people) for (const e of p.entries) {
      if (!e.synced) {
        e.synced = true; changed = true;
        const eff = effectOf(e.type, num(e.amount), e.budgetEffect);
        if (eff) add.push({ id: `udhaar-entry-${e.id}`, date: e.date, amount: eff, label: `${p.name}: ${e.purpose}`, kind: e.type });
      }
      for (const pay of e.payments) if (!pay.synced) {
        pay.synced = true; changed = true;
        const eff = effectOf(e.type === "gave" ? "recv" : "paid", num(pay.amount), pay.budgetEffect);
        if (eff) add.push({ id: `udhaar-payment-${pay.id}`, date: pay.date, amount: eff, label: `${p.name}: ${pay.note || e.purpose}`, kind: e.type === "gave" ? "recv" : "paid" });
      }
    }
    if (changed) { try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (_) { /* ignore */ } }
    if (add.length) BB.budget.ensureExternal(add);
  }

  /* ---------- Rows for the main CSV export (budget.js appends them after the food expenses) ---------- */
  function csvRows() {
    const people = state.people.slice().sort((a, b) => a.name.localeCompare(b.name));
    const rows = [["SECTION 2: LEND & BORROW LEDGER (food expense totals in Section 1 are not changed by it; the effect on your budget is shown on every row)"]];
    if (!people.some((p) => p.entries.length)) { rows.push(["No lend or borrow records yet."]); return rows; }

    /* 2-0: overall summary */
    const t = totals();
    rows.push([], ["2-0. OVERALL SUMMARY"]);
    rows.push(["Total lent / given (PKR)", "Received back (PKR)", "Still to receive (PKR)", "Total borrowed (PKR)", "Repaid (PKR)", "Still to pay (PKR)", "Net effect on budget (PKR)"]);
    const ledger = ledgerList();
    rows.push([t.given, t.received, t.toReceive, t.borrowed, t.repaid, t.toPay, round2(ledger.reduce((a, r) => a + r.eff, 0))]);

    /* 2-1: every transaction in date order */
    rows.push([], ["2-1. FULL TRANSACTION HISTORY (oldest first)"]);
    rows.push(["Date", "Time", "Transaction", "Money paid by", "Money paid to", "Person", "Amount given (PKR)", "Amount received back (PKR)", "Amount borrowed (PKR)", "Amount repaid (PKR)", "Purpose / Note", "Due date", "Remaining on this loan after (PKR)", "Loan status", "Budget effect (PKR)", "Budget", "Transaction ID"]);
    for (const r of ledger) rows.push([csvDate(r.date), r.time, r.type, r.from, r.to, r.person, r.given || "", r.received || "", r.borrowed || "", r.repaid || "", r.purpose, csvDate(r.due), r.remaining, r.status, r.eff, budgetText(r.eff), r.id]);
    rows.push(["TOTAL", "", "", "", "", "", t.given, t.received, t.borrowed, t.repaid, "", "", "", "", round2(ledger.reduce((a, r) => a + r.eff, 0)), "", ""]);

    /* 2A: one row per person */
    rows.push([], ["2-2. PEOPLE SUMMARY"]);
    rows.push(["Person", "Total you gave (PKR)", "Received back (PKR)", "Still to receive (PKR)", "Total you took (PKR)", "Paid back (PKR)", "Still to pay (PKR)", "Net balance (PKR)", "Net meaning", "Open entries", "Settled entries"]);
    const g = { gaveTotal: 0, gaveBack: 0, get: 0, tookTotal: 0, tookBack: 0, owe: 0, open: 0, closed: 0 };
    for (const p of people) {
      const s = sums(p); const open = openEntries(p).length; const closed = p.entries.length - open;
      const net = round2(s.get - s.owe);
      rows.push([p.name, s.gaveTotal, s.gaveBack, s.get, s.tookTotal, s.tookBack, s.owe, net, net > 0 ? "They owe you" : net < 0 ? "You owe them" : "All settled", open, closed]);
      g.gaveTotal += s.gaveTotal; g.gaveBack += s.gaveBack; g.get += s.get; g.tookTotal += s.tookTotal; g.tookBack += s.tookBack; g.owe += s.owe; g.open += open; g.closed += closed;
    }
    const gnet = round2(g.get - g.owe);
    rows.push(["ALL PEOPLE", round2(g.gaveTotal), round2(g.gaveBack), round2(g.get), round2(g.tookTotal), round2(g.tookBack), round2(g.owe), gnet, gnet > 0 ? "They owe you" : gnet < 0 ? "You owe them" : "All settled", g.open, g.closed]);

    /* 2B: every entry, with its repayments listed directly under it */
    rows.push([], ["2-3. DETAILS BY PERSON (each entry is followed by its repayments)"]);
    rows.push(["Repayment rows show the original amount of the entry they belong to. Remaining balance on a repayment row is the balance right after that repayment."]);
    rows.push(["Person", "Record", "Direction", "Purpose / Note", "Date", "Due date", "Original amount (PKR)", "Returned / paid amount (PKR)", "Remaining balance (PKR)", "Status", "Settled on"]);
    for (const p of people) {
      for (const e of p.entries.slice().sort(byDate)) {
        const status = isOpen(e) ? (isOverdue(e) ? "Overdue" : "Active") : "Settled";
        rows.push([p.name, "Entry", e.type === "gave" ? "You gave (to receive)" : "You took (to pay back)", e.purpose, csvDate(e.date), csvDate(e.due), num(e.amount), paid(e), left(e), status, isOpen(e) ? "" : csvDate(lastPaymentDate(e))]);
        let running = num(e.amount);
        for (const pay of e.payments.slice().sort(byDate)) {
          running = Math.max(0, round2(running - num(pay.amount)));
          rows.push([p.name, "   Repayment", e.type === "gave" ? "Received back" : "Paid back", "Repayment for: " + e.purpose + (pay.note ? " (" + pay.note + ")" : ""), csvDate(pay.date), "", num(e.amount), num(pay.amount), running, "", ""]);
        }
      }
      rows.push([]);
    }
    return rows;
  }


  /* ---------- Plain-language sheets for the Excel export ---------- */
  const niceDate = (k) => (isDateKey(k) ? `${Number(k.slice(8, 10))} ${["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][Number(k.slice(5, 7)) - 1]} ${k.slice(0, 4)}` : "");
  function exportSheets() {
    const people = state.people.slice().sort((a, b) => a.name.localeCompare(b.name));
    if (!people.some((p) => p.entries.length)) return { sheets: [], totals: totals(), net: 0 };
    const ledger = ledgerList(), t = totals();
    const net = round2(ledger.reduce((a, r) => a + r.eff, 0));
    const what = (r) => (r.given ? "You lent" : r.received ? "They paid you back" : r.borrowed ? "You borrowed" : "You paid back");
    const amtOf = (r) => r.given || r.received || r.borrowed || r.repaid;
    const loanRows = [{ kind: "header", cells: ["Date", "Person", "What happened", "Reason", "Amount (Rs.)", "Still left on this loan (Rs.)", "Loan status", "Budget change (Rs.)", "Budget"] }];
    for (const r of ledger) {
      loanRows.push({ kind: "data", cells: [niceDate(r.date), r.person, what(r), String(r.purpose).replace(/^Repayment for: /, ""), amtOf(r), r.remaining, r.eOpen ? (r.eOver ? "Overdue" : "Pending") : "Settled", r.eff, r.eff > 0 ? "Added to budget" : r.eff < 0 ? "Taken from budget" : "Not changed"] });
    }
    loanRows.push({ kind: "blank", cells: [] });
    loanRows.push({ kind: "note", cells: ["Each loan keeps its own row and every repayment gets a row too. Loan status shows where that loan stands today."] });
    loanRows.push({ kind: "note", cells: ["Budget change: plus (+) means your budget grew, minus (-) means it shrank."] });

    const peopleRows = [{ kind: "header", cells: ["Person", "You lent (Rs.)", "They paid back (Rs.)", "They still owe you (Rs.)", "You borrowed (Rs.)", "You paid back (Rs.)", "You still owe (Rs.)", "Result"] }];
    const g = { a: 0, b: 0, c: 0, d: 0, e: 0, f: 0 };
    for (const p of people) {
      const s = sums(p); const nt = round2(s.get - s.owe);
      peopleRows.push({ kind: "data", cells: [p.name, s.gaveTotal, s.gaveBack, s.get, s.tookTotal, s.tookBack, s.owe, nt > 0 ? "They owe you" : nt < 0 ? "You owe them" : "All clear"] });
      g.a += s.gaveTotal; g.b += s.gaveBack; g.c += s.get; g.d += s.tookTotal; g.e += s.tookBack; g.f += s.owe;
    }
    const gn = round2(g.c - g.f);
    peopleRows.push({ kind: "total", cells: ["All people", round2(g.a), round2(g.b), round2(g.c), round2(g.d), round2(g.e), round2(g.f), gn > 0 ? "They owe you" : gn < 0 ? "You owe them" : "All clear"] });
    return { sheets: [{ name: "Lend & Borrow", rows: loanRows }, { name: "People", rows: peopleRows }], totals: t, net };
  }


  /* ---------- Boot ---------- */
  load();
  BB.udhaar = { render, csvRows, exportSheets, totals, events, _state: () => state };
  syncBudget();
  render();
  BB.emit("udhaar");
/* CLOSE_PERSON_ON_SCREEN: leaving the page closes an open person account. The Active/History choice stays as it was. */
  BB.on("screen", () => {
    if (view.personId) { view.personId = null; render(); resetScroll(); }
  });
})();
