const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

let meta = null;
let settings = null;
const money = (n) => new Intl.NumberFormat('en-US', { style: 'currency', currency: settings?.currency || 'USD' }).format(n ?? 0);
const moneyShort = (n) => new Intl.NumberFormat('en-US', { style: 'currency', currency: settings?.currency || 'USD', notation: 'compact', maximumFractionDigits: 1 }).format(n ?? 0);
const monthName = (m) => { const [y, mo] = m.split('-').map(Number); return new Date(y, mo - 1, 1).toLocaleString('en-US', { month: 'short', year: 'numeric' }); };
const shortMonth = (m) => { const [y, mo] = m.split('-').map(Number); return new Date(y, mo - 1, 1).toLocaleString('en-US', { month: 'short' }); };

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: opts.body ? { 'content-type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json();
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.details = data.details;
    throw err;
  }
  return data;
}

const statusPill = (s) => `<span class="pill ${esc(s)}">${esc(s)}</span>`;
function budgetPill(status, pct) {
  if (status === 'over') return `<span class="pill over">▲ Over budget · ${pct}%</span>`;
  if (status === 'warning') return `<span class="pill warning">⚠ ${pct}% used</span>`;
  if (status === 'no-budget') return `<span class="pill">No limit set</span>`;
  return `<span class="pill">${pct}% used</span>`;
}
const unusualBadge = (u) => (u ? `<span class="flag" title="Category average ${money(u.average)} across ${u.samples} expenses">⚑ ${u.ratio}× avg</span>` : '');

// ---------------- tooltip ----------------
const tip = $('#tooltip');
function showTip(html, x, y) {
  tip.innerHTML = html;
  tip.hidden = false;
  const r = tip.getBoundingClientRect();
  const left = Math.min(window.innerWidth - r.width - 8, x + 14);
  const top = y + r.height + 20 > window.innerHeight ? y - r.height - 12 : y + 14;
  tip.style.left = `${Math.max(8, left)}px`;
  tip.style.top = `${Math.max(8, top)}px`;
}
const hideTip = () => { tip.hidden = true; };

// ---------------- router ----------------
const views = { submit: initSubmit, ledger: renderLedger, dashboard: renderDashboard, activity: renderActivity, settings: renderSettings };
function route() {
  const name = location.hash.slice(1) in views ? location.hash.slice(1) : 'submit';
  $$('.view').forEach((v) => { v.hidden = v.id !== `view-${name}`; });
  $$('.tabs a').forEach((a) => { if (a.dataset.view === name) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  views[name]().catch((err) => alert(err.message));
}

// ---------------- submit ----------------
let submitReady = false;
async function initSubmit() {
  if (submitReady) return;
  submitReady = true;
  const form = $('#expenseForm');
  form.paymentMethod.innerHTML = meta.paymentMethods.map((p) => `<option>${esc(p)}</option>`).join('');
  form.category.innerHTML = `<option value="">Auto (agent decides)</option>` + meta.categories.map((c) => `<option>${esc(c)}</option>`).join('');
  form.status.innerHTML = meta.statuses.map((s) => `<option>${esc(s)}</option>`).join('');
  form.date.value = new Date().toLocaleDateString('en-CA');

  let suggestTimer;
  const suggest = async (apply) => {
    const vendor = form.vendor.value.trim();
    if (!vendor) { $('#suggestion').textContent = 'Enter a vendor first.'; return; }
    $('#suggestion').textContent = 'Agent is thinking…';
    try {
      const s = await api('/api/agent/categorize', {
        method: 'POST',
        body: { vendor, amount: form.amount.value, date: form.date.value, paymentMethod: form.paymentMethod.value, receiptNotes: form.receiptNotes.value },
      });
      $('#suggestion').textContent = `Agent suggests ${s.category} (${Math.round(s.confidence * 100)}% confident, ${s.source}): ${s.reasoning}`;
      if (apply) form.category.value = s.category;
    } catch (err) {
      $('#suggestion').textContent = err.message;
    }
  };
  $('#suggestBtn').addEventListener('click', () => suggest(true));
  const auto = () => { clearTimeout(suggestTimer); if (!form.category.value) suggestTimer = setTimeout(() => suggest(false), 600); };
  form.vendor.addEventListener('change', auto);
  form.receiptNotes.addEventListener('change', auto);

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    $('#formErrors').textContent = '';
    const body = Object.fromEntries(new FormData(form));
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      const { expense, review, notifications } = await api('/api/expenses', { method: 'POST', body });
      const warn = review.anomaly || notifications.length;
      $('#submitResult').innerHTML = `
        <div class="card result-card ${warn ? 'warn' : ''}">
          <h2>Submitted: ${esc(expense.vendor)} · ${money(expense.amount)}</h2>
          <p>Category: <b>${esc(expense.category)}</b>
            ${review.categorization.applied ? `— chosen by the agent (${esc(review.categorization.source)}, ${Math.round(review.categorization.confidence * 100)}%): ${esc(review.categorization.reasoning)}`
              : review.categorization.agreesWithSubmitter === false ? `— note: the agent would have picked ${esc(review.categorization.category)}.` : ''}</p>
          ${review.budget ? `<p>${esc(expense.category)} this month: ${money(review.budget.spent)} of ${money(review.budget.limit)} ${budgetPill(review.budget.status, review.budget.pct)}</p>` : ''}
          ${review.anomaly ? `<p class="flag">⚑ Unusual: ${review.anomaly.ratio}× the ${esc(expense.category)} average of ${money(review.anomaly.average)}. Managers were notified.</p>` : ''}
          ${notifications.filter((n) => n.type === 'budget-alert').map((n) => `<p class="flag">🔔 ${esc(n.title)} — managers notified.</p>`).join('')}
        </div>`;
      form.reset();
      form.date.value = new Date().toLocaleDateString('en-CA');
      $('#suggestion').textContent = 'Leave on “Auto” and the agent will categorize it when you submit.';
    } catch (err) {
      $('#formErrors').textContent = err.details ? err.details.join('. ') : err.message;
    } finally {
      btn.disabled = false;
    }
  });
}

// ---------------- ledger ----------------
async function renderLedger() {
  const monthInput = $('#ledgerMonth');
  if (!monthInput.value) {
    monthInput.value = meta.currentMonth;
    $('#ledgerStatus').innerHTML += meta.statuses.map((s) => `<option>${esc(s)}</option>`).join('');
    monthInput.onchange = $('#ledgerStatus').onchange = $('#ledgerFlagged').onchange = renderLedger;
  }
  const data = await api(`/api/ledger?month=${monthInput.value}`);
  const status = $('#ledgerStatus').value;
  const onlyFlagged = $('#ledgerFlagged').checked;
  const all = data.groups.flatMap((g) => g.items);

  $('#ledgerTotals').innerHTML = `
    <div class="kpi"><div class="label">Spent (excl. rejected)</div><div class="value">${money(data.totals.spent)}</div><div class="sub">of ${money(data.totals.limit)} budget</div></div>
    <div class="kpi"><div class="label">Expenses</div><div class="value">${all.length}</div><div class="sub">${data.groups.length} categories</div></div>
    <div class="kpi"><div class="label">Pending approval</div><div class="value">${all.filter((e) => e.status === 'Pending').length}</div><div class="sub">${money(all.filter((e) => e.status === 'Pending').reduce((s, e) => s + e.amount, 0))}</div></div>
    <div class="kpi"><div class="label">Unusual</div><div class="value">${all.filter((e) => e.unusual).length}</div><div class="sub">&gt;150% of category avg</div></div>`;

  const groups = data.groups
    .map((g) => ({ ...g, items: g.items.filter((e) => (!status || e.status === status) && (!onlyFlagged || e.unusual)) }))
    .filter((g) => g.items.length);
  if (!groups.length) { $('#ledgerGroups').innerHTML = `<div class="card empty">No expenses match for ${monthName(monthInput.value)}.</div>`; return; }

  $('#ledgerGroups').innerHTML = groups.map((g) => `
    <details class="card ledger-group" open>
      <summary><h2>${esc(g.category)}</h2>
        <span class="num"><b>${money(g.subtotal)}</b> <span class="muted">/ ${money(g.limit)}</span></span>
        ${budgetPill(g.status, g.pct)}</summary>
      <div class="table-wrap"><table>
        <thead><tr><th>Date</th><th>Vendor</th><th class="num">Amount</th><th>Payment</th><th>Receipt notes</th><th>Status</th><th></th></tr></thead>
        <tbody>${g.items.map((e) => `
          <tr class="${e.unusual ? 'unusual' : ''}">
            <td class="date">${esc(e.date)}</td>
            <td>${esc(e.vendor)}${e.submittedBy ? `<div class="ai">by ${esc(e.submittedBy)}</div>` : ''}
              ${e.aiCategorization?.applied ? `<div class="ai" title="${esc(e.aiCategorization.reasoning)}">auto-categorized (${esc(e.aiCategorization.source)})</div>` : ''}</td>
            <td class="num">${money(e.amount)}<div>${unusualBadge(e.unusual)}</div></td>
            <td>${esc(e.paymentMethod)}</td>
            <td class="notes">${esc(e.receiptNotes)}</td>
            <td>${statusPill(e.status)}</td>
            <td class="num">
              ${e.status !== 'Approved' ? `<button class="link" data-act="Approved" data-id="${e.id}">Approve</button>` : ''}
              ${e.status !== 'Rejected' ? `<button class="link" data-act="Rejected" data-id="${e.id}">Reject</button>` : ''}
              <button class="link" data-act="recat" data-id="${e.id}" title="Re-run the categorization agent">Re-categorize</button>
              <button class="link" data-act="delete" data-id="${e.id}">Delete</button>
            </td>
          </tr>`).join('')}</tbody>
      </table></div>
    </details>`).join('');

  $$('#ledgerGroups button[data-act]').forEach((b) => b.addEventListener('click', async () => {
    const { act, id } = b.dataset;
    b.disabled = true;
    try {
      if (act === 'delete') { if (!confirm('Delete this expense?')) return; await api(`/api/expenses/${id}`, { method: 'DELETE' }); }
      else if (act === 'recat') await api(`/api/expenses/${id}`, { method: 'PATCH', body: { category: 'auto' } });
      else await api(`/api/expenses/${id}`, { method: 'PATCH', body: { status: act, reviewedBy: 'Manager' } });
      await renderLedger();
    } catch (err) { alert(err.message); } finally { b.disabled = false; }
  }));
}

// ---------------- dashboard ----------------
async function renderDashboard() {
  const monthInput = $('#dashMonth');
  if (!monthInput.value) { monthInput.value = meta.currentMonth; monthInput.onchange = renderDashboard; }
  const d = await api(`/api/dashboard?month=${monthInput.value}`);
  const t = d.budget.totals;
  const hot = d.budget.categories.filter((c) => c.status === 'warning' || c.status === 'over');

  $('#dashKpis').innerHTML = `
    <div class="kpi"><div class="label">Spent in ${monthName(d.month)}</div><div class="value">${money(t.spent)}</div><div class="sub">${t.pct ?? 0}% of ${money(t.limit)}</div></div>
    <div class="kpi"><div class="label">Budget remaining</div><div class="value">${money(t.remaining)}</div><div class="sub">across all categories</div></div>
    <div class="kpi"><div class="label">Categories ≥ 80%</div><div class="value">${hot.length}</div><div class="sub">${hot.filter((c) => c.status === 'over').length} over limit</div></div>
    <div class="kpi"><div class="label">Unusual transactions</div><div class="value">${d.flagged.length}</div><div class="sub">&gt;150% of category avg</div></div>
    <div class="kpi"><div class="label">Pending approval</div><div class="value">${d.pendingApprovals}</div><div class="sub">this month</div></div>`;

  renderMeters($('#budgetBars'), d.budget.categories.filter((c) => c.limit > 0 || c.spent > 0).map((c) => ({
    name: c.category, value: c.spent, limit: c.limit, status: c.status,
    figs: `${money(c.spent)} / ${moneyShort(c.limit)} ${budgetPill(c.status, c.pct)}`,
    tip: `<b>${esc(c.category)}</b><div class="row"><span>Spent</span><span>${money(c.spent)}</span></div><div class="row"><span>Limit</span><span>${money(c.limit)}</span></div><div class="row"><span>Remaining</span><span>${money(c.remaining)}</span></div><div class="row"><span>Expenses</span><span>${c.count}</span></div>`,
  })));

  $('#observations').innerHTML = d.observations.map((o) => `<li>${esc(o)}</li>`).join('');
  $('#flaggedList').innerHTML = d.flagged.length
    ? `<div class="table-wrap"><table><thead><tr><th>Date</th><th>Vendor</th><th>Category</th><th class="num">Amount</th><th class="num">vs avg</th></tr></thead><tbody>
        ${d.flagged.map((f) => `<tr class="unusual"><td class="date">${esc(f.date)}</td><td>${esc(f.vendor)}</td><td>${esc(f.category)}</td><td class="num">${money(f.amount)}</td><td class="num">${unusualBadge(f)}</td></tr>`).join('')}
      </tbody></table></div>`
    : '<div class="empty">None this month.</div>';

  renderTrend(d.trend);

  const pm = d.byPaymentMethod.sort((a, b) => b.total - a.total);
  const maxPm = Math.max(1, ...pm.map((p) => p.total));
  renderMeters($('#paymentBars'), pm.map((p) => ({
    name: p.method, value: p.total, limit: maxPm, figs: money(p.total), status: 'ok', noLimitMarker: true,
    tip: `<b>${esc(p.method)}</b><div class="row"><span>Total</span><span>${money(p.total)}</span></div><div class="row"><span>Share</span><span>${Math.round((p.total / pm.reduce((s, x) => s + x.total, 0)) * 100)}%</span></div>`,
  })), 'No spend this month.');
}

function renderMeters(el, rows, emptyText = 'No budget data.') {
  if (!rows.length) { el.innerHTML = `<div class="empty">${emptyText}</div>`; return; }
  // Scale so the larger of limit or spend fits; the limit tick shows where 100% is.
  const scale = Math.max(1, ...rows.map((r) => Math.max(r.value, r.limit || 0)));
  el.innerHTML = rows.map((r, i) => `
    <div class="meter-row" data-i="${i}">
      <span class="name" title="${esc(r.name)}">${esc(r.name)}</span>
      <div class="meter"><div class="fill ${r.status}" style="width:${(r.value / scale) * 100}%"></div>
        ${r.limit && !r.noLimitMarker ? `<div class="limit" style="left:calc(${(r.limit / scale) * 100}% - 1px)" title="Limit"></div>` : ''}</div>
      <span class="figs">${r.figs}</span>
    </div>`).join('');
  $$('.meter-row', el).forEach((row) => {
    const r = rows[row.dataset.i];
    row.addEventListener('mousemove', (e) => showTip(r.tip, e.clientX, e.clientY));
    row.addEventListener('mouseleave', hideTip);
  });
}

function renderTrend(trend) {
  const el = $('#trendChart');
  const W = Math.max(320, el.clientWidth || 800), H = 260;
  const pad = { l: 56, r: 64, t: 12, b: 28 };
  const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
  const max = Math.max(1, ...trend.flatMap((p) => [p.total, p.priorYear]));
  // Round tick step (1/2/2.5/5 x 10^n) giving about four gridlines.
  const step = (() => { const raw = max / 4; const p = 10 ** Math.floor(Math.log10(raw)); return [1, 2, 2.5, 5, 10].map((f) => f * p).find((v) => v >= raw); })();
  const niceMax = Math.ceil(max / step) * step;
  const x = (i) => pad.l + (trend.length === 1 ? iw / 2 : (i / (trend.length - 1)) * iw);
  const y = (v) => pad.t + ih - (v / niceMax) * ih;
  const path = (key) => trend.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p[key]).toFixed(1)}`).join('');
  const ticks = Array.from({ length: Math.round(niceMax / step) + 1 }, (_, i) => i * step);
  const labelEvery = W < 560 ? 2 : 1;
  const last = trend.length - 1;

  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Monthly spend for the last 12 months compared with the same months a year earlier">
    ${ticks.map((v) => `<line class="gridline" x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}"/><text class="axis-label" x="${pad.l - 8}" y="${y(v) + 4}" text-anchor="end">${moneyShort(v)}</text>`).join('')}
    ${trend.map((p, i) => (i % labelEvery === (last % labelEvery) ? `<text class="axis-label" x="${x(i)}" y="${H - 8}" text-anchor="middle">${shortMonth(p.month)}</text>` : '')).join('')}
    <path class="line" d="${path('priorYear')}" stroke="var(--series-2)" stroke-dasharray="5 4"/>
    <path class="line" d="${path('total')}" stroke="var(--series-1)"/>
    <text class="series-label" x="${x(last) + 8}" y="${y(trend[last].total) + 4}">This year</text>
    <text class="series-label" x="${x(last) + 8}" y="${y(trend[last].priorYear) + 4 + (Math.abs(y(trend[last].total) - y(trend[last].priorYear)) < 14 ? 14 : 0)}">Prior year</text>
    <g id="hover" visibility="hidden">
      <line class="crosshair" y1="${pad.t}" y2="${pad.t + ih}"/>
      <circle class="dot" r="5" fill="var(--series-2)" data-k="priorYear"/>
      <circle class="dot" r="5" fill="var(--series-1)" data-k="total"/>
    </g>
    <rect x="${pad.l}" y="${pad.t}" width="${iw}" height="${ih}" fill="transparent" id="hit"/>
  </svg>`;

  $('#trendLegend').innerHTML = `
    <span class="key" style="color:var(--series-1)"><span class="swatch"></span><span style="color:var(--text-2)">This year</span></span>
    <span class="key" style="color:var(--series-2)"><span class="swatch dashed"></span><span style="color:var(--text-2)">Same month, prior year</span></span>`;

  const svg = $('svg', el), hover = $('#hover', svg);
  $('#hit', svg).addEventListener('mousemove', (e) => {
    const pt = svg.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY;
    const loc = pt.matrixTransform(svg.getScreenCTM().inverse());
    const i = Math.max(0, Math.min(last, Math.round(((loc.x - pad.l) / iw) * last)));
    const p = trend[i];
    hover.setAttribute('visibility', 'visible');
    $('line', hover).setAttribute('x1', x(i)); $('line', hover).setAttribute('x2', x(i));
    $$('circle', hover).forEach((c) => { c.setAttribute('cx', x(i)); c.setAttribute('cy', y(p[c.dataset.k])); });
    const chg = p.priorYear ? `${p.total >= p.priorYear ? '+' : ''}${Math.round(((p.total - p.priorYear) / p.priorYear) * 100)}%` : '—';
    showTip(`<b>${monthName(p.month)}</b>
      <div class="row"><span><span class="key-dot" style="background:var(--series-1)"></span>This year</span><span>${money(p.total)}</span></div>
      <div class="row"><span><span class="key-dot" style="background:var(--series-2)"></span>Prior year</span><span>${money(p.priorYear)}</span></div>
      <div class="row"><span>Change</span><span>${chg}</span></div>`, e.clientX, e.clientY);
  });
  $('#hit', svg).addEventListener('mouseleave', () => { hover.setAttribute('visibility', 'hidden'); hideTip(); });

  $('#trendTable').innerHTML = `<div class="table-wrap"><table><thead><tr><th>Month</th><th class="num">This year</th><th class="num">Prior year</th></tr></thead><tbody>
    ${trend.map((p) => `<tr><td>${monthName(p.month)}</td><td class="num">${money(p.total)}</td><td class="num">${money(p.priorYear)}</td></tr>`).join('')}</tbody></table></div>`;
}

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (location.hash === '#dashboard') renderDashboard(); }, 200);
});

// ---------------- notifications & reports ----------------
let activityReady = false;
async function renderActivity() {
  if (!activityReady) {
    activityReady = true;
    const [y, m] = meta.currentMonth.split('-').map(Number);
    const prev = new Date(y, m - 2, 1);
    $('#reportMonth').value = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}`;
    $$('button[data-job]').forEach((b) => b.addEventListener('click', async () => {
      b.disabled = true;
      $('#jobResult').textContent = 'Running…';
      try {
        const body = b.dataset.job === 'monthly-report' ? { month: $('#reportMonth').value } : {};
        const r = await api(`/api/automations/${b.dataset.job}/run`, { method: 'POST', body });
        $('#jobResult').textContent =
          b.dataset.job === 'budget-check' ? (r.length ? `${r.length} new budget alert(s) sent.` : 'No new alerts — every category is under its thresholds or was already alerted this month.')
          : b.dataset.job === 'monthly-report' ? `Report for ${r.label} generated.` : 'Weekly summary sent.';
        await renderActivity();
      } catch (err) { $('#jobResult').textContent = err.message; } finally { b.disabled = false; }
    }));
  }
  const [notes, reports] = await Promise.all([api('/api/notifications?limit=50'), api('/api/reports')]);
  $('#notifications').innerHTML = notes.length ? notes.map((n) => `
    <div class="notification">
      <div class="title">${n.type === 'budget-alert' || n.type === 'unusual-transaction' ? '🔔 ' : ''}${esc(n.title)}</div>
      <div class="meta">${new Date(n.createdAt).toLocaleString()} · to ${n.audience === 'team' ? 'team' : 'managers'}${n.recipients?.length ? ` (${esc(n.recipients.join(', '))})` : ''}${n.delivery?.webhook ? ` · webhook ${esc(n.delivery.webhook)}` : ''}</div>
      <pre>${esc(n.body)}</pre>
    </div>`).join('') : '<div class="empty">No notifications yet.</div>';
  $('#reports').innerHTML = reports.length
    ? reports.map((m) => `<li><a href="/api/reports/${m}.html" target="_blank" rel="noopener">${monthName(m)}</a> · <a href="/api/reports/${m}" target="_blank" rel="noopener" class="muted">JSON</a></li>`).join('')
    : '<li class="empty">No reports yet. One is generated automatically on the 1st of each month.</li>';
}

// ---------------- settings ----------------
async function renderSettings() {
  settings = await api('/api/settings');
  const form = $('#settingsForm');
  $('#budgetInputs').innerHTML = meta.categories.map((c) => `
    <label>${esc(c)}<input type="number" min="0" step="1" data-budget="${esc(c)}" value="${settings.budgets[c] ?? 0}"></label>`).join('');
  const managerRow = (m = {}) => `<div class="manager-row">
      <input placeholder="Name" data-m="name" value="${esc(m.name)}"><input type="email" placeholder="email@company.com" data-m="email" value="${esc(m.email)}">
      <button type="button" class="link" data-remove>Remove</button></div>`;
  $('#managerRows').innerHTML = (settings.managers.length ? settings.managers : [{}]).map(managerRow).join('');
  form.webhookUrl.value = settings.webhookUrl || '';
  $('#addManager').onclick = () => $('#managerRows').insertAdjacentHTML('beforeend', managerRow());
  $('#managerRows').onclick = (e) => { if (e.target.matches('[data-remove]')) e.target.closest('.manager-row').remove(); };
  form.onsubmit = async (ev) => {
    ev.preventDefault();
    const budgets = Object.fromEntries($$('[data-budget]').map((i) => [i.dataset.budget, Number(i.value)]));
    const managers = $$('.manager-row').map((r) => ({ name: $('[data-m=name]', r).value, email: $('[data-m=email]', r).value }));
    try {
      settings = await api('/api/settings', { method: 'PUT', body: { budgets, managers, webhookUrl: form.webhookUrl.value } });
      $('#settingsStatus').textContent = 'Saved.';
    } catch (err) { $('#settingsStatus').textContent = err.message; }
  };
}

// ---------------- boot ----------------
(async () => {
  [meta, settings] = await Promise.all([api('/api/meta'), api('/api/settings')]);
  $('#agentMode').textContent = `Agent: ${meta.agentMode}`;
  window.addEventListener('hashchange', route);
  route();
})();
