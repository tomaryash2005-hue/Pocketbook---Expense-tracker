import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { heuristicCategorize } from '../src/agent.js';
import { previousWeek } from '../src/automations.js';

const quiet = { warn() {}, log() {}, error() {} };
let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'expense-test-'));
});

const base = { date: '2026-09-10', paymentMethod: 'Corporate Card', receiptNotes: '' };

function makeApp(extra = {}) {
  return createApp({ dataDir: dir, agentOptions: { useClaude: false }, logger: quiet, ...extra });
}

test('heuristic categorizer uses keywords, then prefers vendor history', () => {
  assert.equal(heuristicCategorize({ vendor: 'Delta Air Lines' }).category, 'Travel');
  assert.equal(heuristicCategorize({ vendor: 'Acme', receiptNotes: 'team lunch at the cafe' }).category, 'Meals & Entertainment');
  assert.equal(heuristicCategorize({ vendor: 'Zyxw Ltd' }).category, 'Other');
  const history = [{ vendor: 'Acme Corp', category: 'Marketing' }, { vendor: 'ACME corp.', category: 'Marketing' }];
  const r = heuristicCategorize({ vendor: 'acme corp', receiptNotes: 'lunch' }, history);
  assert.equal(r.category, 'Marketing');
  assert.equal(r.source, 'history');
});

test('submitting without a category lets the agent choose it', async () => {
  const app = makeApp();
  const { expense, review } = await app.submitExpense({ ...base, amount: 30, vendor: 'Staples', receiptNotes: 'toner' });
  assert.equal(expense.category, 'Office Supplies');
  assert.equal(expense.status, 'Pending');
  assert.equal(review.categorization.applied, true);
});

test('a submitter-chosen category is kept and compared with the agent', async () => {
  const app = makeApp();
  const { expense, review } = await app.submitExpense({ ...base, amount: 30, vendor: 'Staples', category: 'Marketing' });
  assert.equal(expense.category, 'Marketing');
  assert.equal(review.categorization.agreesWithSubmitter, false);
});

test('uses Claude when available and falls back to rules on error', async () => {
  const calls = [];
  const fakeClient = {
    beta: { messages: { create: async (req) => {
      calls.push(req);
      return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ category: 'Training & Education', confidence: 0.8, reasoning: 'Course' }) }] };
    } } },
  };
  const app = createApp({ dataDir: dir, agentOptions: { client: fakeClient }, logger: quiet });
  const r = await app.agent.categorize({ ...base, amount: 20, vendor: 'Mystery Vendor' });
  assert.equal(r.category, 'Training & Education');
  assert.equal(r.source, 'claude');
  assert.equal(calls[0].output_config.format.type, 'json_schema');

  const broken = { beta: { messages: { create: async () => { throw new Error('boom'); } } } };
  const app2 = createApp({ dataDir: dir, agentOptions: { client: broken }, logger: quiet });
  const r2 = await app2.agent.categorize({ ...base, amount: 20, vendor: 'Delta Air Lines' });
  assert.equal(r2.category, 'Travel');
  assert.match(r2.reasoning, /Claude unavailable: boom/);
});

test('budget alerts fire once at 80% and once at 100% per category per month', async () => {
  const app = makeApp();
  app.store.updateSettings({ budgets: { Travel: 1000 }, managers: [{ name: 'M', email: 'm@example.com' }] });
  const submit = (amount, date = '2026-09-10') => app.submitExpense({ ...base, date, amount, vendor: 'Delta Air Lines' });

  let r = await submit(700);
  assert.equal(r.notifications.filter((n) => n.type === 'budget-alert').length, 0);
  r = await submit(150); // 85%
  const warn = r.notifications.filter((n) => n.type === 'budget-alert');
  assert.equal(warn.length, 1);
  assert.match(warn[0].title, /Budget warning: Travel at 85%/);
  assert.deepEqual(warn[0].recipients, ['m@example.com']);
  r = await submit(10); // still between thresholds: no repeat
  assert.equal(r.notifications.filter((n) => n.type === 'budget-alert').length, 0);
  r = await submit(200); // 106%
  const over = r.notifications.filter((n) => n.type === 'budget-alert');
  assert.equal(over.length, 1);
  assert.match(over[0].title, /Budget exceeded/);
  r = await submit(900, '2026-10-02'); // new month, straight to 90%
  assert.equal(r.notifications.filter((n) => n.type === 'budget-alert').length, 1);
});

test('unusual transactions notify managers on submission', async () => {
  const app = makeApp();
  for (const amt of [50, 60, 55]) await app.submitExpense({ ...base, amount: amt, vendor: 'Sweetgreen', receiptNotes: 'lunch' });
  const r = await app.submitExpense({ ...base, amount: 400, vendor: 'Sweetgreen', receiptNotes: 'lunch' });
  assert.ok(r.review.anomaly);
  assert.equal(r.review.anomaly.average, 55);
  assert.ok(r.notifications.some((n) => n.type === 'unusual-transaction'));
  assert.ok(r.expense.unusual);
});

test('previousWeek returns the prior Monday-Sunday', () => {
  assert.deepEqual(
    (({ start, end }) => ({ start, end }))(previousWeek(new Date(2026, 8, 26, 12))), // Sat 26 Sep 2026
    { start: '2026-09-14', end: '2026-09-20' },
  );
  assert.equal(previousWeek(new Date(2026, 8, 28, 9)).start, '2026-09-21'); // Monday
});

test('scheduler runs weekly and monthly jobs once per period, after their due time', async () => {
  let now = new Date(2026, 9, 1, 5, 0); // Thu 1 Oct 2026, 05:00 — before the 06:00 report
  const app = makeApp({ now: () => now });
  await app.submitExpense({ ...base, date: '2026-09-22', amount: 100, vendor: 'Uber' });
  await app.submitExpense({ ...base, date: '2025-09-22', amount: 50, vendor: 'Uber' });

  let ran = await app.automations.tick();
  assert.ok(ran.includes('weekly-summary'), 'catches up on the missed Monday summary');
  assert.ok(!ran.includes('monthly-report'));

  now = new Date(2026, 9, 1, 6, 30);
  ran = await app.automations.tick();
  assert.deepEqual(ran.filter((j) => j !== 'budget-check'), ['monthly-report']);
  const report = JSON.parse(app.store.readReport('2026-09'));
  assert.equal(report.totals.spent, 100);
  assert.equal(report.yearOverYear.priorTotal, 50);
  assert.equal(report.yearOverYear.changePct, 100);
  assert.ok(app.store.readReport('2026-09', 'html').includes('Expense Report'));

  now = new Date(2026, 9, 3, 12);
  ran = await app.automations.tick();
  assert.deepEqual(ran.filter((j) => j !== 'budget-check'), []);

  now = new Date(2026, 9, 5, 9, 5); // next Monday after 09:00
  ran = await app.automations.tick();
  assert.ok(ran.includes('weekly-summary'));
  const weekly = app.store.listNotifications().find((n) => n.type === 'weekly-summary');
  assert.match(weekly.title, /2026-09-28 to 2026-10-04/);
});

test('webhook delivery posts JSON and records the result', async () => {
  const posts = [];
  const app = makeApp({ fetchImpl: async (url, opts) => { posts.push({ url, body: JSON.parse(opts.body) }); return { ok: true, status: 200 }; } });
  app.store.updateSettings({ webhookUrl: 'https://hooks.example.com/x' });
  const n = await app.automations.run('weekly-summary');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].body.type, 'weekly-summary');
  assert.match(posts[0].body.text, /Weekly spending summary/);
  assert.equal(n.delivery.webhook, 'delivered');
});

test('re-categorizing an expense via PATCH asks the agent', async () => {
  const app = makeApp();
  const { expense } = await app.submitExpense({ ...base, amount: 30, vendor: 'Hilton', category: 'Other' });
  const updated = await app.updateExpense(expense.id, { category: 'auto' });
  assert.equal(updated.category, 'Travel');
  const approved = await app.updateExpense(expense.id, { status: 'Approved', reviewedBy: 'Boss' });
  assert.equal(approved.status, 'Approved');
  assert.ok(approved.reviewedAt);
});
