(() => {
  "use strict";
  /*
    Group Expense Settlement
    - Create a group (trip, dinner, shopping) with members.
    - Add expenses: who paid, who shares it, equal or custom split.
    - Shows each member's balance and the fewest payments needed to settle.
    - All money is stored in integer cents to avoid rounding drift.
    - Data stays on the phone (localStorage), separate per profile.
  */
  const BB = window.BB;
  if (!BB) return;
  const { esc, money, closeSheet, toast } = BB;
  const openSheet = (html) => {
    BB.openSheet(`<div class="gx">${html}</div>`);
    setTimeout(enhanceSelects, 0);
  };

  /* Replaces every native dropdown in our popups with an app-styled one.
     The hidden <select> stays in the form, so submitting works exactly as before. */
  function enhanceSelects() {
    document.querySelectorAll(".gx select:not([data-gx-done])").forEach((sel) => {
      sel.dataset.gxDone = "1";
      sel.style.display = "none";
      const box = document.createElement("div");
      box.className = "gx-dd";
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "gx-dd-btn";
      const list = document.createElement("div");
      list.className = "gx-dd-list";
      list.hidden = true;

      const paint = () => {
        const cur = sel.options[sel.selectedIndex];
        btn.innerHTML = '<span class="gx-dd-text"></span><span aria-hidden="true">' + (list.hidden ? "\u25BE" : "\u25B4") + "</span>";
        btn.firstChild.textContent = cur ? cur.textContent : "";
        list.innerHTML = "";
        Array.from(sel.options).forEach((o, i) => {
          const item = document.createElement("button");
          item.type = "button";
          item.className = "gx-dd-opt";
          item.setAttribute("aria-selected", i === sel.selectedIndex ? "true" : "false");
          item.innerHTML = "<span></span><span>" + (i === sel.selectedIndex ? "\u2713" : "") + "</span>";
          item.firstChild.textContent = o.textContent;
          item.addEventListener("click", () => {
            sel.selectedIndex = i;
            sel.dispatchEvent(new Event("change", { bubbles: true }));
            list.hidden = true;
            paint();
          });
          list.appendChild(item);
        });
      };
      btn.addEventListener("click", () => { list.hidden = !list.hidden; paint(); });

      box.appendChild(btn);
      box.appendChild(list);
      sel.parentNode.insertBefore(box, sel.nextSibling);
      paint();
    });
  }

  /* Tapping anywhere outside an open dropdown closes it. */
  document.addEventListener("click", (e) => {
    document.querySelectorAll(".gx-dd-list:not([hidden])").forEach((list) => {
      if (!list.parentNode.contains(e.target)) {
        list.hidden = true;
        const b = list.parentNode.querySelector(".gx-dd-btn span:last-child");
        if (b) b.textContent = "\u25BE";
      }
    });
  });

  const PROFILE = (() => { try { return localStorage.getItem("budgetbite_profile_id_v1") || "default"; } catch (_) { return "default"; } })();
  const KEY = `monetra_groups_v1_${PROFILE}`;

  /* ---------- Storage ---------- */
  let groups = [];
  try { groups = JSON.parse(localStorage.getItem(KEY) || "[]") || []; } catch (_) { groups = []; }
  const persist = () => { try { localStorage.setItem(KEY, JSON.stringify(groups)); } catch (_) { /* ignore */ } };

  /* Archive: groups that were cleared or deleted. They leave the app list but stay in the Excel/CSV export. */
  const AKEY = `monetra_groups_archive_v1_${PROFILE}`;
  let archive = [];
  try { archive = JSON.parse(localStorage.getItem(AKEY) || "[]") || []; } catch (_) { archive = []; }
  const persistArchive = () => { try { localStorage.setItem(AKEY, JSON.stringify(archive)); } catch (_) { /* ignore */ } };
  /* PURGE_DELETED: groups deleted earlier are removed from the archive. */
  archive = archive.filter((g) => g.how !== "Deleted"); persistArchive();
  function archiveGroup(g, how) {
    archive.push({ ...g, how, closed: Date.now() });
    persistArchive();
  }
  /* A group counts as settled when it has expenses and every balance is zero. */
  function isSettled(g) {
    if (!g.expenses.length) return false;
    return Object.values(balances(g)).every((c) => c === 0);
  }

  /* ---------- Small helpers ---------- */
  const uid = (p) => p + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-3);
  const todayKey = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  const toCents = (v) => Math.round(Math.max(-1e8, Math.min(1e8, Number(v) || 0)) * 100);
  const fromCents = (c) => c / 100;
  const findGroup = (id) => groups.find((g) => g.id === id);
  const nameOf = (g, id) => (g.members.find((m) => m.id === id) || { name: "Unknown" }).name;
  const refresh = () => { try { BB.udhaar && BB.udhaar.render && BB.udhaar.render(); } catch (_) { /* ignore */ } };

  /* ---------- Budget link ---------- */
  /* The member marked "me" is the person using the app. */
  const meId = (g) => (g.members.find((m) => m.me) || {}).id;
  /* Adds a signed amount (in cents) to the daily budget. Negative = money left your pocket. */
  function budgetAdd(id, date, signedCents, label) {
    const b = BB.budget;
    if (b && b.addExternalTransaction && signedCents) b.addExternalTransaction(id, date, fromCents(signedCents), label, "group");
  }
  function budgetRemove(id) {
    const b = BB.budget;
    if (b && b.removeExternalTransaction) b.removeExternalTransaction(id);
  }
  /* In the expense form: show the "take my share" option only when someone else paid. */
  document.addEventListener("change", (e) => {
    const t = e.target;
    if (!t || t.name !== "paidBy") return;
    const form = t.closest("form");
    if (!form) return;
    const me = form.querySelector('[name="meId"]');
    const mine = me && t.value === me.value;
    const box = form.querySelector("#gxDeductBox"), hint = form.querySelector("#gxMeHint");
    if (box) box.style.display = mine ? "none" : "flex";
    if (hint) hint.style.display = mine ? "block" : "none";
  });

  /* Splits a total (in cents) equally between ids. Leftover cents go to the first people, so the sum is exact. */
  function splitEqual(totalCents, ids) {
    const out = {};
    if (!ids.length) return out;
    const base = Math.floor(totalCents / ids.length);
    let rest = totalCents - base * ids.length;
    for (const id of ids) { out[id] = base + (rest > 0 ? 1 : 0); if (rest > 0) rest--; }
    return out;
  }

  /* Returns each member's share (in cents) of one expense. */
  function sharesOf(exp) {
    return exp.mode === "custom" ? exp.shares : splitEqual(exp.cents, exp.splitIds);
  }

  /* Net balance per member in cents. Positive = should receive money, negative = should pay money. */
  function balances(g) {
    const net = {};
    for (const m of g.members) net[m.id] = 0;
    for (const exp of g.expenses) {
      net[exp.paidBy] = (net[exp.paidBy] || 0) + exp.cents;                 // the payer fronted the money
      const shares = sharesOf(exp);
      for (const id of Object.keys(shares)) net[id] = (net[id] || 0) - shares[id]; // everyone owes their share
    }
    for (const s of g.settlements) {                                         // a recorded payment moves balances toward zero
      net[s.from] = (net[s.from] || 0) + s.cents;
      net[s.to] = (net[s.to] || 0) - s.cents;
    }
    return net;
  }

  /* Greedy matching of biggest debtor with biggest creditor gives few, simple payments. */
  function suggestPayments(net) {
    const debtors = [], creditors = [];
    for (const id of Object.keys(net)) {
      if (net[id] < 0) debtors.push({ id, c: -net[id] });
      else if (net[id] > 0) creditors.push({ id, c: net[id] });
    }
    debtors.sort((a, b) => b.c - a.c);
    creditors.sort((a, b) => b.c - a.c);
    const out = [];
    let i = 0, j = 0;
    while (i < debtors.length && j < creditors.length) {
      const m = Math.min(debtors[i].c, creditors[j].c);
      out.push({ from: debtors[i].id, to: creditors[j].id, cents: m });
      debtors[i].c -= m;
      creditors[j].c -= m;
      if (debtors[i].c === 0) i++;
      if (creditors[j].c === 0) j++;
    }
    return out;
  }

  const totalSpent = (g) => g.expenses.reduce((s, e) => s + e.cents, 0);

  /* Plain-text summary used for sharing (WhatsApp etc.). */
  function summaryText(g) {
    const pays = suggestPayments(balances(g));
    const lines = [`${g.name}: total spent ${money(fromCents(totalSpent(g)))}`];
    if (!pays.length) lines.push("Everyone is settled.");
    for (const p of pays) lines.push(`${nameOf(g, p.from)} pays ${nameOf(g, p.to)} ${money(fromCents(p.cents))}`);
    return lines.join("\n");
  }

  /* ---------- Home card (shown on the Loans screen) ---------- */
  function cardHtml() {
    const rows = groups.map((g) => {
      const net = balances(g);
      const open = Object.values(net).some((c) => c !== 0);
      return `<div class="row" style="align-items:center;gap:10px"><span><b>${esc(g.name)}</b><br><small class="hint">${g.members.length} people \u00b7 ${money(fromCents(totalSpent(g)))} spent \u00b7 ${open ? "Not settled" : "Settled"}</small></span><button class="btn ghost" type="button" data-action="g-open" data-id="${esc(g.id)}" style="height:36px;font-size:13px;padding:0 14px;flex:0 0 auto">Open</button></div>`;
    }).join("");
    return `<section class="card" id="groupCard" style="margin-bottom:14px">
      <h2>Group expenses</h2>
      <p class="hint">Split a trip, dinner or shopping. See who paid and who owes whom.</p>
      ${rows || `<p class="hint">No groups yet.</p>`}
      <div class="btn-pair" style="margin-top:14px"><button class="btn primary" type="button" data-action="g-new">New group</button></div>
    </section>`;
  }

  /* ---------- Group detail sheet ---------- */
  function openGroup(id) {
    const g = findGroup(id);
    if (!g) return;
    const net = balances(g);
    const pays = suggestPayments(net);

    const balanceRows = g.members.map((m) => {
      const c = net[m.id] || 0;
      const text = c === 0 ? "Settled" : c > 0 ? `Gets back ${money(fromCents(c))}` : `Owes ${money(fromCents(-c))}`;
      return `<div class="row"><span>${esc(m.name)}</span><b>${text}</b></div>`;
    }).join("");

    const payRows = pays.length
      ? pays.map((p) => `<div class="row" style="align-items:center;gap:10px"><span>${esc(nameOf(g, p.from))} pays ${esc(nameOf(g, p.to))}<br><b>${money(fromCents(p.cents))}</b></span><button class="btn ghost" type="button" data-action="g-pay" data-gid="${esc(g.id)}" data-from="${esc(p.from)}" data-to="${esc(p.to)}" data-cents="${p.cents}" style="height:36px;font-size:13px;padding:0 14px;flex:0 0 auto">Mark paid</button></div>`).join("")
      : `<p class="hint">Everyone is settled.</p>`;

    const expRows = g.expenses.slice().sort((a, b) => (b.date || "").localeCompare(a.date || "")).map((e) =>
      `<div class="row" style="align-items:center;gap:10px"><span><b>${esc(e.title)}</b> \u00b7 ${money(fromCents(e.cents))}<br><small class="hint">${esc(e.date)} \u00b7 paid by ${esc(nameOf(g, e.paidBy))} \u00b7 ${e.mode === "custom" ? "custom split" : "equal split"}</small></span><button class="btn ghost" type="button" data-action="g-del-exp" data-gid="${esc(g.id)}" data-id="${esc(e.id)}" style="height:32px;font-size:12px;padding:0 12px;flex:0 0 auto">Delete</button></div>`).join("");

    const payLog = g.settlements.map((s) =>
      `<div class="row"><span><small class="hint">${esc(s.date)} \u00b7 ${esc(nameOf(g, s.from))} paid ${esc(nameOf(g, s.to))}</small></span><b>${money(fromCents(s.cents))}</b></div>`).join("");

    openSheet(`<h2>${esc(g.name)}</h2>
      <p class="sheet-sub">Total spent ${money(fromCents(totalSpent(g)))}</p>
      <h3 style="margin:10px 0 4px">Balances</h3>${balanceRows}
      <h3 style="margin:14px 0 4px">How to settle</h3>${payRows}
      <h3 style="margin:14px 0 4px">Expenses (${g.expenses.length})</h3>${expRows || `<p class="hint">No expenses yet.</p>`}
      ${payLog ? `<h3 style="margin:14px 0 4px">Payments made</h3>${payLog}` : ""}
      <div class="sheet-actions" style="margin-top:14px;flex-wrap:wrap">
        <button class="btn ghost" type="button" data-action="g-del-group" data-id="${esc(g.id)}">Delete group</button>${isSettled(g) ? `<button class="btn ghost" type="button" data-action="g-clear" data-id="${esc(g.id)}">Clear settled</button>` : ""}
        <button class="btn ghost" type="button" data-action="g-share" data-id="${esc(g.id)}">Share</button>
        <button class="btn ghost" type="button" data-action="sheet-close">Close</button>
        <button class="btn primary" type="button" data-action="g-add" data-id="${esc(g.id)}">Add expense</button>
      </div>`);
  }

  /* Re-open the group sheet after a form closed it. */
  const reopen = (id) => setTimeout(() => openGroup(id), 0);

  /* ---------- Actions (button clicks) ---------- */
  Object.assign(BB.actions, {
    "g-new": () => {
      openSheet(`<h2>New group</h2>
        <p class="sheet-sub">You are added automatically. Write the other people separated by commas.</p>
        <form data-form="g-new" novalidate>
          <label class="field"><span>Group name</span><input name="name" maxlength="60" placeholder="e.g. Murree trip" autofocus></label>
          <label class="field"><span>Other people</span><input name="members" placeholder="e.g. Ali, Usman, Hamza"></label>
          <div class="sheet-actions"><button class="btn ghost" type="button" data-action="sheet-close">Cancel</button><button class="btn primary" type="submit">Create</button></div>
        </form>`);
    },
    "g-open": (el) => openGroup(el.dataset.id),

    "g-add": (el) => {
      const g = findGroup(el.dataset.id);
      if (!g) return;
      const options = g.members.map((m) => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join("");
      const checks = g.members.map((m) =>
        `<div class="row" style="align-items:center;gap:10px"><label style="display:flex;gap:8px;align-items:center;flex:1"><input type="checkbox" name="w_${esc(m.id)}" checked><span>${esc(m.name)}</span></label></div>`).join("");
      openSheet(`<h2>Add expense</h2>
        <form data-form="g-expense" novalidate><input type="hidden" name="gid" value="${esc(g.id)}"><input type="hidden" name="meId" value="${esc(meId(g) || "")}">
          <label class="field"><span>What was it for?</span><input name="title" maxlength="80" placeholder="e.g. Dinner" autofocus></label>
          <label class="field"><span>Amount</span><input name="amount" inputmode="decimal" placeholder="0"></label>
          <label class="field"><span>Paid by</span><select name="paidBy">${options}</select></label>
          <p class="hint" id="gxMeHint">You paid, so this amount is taken from your budget.</p>
          <label id="gxDeductBox" style="display:none;gap:10px;align-items:center;margin:0 0 12px"><input type="checkbox" name="deduct"><span>Also take my share from my budget</span></label>
          <label class="field"><span>Date</span><input name="date" type="date" value="${todayKey()}"></label>
          <p class="hint">Tick who shares this expense. It is split equally between them.</p>${checks}
          <div class="sheet-actions"><button class="btn ghost" type="button" data-action="sheet-close">Cancel</button><button class="btn primary" type="submit">Add</button></div>
        </form>`);
    },

    "g-pay": (el) => {
      const g = findGroup(el.dataset.gid);
      if (!g) return;
      const opts = (sel) => g.members.map((m) => `<option value="${esc(m.id)}"${m.id === sel ? " selected" : ""}>${esc(m.name)}</option>`).join("");
      openSheet(`<h2>Record a payment</h2>
        <p class="sheet-sub">Use this when someone has actually paid someone back.</p>
        <form data-form="g-pay" novalidate><input type="hidden" name="gid" value="${esc(g.id)}">
          <label class="field"><span>Who paid</span><select name="from">${opts(el.dataset.from)}</select></label>
          <label class="field"><span>Paid to</span><select name="to">${opts(el.dataset.to)}</select></label>
          <label class="field"><span>Amount</span><input name="amount" inputmode="decimal" value="${fromCents(Number(el.dataset.cents) || 0) || ""}"></label>
          <div class="sheet-actions"><button class="btn ghost" type="button" data-action="sheet-close">Cancel</button><button class="btn primary" type="submit">Save</button></div>
        </form>`);
    },

    "g-share": async (el) => {
      const g = findGroup(el.dataset.id);
      if (!g) return;
      const text = summaryText(g);
      try {
        if (window.BudgetNative && BudgetNative.Share) { await BudgetNative.Share.share({ title: g.name, text }); return; }
        if (navigator.share) { await navigator.share({ title: g.name, text }); return; }
        await navigator.clipboard.writeText(text);
        toast("Summary copied.", "success");
      } catch (_) { /* user cancelled the share sheet */ }
    },

    "g-del-exp": (el) => {
      const g = findGroup(el.dataset.gid);
      if (!g || !window.confirm("Delete this expense?")) return;
      budgetRemove("group-exp-" + el.dataset.id);
      g.expenses = g.expenses.filter((e) => e.id !== el.dataset.id);
      persist(); refresh(); openGroup(g.id);
    },
    "g-clear": (el) => {
      const g = findGroup(el.dataset.id);
      if (!g || !isSettled(g)) return;
      if (!window.confirm("Clear this settled group? Its record stays in the Excel export.")) return;
      archiveGroup(g, "Settled");
      groups = groups.filter((x) => x.id !== g.id);
      persist(); closeSheet(); refresh();
      toast("Group cleared. The record stays in the Excel export.", "success");
    },
    "g-del-group": (el) => {
      if (!window.confirm("Delete this group? It will also not appear in the Excel export.")) return;
      const gone = findGroup(el.dataset.id);
      /* deleted groups are not kept */
      groups = groups.filter((g) => g.id !== el.dataset.id);
      persist(); closeSheet(); refresh();
    }
  });

  /* ---------- Forms (submitted sheets) ---------- */
  Object.assign(BB.forms, {
    "g-new": (form) => {
      const fd = new FormData(form);
      const name = String(fd.get("name") || "").trim();
      const others = String(fd.get("members") || "").split(",").map((s) => s.trim()).filter(Boolean);
      if (!name) return toast("Write a group name.", "error");
      if (!others.length) return toast("Add at least one other person.", "error");
      if (groups.some((x) => x.name === name && Date.now() - x.created < 3000)) return; // double submit guard
      const g = { id: uid("g"), name, created: Date.now(), members: [{ id: uid("m"), name: "Me", me: true }, ...others.map((n) => ({ id: uid("m"), name: n }))], expenses: [], settlements: [] };
      groups.push(g);
      persist(); closeSheet(); refresh(); reopen(g.id);
    },

    "g-expense": (form) => {
      const fd = new FormData(form);
      const g = findGroup(fd.get("gid"));
      if (!g) return closeSheet();
      const title = String(fd.get("title") || "").trim();
      const cents = toCents(fd.get("amount"));
      const mode = "equal";
      const splitIds = g.members.filter((m) => fd.get("w_" + m.id)).map((m) => m.id);
      if (!title) return toast("Write what it was for.", "error");
      if (cents <= 0) return toast("Enter an amount.", "error");
      if (!splitIds.length) return toast("Tick at least one person.", "error");

      const exp = { id: uid("x"), title, cents, paidBy: String(fd.get("paidBy")), date: String(fd.get("date") || todayKey()), mode, splitIds, created: Date.now() };
      if (g.expenses.some((x) => x.title === exp.title && x.cents === exp.cents && x.paidBy === exp.paidBy && Date.now() - x.created < 3000)) return; // double submit guard
      const me = meId(g);
      if (exp.paidBy === me) {
        exp.budgetCents = -cents;                                  // you paid it all
      } else if (fd.get("deduct")) {
        const mine = sharesOf(exp)[me] || 0;                       // someone else paid: take only your share
        if (mine > 0) { exp.budgetCents = -mine; exp.deducted = mine; }
      }
      if (exp.budgetCents) budgetAdd("group-exp-" + exp.id, exp.date, exp.budgetCents, `${g.name}: ${exp.title}`);
      g.expenses.push(exp);
      persist(); closeSheet(); refresh(); reopen(g.id);
    },

    "g-pay": (form) => {
      const fd = new FormData(form);
      const g = findGroup(fd.get("gid"));
      if (!g) return closeSheet();
      const from = String(fd.get("from")), to = String(fd.get("to")), cents = toCents(fd.get("amount"));
      if (from === to) return toast("Choose two different people.", "error");
      if (cents <= 0) return toast("Enter an amount.", "error");
      const me = meId(g);
      const s = { id: uid("s"), from, to, cents, date: todayKey(), created: Date.now() };
      if (to === me) {
        s.budgetCents = cents;                                     // money came to you
      } else if (from === me) {
        /* Part of what you pay may already be taken from your budget (the "take my share" option). */
        const prepaid = g.expenses.reduce((a, e) => a + (e.deducted || 0), 0) - g.settlements.reduce((a, x) => a + (x.covered || 0), 0);
        s.covered = Math.max(0, Math.min(cents, prepaid));
        s.budgetCents = -(cents - s.covered);
      }
      if (s.budgetCents) budgetAdd("group-pay-" + s.id, s.date, s.budgetCents, `${g.name}: ${nameOf(g, from)} paid ${nameOf(g, to)}`);
      g.settlements.push(s);
      /* Auto-archive: fully settled groups leave the list, the record stays in the Excel export. */
      if (isSettled(g)) { archiveGroup(g, "Settled"); groups = groups.filter((x) => x.id !== g.id); persist(); closeSheet(); refresh(); toast("Group settled. Record saved in the Excel export.", "success"); return; }
      persist(); closeSheet(); refresh(); reopen(g.id);
    }
  });

  /* Builds the "Group Expenses" sheet for the Excel/CSV export. Returns null when there are no groups.
     One clear block per group: NOT SETTLED first, then SETTLED, then deleted groups. */
  function exportSheet() {
    const all = [...groups.map((g) => ({ ...g, how: "" })), ...archive];
    if (!all.length) return null;
    const R = fromCents, M = (c) => money(fromCents(c));
    const rank = (g) => (g.how === "Deleted" ? 2 : isSettled(g) ? 1 : 0);
    all.sort((a, b) => rank(a) - rank(b));
    const rows = [];
    all.forEach((g, gi) => {
      const L = g.name, net = balances(g), settled = isSettled(g), total = totalSpent(g);
      const owedAtStart = Object.values(balances({ ...g, settlements: [] })).reduce((s, c) => s + (c > 0 ? c : 0), 0);
      const paidBack = (g.settlements || []).reduce((s, x) => s + x.cents, 0);
      const status = !g.expenses.length ? "NO EXPENSES" : settled ? "SETTLED" : "NOT SETTLED";
      const tag = g.how === "Deleted" ? " (group deleted)" : "";
      const add = (date, what, who, amount, type, details) => rows.push({ kind: "data", cells: [L, date, what, who, amount, type, details] });
      if (gi > 0) rows.push({ kind: "blank", cells: [] });
      rows.push({ kind: "header", cells: [`${L} \u2014 ${status}${tag}`, "Date", "What", "Who", "Amount (Rs.)", "Type", "Details"] });
      for (const e of g.expenses.slice().sort((a, b) => (a.date || "").localeCompare(b.date || ""))) {
        const shares = sharesOf(e);
        const between = Object.keys(shares).map((id) => `${nameOf(g, id)} ${R(shares[id])}`).join(", ");
        add(e.date, e.title, `Paid by ${nameOf(g, e.paidBy)}`, R(e.cents), "Expense", `Shared: ${between}`);
      }
      for (const s of g.settlements || []) add(s.date || "", "Paid back", `${nameOf(g, s.from)} paid ${nameOf(g, s.to)}`, R(s.cents), "Payment made", "");
      if (!g.expenses.length) return;
      add("", "Total spent", "Everyone", R(total), "Total", "");
      if (settled) {
        add("", "Paid back", "Everyone", R(paidBack), "Settled", `Received ${M(paidBack)} of ${M(owedAtStart)}. Nothing left to pay.`);
      } else {
        add("", "Paid back so far", "Everyone", R(paidBack), "Paid so far", `${M(paidBack)} of ${M(owedAtStart)}`);
        
        const sp = suggestPayments(net); for (const m of g.members) { const c = net[m.id] || 0; if (!c) continue; const sent = (g.settlements || []).filter((x) => x.from === m.id).reduce((s, x) => s + x.cents, 0); const out = sp.filter((x) => x.from === m.id).map((x) => `${nameOf(g, x.to)} ${M(x.cents)}`).join(" and "), inn = sp.filter((x) => x.to === m.id).map((x) => `${M(x.cents)} from ${nameOf(g, x.from)}`).join(" and "); if (c < 0) add("", "Still has to pay", m.name, R(-c), "Pending", `${m.name} still has to pay ${out}.${sent ? " Already paid " + M(sent) + "." : ""}`); else add("", "Still to receive", m.name, R(c), "Pending", `${m.name} will get ${inn}.`); }
        
      }
    });
    rows.push({ kind: "blank", cells: [] });
    rows.push({ kind: "note", cells: ["Each group has its own block. NOT SETTLED groups come first and show who still owes or gets money back, how much is still to pay and the payments that would settle it. SETTLED groups show their expenses, the payments made and how much was paid back. Deleted groups are not included."] });
    return { name: "Group Expenses", rows };
  }
  /* Auto-archive groups that were already settled before this update. */
  (function sweepSettled() {
    const done = groups.filter((g) => g.settlements.length && isSettled(g));
    if (!done.length) return;
    done.forEach((g) => archiveGroup(g, "Settled"));
    groups = groups.filter((g) => !done.includes(g));
    persist();
  })();
  BB.group = { cardHtml, exportSheet, _groups: () => groups };
  /* Redraw Loans once, because udhaar.js drew itself before this file loaded. */
  try { BB.udhaar && BB.udhaar.render && BB.udhaar.render(); } catch (_) { /* ignore */ }
})();