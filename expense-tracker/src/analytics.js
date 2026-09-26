// Pure spending calculations shared by the dashboard, the agent, and the automations.
// Dates are ISO 'YYYY-MM-DD' strings throughout, so month/range logic is plain string work
// and never shifts with the server's time zone.

import {
  CATEGORIES,
  ANOMALY_MULTIPLIER,
  ANOMALY_MIN_SAMPLES,
} from './constants.js';

const round2 = (n) => Math.round(n * 100) / 100;

export function toISODate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export const monthOf = (isoDate) => isoDate.slice(0, 7);

export function shiftMonth(month, delta) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function monthLabel(month) {
  const [y, m] = month.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleString('en-US', { month: 'long', year: 'numeric' });
}

// Rejected expenses never count against a budget or an average.
export const isCountable = (e) => e.status !== 'Rejected';

function sumByCategory(expenses) {
  const totals = Object.fromEntries(CATEGORIES.map((c) => [c, 0]));
  for (const e of expenses) totals[e.category] = (totals[e.category] ?? 0) + e.amount;
  for (const c of Object.keys(totals)) totals[c] = round2(totals[c]);
  return totals;
}

export function expensesInMonth(expenses, month) {
  return expenses.filter((e) => isCountable(e) && monthOf(e.date) === month);
}

export function expensesInRange(expenses, start, end) {
  return expenses.filter((e) => isCountable(e) && e.date >= start && e.date <= end);
}

export function budgetStatus(pct) {
  if (pct === null) return 'no-budget';
  if (pct >= 100) return 'over';
  if (pct >= 80) return 'warning';
  return 'ok';
}

/** Spend vs. monthly limit for every category in `month`. */
export function budgetComparison(expenses, budgets, month) {
  const inMonth = expensesInMonth(expenses, month);
  const totals = sumByCategory(inMonth);
  const categories = Object.keys(totals).map((category) => {
    const limit = Number(budgets[category]) || 0;
    const spent = totals[category];
    const pct = limit > 0 ? round2((spent / limit) * 100) : null;
    return {
      category,
      spent,
      limit,
      remaining: round2(limit - spent),
      pct,
      status: budgetStatus(pct),
      count: inMonth.filter((e) => e.category === category).length,
    };
  });
  const spent = round2(categories.reduce((s, c) => s + c.spent, 0));
  const limit = round2(categories.reduce((s, c) => s + c.limit, 0));
  return {
    month,
    categories,
    totals: {
      spent,
      limit,
      remaining: round2(limit - spent),
      pct: limit > 0 ? round2((spent / limit) * 100) : null,
    },
  };
}

/**
 * Flags transactions whose amount exceeds ANOMALY_MULTIPLIER x the average of the
 * *other* countable transactions in the same category. Leaving the transaction out of
 * its own baseline keeps one huge charge from hiding itself by inflating the average.
 * Returns a Map of expense id -> { average, ratio, samples }.
 */
export function detectAnomalies(
  expenses,
  { multiplier = ANOMALY_MULTIPLIER, minSamples = ANOMALY_MIN_SAMPLES } = {},
) {
  const byCategory = new Map();
  for (const e of expenses) {
    if (!isCountable(e)) continue;
    if (!byCategory.has(e.category)) byCategory.set(e.category, { sum: 0, n: 0 });
    const agg = byCategory.get(e.category);
    agg.sum += e.amount;
    agg.n += 1;
  }

  const flagged = new Map();
  for (const e of expenses) {
    if (!isCountable(e)) continue;
    const agg = byCategory.get(e.category);
    const samples = agg.n - 1;
    if (samples < minSamples) continue;
    const average = (agg.sum - e.amount) / samples;
    if (average > 0 && e.amount > average * multiplier) {
      flagged.set(e.id, {
        average: round2(average),
        ratio: round2(e.amount / average),
        samples,
      });
    }
  }
  return flagged;
}

/** Evaluates a not-yet-saved expense against the existing history. */
export function checkAnomaly(expense, existing, opts) {
  const probe = { ...expense, id: expense.id ?? '__probe__' };
  const others = existing.filter((e) => e.id !== probe.id);
  return detectAnomalies([...others, probe], opts).get(probe.id) ?? null;
}

function topVendors(expenses, n = 5) {
  const byVendor = new Map();
  for (const e of expenses) byVendor.set(e.vendor, (byVendor.get(e.vendor) ?? 0) + e.amount);
  return [...byVendor.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([vendor, total]) => ({ vendor, total: round2(total) }));
}

function pctChange(current, previous) {
  if (previous === 0) return current === 0 ? 0 : null;
  return round2(((current - previous) / previous) * 100);
}

/** Summary for an inclusive date range (used by the weekly automation). */
export function periodSummary(expenses, budgets, start, end) {
  const inRange = expensesInRange(expenses, start, end);
  const anomalies = detectAnomalies(expenses);
  const totals = sumByCategory(inRange);
  const month = monthOf(end);
  return {
    start,
    end,
    total: round2(inRange.reduce((s, e) => s + e.amount, 0)),
    count: inRange.length,
    byCategory: Object.entries(totals)
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([category, total]) => ({ category, total })),
    topVendors: topVendors(inRange),
    pendingApprovals: inRange.filter((e) => e.status === 'Pending').length,
    flagged: inRange
      .filter((e) => anomalies.has(e.id))
      .map((e) => ({ ...pick(e), ...anomalies.get(e.id) })),
    monthToDate: budgetComparison(expenses, budgets, month),
  };
}

const pick = (e) => ({
  id: e.id,
  date: e.date,
  vendor: e.vendor,
  category: e.category,
  amount: e.amount,
  status: e.status,
});

/** End-of-month report with month-over-month and year-over-year comparisons. */
export function monthlyReport(expenses, budgets, month) {
  const lastYear = shiftMonth(month, -12);
  const prevMonth = shiftMonth(month, -1);
  const current = budgetComparison(expenses, budgets, month);
  const priorYear = sumByCategory(expensesInMonth(expenses, lastYear));
  const priorMonth = sumByCategory(expensesInMonth(expenses, prevMonth));
  const anomalies = detectAnomalies(expenses);
  const inMonth = expensesInMonth(expenses, month);

  const year = month.slice(0, 4);
  const ytd = (y, uptoMonth) =>
    round2(
      expenses
        .filter((e) => isCountable(e) && e.date.startsWith(y) && monthOf(e.date) <= uptoMonth)
        .reduce((s, e) => s + e.amount, 0),
    );
  const ytdCurrent = ytd(year, month);
  const ytdPrior = ytd(String(Number(year) - 1), lastYear);
  const priorYearTotal = round2(Object.values(priorYear).reduce((s, v) => s + v, 0));
  const priorMonthTotal = round2(Object.values(priorMonth).reduce((s, v) => s + v, 0));

  return {
    month,
    label: monthLabel(month),
    generatedAt: new Date().toISOString(),
    totals: {
      spent: current.totals.spent,
      budget: current.totals.limit,
      pctOfBudget: current.totals.pct,
      transactions: inMonth.length,
      approved: inMonth.filter((e) => e.status === 'Approved').length,
      pending: inMonth.filter((e) => e.status === 'Pending').length,
    },
    yearOverYear: {
      comparedMonth: lastYear,
      priorTotal: priorYearTotal,
      change: round2(current.totals.spent - priorYearTotal),
      changePct: pctChange(current.totals.spent, priorYearTotal),
      ytd: { current: ytdCurrent, prior: ytdPrior, changePct: pctChange(ytdCurrent, ytdPrior) },
    },
    monthOverMonth: {
      comparedMonth: prevMonth,
      priorTotal: priorMonthTotal,
      changePct: pctChange(current.totals.spent, priorMonthTotal),
    },
    categories: current.categories.map((c) => ({
      ...c,
      priorYear: priorYear[c.category] ?? 0,
      yoyChangePct: pctChange(c.spent, priorYear[c.category] ?? 0),
      priorMonth: priorMonth[c.category] ?? 0,
    })),
    overBudget: current.categories.filter((c) => c.status === 'over').map((c) => c.category),
    topVendors: topVendors(inMonth, 10),
    flagged: inMonth
      .filter((e) => anomalies.has(e.id))
      .map((e) => ({ ...pick(e), ...anomalies.get(e.id) })),
  };
}

/** Monthly totals for the trailing `months` months ending at `endMonth`, with prior-year values. */
export function monthlyTrend(expenses, endMonth, months = 12) {
  const totalFor = (m) =>
    round2(expensesInMonth(expenses, m).reduce((s, e) => s + e.amount, 0));
  const out = [];
  for (let i = months - 1; i >= 0; i--) {
    const m = shiftMonth(endMonth, -i);
    out.push({ month: m, total: totalFor(m), priorYear: totalFor(shiftMonth(m, -12)) });
  }
  return out;
}
