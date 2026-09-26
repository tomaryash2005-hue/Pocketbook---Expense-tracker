import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  budgetComparison,
  detectAnomalies,
  checkAnomaly,
  monthlyReport,
  periodSummary,
  shiftMonth,
  monthlyTrend,
} from '../src/analytics.js';

const e = (id, date, category, amount, status = 'Approved') => ({ id, date, category, amount, status, vendor: `V${id}` });

test('shiftMonth crosses year boundaries', () => {
  assert.equal(shiftMonth('2026-01', -1), '2025-12');
  assert.equal(shiftMonth('2026-09', -12), '2025-09');
  assert.equal(shiftMonth('2025-12', 1), '2026-01');
});

test('budgetComparison sums the month, excludes rejected, and sets status', () => {
  const expenses = [
    e('1', '2026-09-01', 'Travel', 3000),
    e('2', '2026-09-15', 'Travel', 1100),
    e('3', '2026-09-20', 'Travel', 5000, 'Rejected'),
    e('4', '2026-08-31', 'Travel', 999),
    e('5', '2026-09-03', 'Marketing', 500, 'Pending'),
  ];
  const r = budgetComparison(expenses, { Travel: 5000, Marketing: 400 }, '2026-09');
  const travel = r.categories.find((c) => c.category === 'Travel');
  assert.equal(travel.spent, 4100);
  assert.equal(travel.pct, 82);
  assert.equal(travel.status, 'warning');
  assert.equal(travel.count, 2);
  const marketing = r.categories.find((c) => c.category === 'Marketing');
  assert.equal(marketing.status, 'over');
  const other = r.categories.find((c) => c.category === 'Other');
  assert.equal(other.status, 'no-budget');
  assert.equal(r.totals.spent, 4600);
});

test('detectAnomalies flags amounts above 150% of the other transactions in the category', () => {
  const expenses = [
    e('a', '2026-09-01', 'Meals & Entertainment', 100),
    e('b', '2026-09-02', 'Meals & Entertainment', 100),
    e('c', '2026-09-03', 'Meals & Entertainment', 100),
    e('d', '2026-09-04', 'Meals & Entertainment', 151),
    e('x', '2026-09-05', 'Meals & Entertainment', 150),
  ];
  const flagged = detectAnomalies(expenses);
  // d vs avg(100,100,100,150)=112.5 -> 1.34x: not flagged
  assert.equal(flagged.has('d'), false);
  const big = [...expenses.slice(0, 3), e('big', '2026-09-06', 'Meals & Entertainment', 151)];
  const f2 = detectAnomalies(big);
  assert.ok(f2.has('big'), '151 > 1.5 x 100');
  assert.equal(f2.get('big').average, 100);
  assert.equal(f2.get('big').samples, 3);
  // exactly 150% is not "exceeding"
  const edge = detectAnomalies([...expenses.slice(0, 3), e('edge', '2026-09-06', 'Meals & Entertainment', 150)]);
  assert.equal(edge.has('edge'), false);
});

test('detectAnomalies needs enough samples and ignores rejected expenses', () => {
  const few = [e('1', '2026-09-01', 'Travel', 100), e('2', '2026-09-02', 'Travel', 100), e('3', '2026-09-03', 'Travel', 900)];
  assert.equal(detectAnomalies(few).size, 0);
  const withRejected = [...few, e('4', '2026-09-04', 'Travel', 100, 'Rejected')];
  assert.equal(detectAnomalies(withRejected).size, 0);
  const rejectedBig = [e('1', '2026-09-01', 'Travel', 100), e('2', '2026-09-02', 'Travel', 100), e('3', '2026-09-03', 'Travel', 100), e('4', '2026-09-04', 'Travel', 9000, 'Rejected')];
  assert.equal(detectAnomalies(rejectedBig).size, 0);
});

test('checkAnomaly evaluates a new expense against history', () => {
  const history = [1, 2, 3].map((i) => e(String(i), '2026-09-01', 'Travel', 200));
  assert.equal(checkAnomaly({ date: '2026-09-10', category: 'Travel', amount: 250, status: 'Pending' }, history), null);
  const hit = checkAnomaly({ date: '2026-09-10', category: 'Travel', amount: 400, status: 'Pending' }, history);
  assert.deepEqual(hit, { average: 200, ratio: 2, samples: 3 });
});

test('monthlyReport computes year-over-year and YTD comparisons', () => {
  const expenses = [
    e('1', '2025-03-10', 'Travel', 1000),
    e('2', '2025-09-10', 'Travel', 2000),
    e('3', '2025-10-10', 'Travel', 7000), // after the comparison window: excluded from prior YTD
    e('4', '2026-02-10', 'Travel', 1500),
    e('5', '2026-08-10', 'Marketing', 400),
    e('6', '2026-09-10', 'Travel', 3000),
  ];
  const r = monthlyReport(expenses, { Travel: 5000, Marketing: 1000 }, '2026-09');
  assert.equal(r.totals.spent, 3000);
  assert.equal(r.yearOverYear.comparedMonth, '2025-09');
  assert.equal(r.yearOverYear.priorTotal, 2000);
  assert.equal(r.yearOverYear.changePct, 50);
  assert.deepEqual(r.yearOverYear.ytd, { current: 4900, prior: 3000, changePct: 63.33 });
  assert.equal(r.monthOverMonth.priorTotal, 400);
  const travel = r.categories.find((c) => c.category === 'Travel');
  assert.equal(travel.priorYear, 2000);
  assert.equal(travel.yoyChangePct, 50);
  const marketing = r.categories.find((c) => c.category === 'Marketing');
  assert.equal(marketing.yoyChangePct, 0);
});

test('monthlyReport reports null YoY change when there was no prior spend', () => {
  const r = monthlyReport([e('1', '2026-09-10', 'Travel', 10)], {}, '2026-09');
  assert.equal(r.yearOverYear.changePct, null);
});

test('periodSummary covers an inclusive date range', () => {
  const expenses = [
    e('1', '2026-09-13', 'Travel', 1),
    e('2', '2026-09-14', 'Travel', 10),
    e('3', '2026-09-20', 'Utilities', 20, 'Pending'),
    e('4', '2026-09-21', 'Travel', 100),
  ];
  const s = periodSummary(expenses, { Travel: 100 }, '2026-09-14', '2026-09-20');
  assert.equal(s.total, 30);
  assert.equal(s.count, 2);
  assert.equal(s.pendingApprovals, 1);
  assert.equal(s.byCategory[0].category, 'Utilities');
});

test('monthlyTrend pairs each month with the same month a year earlier', () => {
  const t = monthlyTrend([e('1', '2025-09-01', 'Travel', 5), e('2', '2026-09-01', 'Travel', 7)], '2026-09', 3);
  assert.deepEqual(t.map((x) => x.month), ['2026-07', '2026-08', '2026-09']);
  assert.deepEqual(t[2], { month: '2026-09', total: 7, priorYear: 5 });
});
