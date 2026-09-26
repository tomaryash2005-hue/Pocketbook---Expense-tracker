// Scheduled and event-driven automations:
//   - weekly-summary   every Monday (default 09:00 local) for the previous Mon-Sun week
//   - budget-check     after every submission/edit, and hourly as a safety net: alerts
//                      managers once per category per month at 80% and at 100% of the limit
//   - monthly-report   on the 1st (default 06:00 local) for the month that just ended,
//                      with month-over-month and year-over-year comparisons
//
// Scheduling is idempotent: each job records the period it last covered (week start or
// month), so restarts never double-send and a server that was down catches up on the
// most recent missed period at the next tick. The same jobs can be run from system cron
// via `npm run job -- <name>` instead of the in-process scheduler.

import {
  toISODate,
  shiftMonth,
  monthOf,
  monthLabel,
  budgetComparison,
  periodSummary,
  monthlyReport,
} from './analytics.js';
import { BUDGET_ALERT_THRESHOLDS } from './constants.js';

const money = (n, currency = 'USD') =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(n);

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Monday..Sunday of the week before the week containing `now`. */
export function previousWeek(now) {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const sinceMonday = (d.getDay() + 6) % 7;
  const thisMonday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - sinceMonday);
  const start = new Date(thisMonday.getFullYear(), thisMonday.getMonth(), thisMonday.getDate() - 7);
  const end = new Date(thisMonday.getFullYear(), thisMonday.getMonth(), thisMonday.getDate() - 1);
  return { start: toISODate(start), end: toISODate(end), thisMonday };
}

export class Automations {
  constructor({ store, notifier, now = () => new Date(), weeklyHour = 9, monthlyHour = 6 }) {
    this.store = store;
    this.notifier = notifier;
    this.now = now;
    this.weeklyHour = weeklyHour;
    this.monthlyHour = monthlyHour;
    this.timer = null;
    this.lastHourlyCheck = 0;
  }

  get currency() {
    return this.store.settings.currency || 'USD';
  }

  // ---------- weekly spending summary ----------

  async weeklySummary({ start, end } = previousWeek(this.now())) {
    const s = periodSummary(this.store.listExpenses(), this.store.settings.budgets, start, end);
    const c = this.currency;
    const lines = [
      `Spending ${start} to ${end}: ${money(s.total, c)} across ${s.count} expense(s).`,
    ];
    if (s.byCategory.length) {
      lines.push('', 'By category:');
      for (const row of s.byCategory) lines.push(`  - ${row.category}: ${money(row.total, c)}`);
    }
    if (s.topVendors.length) {
      lines.push('', 'Top vendors:');
      for (const v of s.topVendors) lines.push(`  - ${v.vendor}: ${money(v.total, c)}`);
    }
    if (s.flagged.length) {
      lines.push('', `Unusual transactions (>150% of category average): ${s.flagged.length}`);
      for (const f of s.flagged) lines.push(`  - ${f.date} ${f.vendor} ${money(f.amount, c)} (${f.ratio}x ${f.category} avg)`);
    }
    if (s.pendingApprovals) lines.push('', `Awaiting approval: ${s.pendingApprovals}`);
    const mtd = s.monthToDate;
    lines.push('', `${monthLabel(mtd.month)} to date: ${money(mtd.totals.spent, c)} of ${money(mtd.totals.limit, c)} budget (${mtd.totals.pct ?? 0}%).`);
    const hot = mtd.categories.filter((x) => x.status !== 'ok' && x.status !== 'no-budget');
    for (const x of hot) lines.push(`  - ${x.category}: ${x.pct}% used`);

    return this.notifier.send({
      type: 'weekly-summary',
      title: `Weekly spending summary (${start} to ${end})`,
      body: lines.join('\n'),
      audience: 'team',
      data: s,
    });
  }

  // ---------- budget threshold alerts ----------

  /** Checks one month (default: every month touched by `months`) and alerts once per threshold. */
  async checkBudgets(months = [monthOf(toISODate(this.now()))]) {
    const sent = [];
    const { budgets } = this.store.settings;
    const expenses = this.store.listExpenses();
    for (const month of new Set(months)) {
      const comparison = budgetComparison(expenses, budgets, month);
      for (const cat of comparison.categories) {
        if (cat.limit <= 0) continue;
        // Only the highest threshold crossed is announced; lower ones are marked as covered.
        const crossed = BUDGET_ALERT_THRESHOLDS.filter((t) => cat.spent >= cat.limit * t);
        if (!crossed.length) continue;
        const top = Math.max(...crossed);
        const key = (t) => `${month}|${cat.category}|${t}`;
        if (this.store.hasAlert(key(top))) continue;
        for (const t of crossed) if (!this.store.hasAlert(key(t))) this.store.markAlert(key(t));

        const over = top >= 1;
        sent.push(
          await this.notifier.send({
            type: 'budget-alert',
            title: over
              ? `Budget exceeded: ${cat.category} (${monthLabel(month)})`
              : `Budget warning: ${cat.category} at ${cat.pct}% (${monthLabel(month)})`,
            body:
              `${cat.category} has spent ${money(cat.spent, this.currency)} of its ` +
              `${money(cat.limit, this.currency)} monthly limit (${cat.pct}%) across ${cat.count} expense(s). ` +
              (over
                ? `It is ${money(-cat.remaining, this.currency)} over budget.`
                : `${money(cat.remaining, this.currency)} remains for the month.`),
            audience: 'managers',
            data: { month, threshold: top, ...cat },
          }),
        );
      }
    }
    return sent;
  }

  // ---------- unusual transaction alert (event-driven) ----------

  async unusualTransaction(expense, anomaly) {
    return this.notifier.send({
      type: 'unusual-transaction',
      title: `Unusual ${expense.category} expense: ${expense.vendor} ${money(expense.amount, this.currency)}`,
      body:
        `${expense.vendor} on ${expense.date} for ${money(expense.amount, this.currency)} is ${anomaly.ratio}x the ` +
        `${expense.category} average of ${money(anomaly.average, this.currency)} (based on ${anomaly.samples} expenses). ` +
        `Payment: ${expense.paymentMethod}. Status: ${expense.status}.`,
      audience: 'managers',
      data: { expense, anomaly },
    });
  }

  // ---------- end-of-month report ----------

  async monthlyReport(month = shiftMonth(monthOf(toISODate(this.now())), -1)) {
    const report = monthlyReport(this.store.listExpenses(), this.store.settings.budgets, month);
    this.store.saveReport(month, report, renderReportHtml(report, this.currency));
    const c = this.currency;
    const yoy = report.yearOverYear;
    const fmtPct = (p) => (p === null ? 'n/a (no prior spend)' : `${p > 0 ? '+' : ''}${p}%`);
    const lines = [
      `Total spend: ${money(report.totals.spent, c)} of ${money(report.totals.budget, c)} budget (${report.totals.pctOfBudget ?? 0}%), ${report.totals.transactions} expense(s).`,
      `Year over year vs ${monthLabel(yoy.comparedMonth)}: ${money(yoy.priorTotal, c)} -> ${fmtPct(yoy.changePct)}.`,
      `Year to date: ${money(yoy.ytd.current, c)} vs ${money(yoy.ytd.prior, c)} last year (${fmtPct(yoy.ytd.changePct)}).`,
      `Month over month: ${fmtPct(report.monthOverMonth.changePct)}.`,
    ];
    if (report.overBudget.length) lines.push(`Over budget: ${report.overBudget.join(', ')}.`);
    if (report.flagged.length) lines.push(`Unusual transactions: ${report.flagged.length}.`);
    lines.push('', `Full report: /api/reports/${month}.html`);

    await this.notifier.send({
      type: 'monthly-report',
      title: `Expense report: ${report.label}`,
      body: lines.join('\n'),
      audience: 'managers',
      data: { month, totals: report.totals, yearOverYear: yoy },
    });
    return report;
  }

  // ---------- scheduler ----------

  /** Runs whichever scheduled jobs are due. Safe to call as often as you like. */
  async tick() {
    const now = this.now();
    const ran = [];

    const week = previousWeek(now);
    const weeklyDue = new Date(week.thisMonday);
    weeklyDue.setHours(this.weeklyHour, 0, 0, 0);
    if (now >= weeklyDue && this.store.lastRun('weekly-summary') !== week.start) {
      await this.weeklySummary(week);
      this.store.markRun('weekly-summary', week.start);
      ran.push('weekly-summary');
    }

    const reportMonth = shiftMonth(monthOf(toISODate(now)), -1);
    const monthlyDue = new Date(now.getFullYear(), now.getMonth(), 1, this.monthlyHour);
    if (now >= monthlyDue && this.store.lastRun('monthly-report') !== reportMonth) {
      await this.monthlyReport(reportMonth);
      this.store.markRun('monthly-report', reportMonth);
      ran.push('monthly-report');
    }

    if (now.getTime() - this.lastHourlyCheck >= 60 * 60 * 1000) {
      this.lastHourlyCheck = now.getTime();
      await this.checkBudgets();
      ran.push('budget-check');
    }
    return ran;
  }

  start(intervalMs = 60 * 1000) {
    const run = () => this.tick().catch((err) => console.error('[automations]', err));
    run();
    this.timer = setInterval(run, intervalMs);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
  }

  /** Manual trigger used by the API and CLI. */
  async run(job, arg) {
    switch (job) {
      case 'weekly-summary':
        return this.weeklySummary(arg?.start && arg?.end ? { start: arg.start, end: arg.end } : undefined);
      case 'budget-check':
        return this.checkBudgets(arg?.month ? [arg.month] : undefined);
      case 'monthly-report':
        return this.monthlyReport(arg?.month);
      default:
        throw new Error(`Unknown job "${job}". Use weekly-summary, budget-check or monthly-report.`);
    }
  }
}

export function renderReportHtml(r, currency = 'USD') {
  const m = (n) => money(n, currency);
  const pct = (p) => (p === null ? '—' : `${p > 0 ? '+' : ''}${p}%`);
  const rows = r.categories
    .filter((c) => c.spent || c.priorYear || c.limit)
    .map(
      (c) => `<tr class="${c.status}"><td>${escapeHtml(c.category)}</td><td>${m(c.spent)}</td><td>${m(c.limit)}</td>
        <td>${c.pct === null ? '—' : `${c.pct}%`}</td><td>${m(c.priorMonth)}</td><td>${m(c.priorYear)}</td><td>${pct(c.yoyChangePct)}</td></tr>`,
    )
    .join('');
  const flagged = r.flagged.length
    ? `<h2>Unusual transactions</h2><table><tr><th>Date</th><th>Vendor</th><th>Category</th><th>Amount</th><th>Category avg</th><th>Ratio</th></tr>
      ${r.flagged.map((f) => `<tr><td>${f.date}</td><td>${escapeHtml(f.vendor)}</td><td>${escapeHtml(f.category)}</td><td>${m(f.amount)}</td><td>${m(f.average)}</td><td>${f.ratio}x</td></tr>`).join('')}</table>`
    : '';
  const vendors = r.topVendors.map((v) => `<tr><td>${escapeHtml(v.vendor)}</td><td>${m(v.total)}</td></tr>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Expense Report ${escapeHtml(r.label)}</title>
<style>
body{font:14px/1.5 system-ui,sans-serif;max-width:960px;margin:24px auto;padding:0 16px;color:#1f2328}
h1{margin-bottom:0}.muted{color:#656d76}table{border-collapse:collapse;width:100%;margin:12px 0 24px}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #d0d7de}td:not(:first-child),th:not(:first-child){text-align:right}
tr.warning td:first-child{border-left:3px solid #bf8700}tr.over td:first-child{border-left:3px solid #cf222e}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin:16px 0}
.kpi{border:1px solid #d0d7de;border-radius:8px;padding:12px}.kpi b{display:block;font-size:20px}
</style></head><body>
<h1>Expense Report — ${escapeHtml(r.label)}</h1><p class="muted">Generated ${new Date(r.generatedAt).toLocaleString()}</p>
<div class="kpis">
<div class="kpi">Total spend<b>${m(r.totals.spent)}</b>${r.totals.pctOfBudget ?? 0}% of ${m(r.totals.budget)}</div>
<div class="kpi">vs ${escapeHtml(monthLabel(r.yearOverYear.comparedMonth))}<b>${pct(r.yearOverYear.changePct)}</b>${m(r.yearOverYear.priorTotal)} last year</div>
<div class="kpi">Year to date<b>${m(r.yearOverYear.ytd.current)}</b>${pct(r.yearOverYear.ytd.changePct)} vs ${m(r.yearOverYear.ytd.prior)}</div>
<div class="kpi">Transactions<b>${r.totals.transactions}</b>${r.totals.approved} approved · ${r.totals.pending} pending</div>
</div>
<h2>By category</h2><table><tr><th>Category</th><th>Spent</th><th>Budget</th><th>Used</th><th>Prior month</th><th>Same month last year</th><th>YoY</th></tr>${rows}</table>
${flagged}
<h2>Top vendors</h2><table><tr><th>Vendor</th><th>Total</th></tr>${vendors || '<tr><td colspan="2">No spend</td></tr>'}</table>
</body></html>`;
}
