import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { createServer } from '../src/server.js';

let server;
let baseUrl;

before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'expense-api-'));
  const app = createApp({ dataDir: dir, agentOptions: { useClaude: false }, logger: { warn() {}, error() {} } });
  server = createServer(app);
  await new Promise((r) => server.listen(0, r));
  baseUrl = `http://localhost:${server.address().port}`;
});
after(() => server.close());

const call = async (method, p, body) => {
  const res = await fetch(baseUrl + p, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return { status: res.status, body: text && res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text };
};

test('expense CRUD, ledger and dashboard', async () => {
  const created = await call('POST', '/api/expenses', {
    date: '2026-09-10', amount: '120.5', vendor: 'Marriott', paymentMethod: 'Corporate Card', receiptNotes: 'Hotel',
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.expense.category, 'Travel');
  const id = created.body.expense.id;

  const list = await call('GET', '/api/expenses?month=2026-09');
  assert.equal(list.body.length, 1);

  const ledger = await call('GET', '/api/ledger?month=2026-09');
  assert.equal(ledger.body.groups[0].category, 'Travel');
  assert.equal(ledger.body.groups[0].subtotal, 120.5);

  const patched = await call('PATCH', `/api/expenses/${id}`, { status: 'Rejected' });
  assert.equal(patched.body.status, 'Rejected');
  const dash = await call('GET', '/api/dashboard?month=2026-09');
  assert.equal(dash.body.budget.totals.spent, 0, 'rejected expenses do not count');
  assert.equal(dash.body.trend.length, 12);

  assert.equal((await call('DELETE', `/api/expenses/${id}`)).status, 204);
  assert.equal((await call('GET', `/api/expenses/${id}`)).status, 404);
});

test('validation errors are reported', async () => {
  const r = await call('POST', '/api/expenses', { date: '2026-02-30', amount: 0, vendor: '', paymentMethod: 'Bitcoin', category: 'Snacks' });
  assert.equal(r.status, 400);
  assert.equal(r.body.details.length, 5);
  assert.equal((await call('GET', '/api/dashboard?month=2026-9')).status, 400);
  assert.equal((await call('PUT', '/api/settings', { budgets: { Travel: -5 } })).status, 400);
  assert.equal((await call('PUT', '/api/settings', { managers: [{ name: 'x', email: 'nope' }] })).status, 400);
});

test('settings, categorize, automations and reports endpoints', async () => {
  const s = await call('PUT', '/api/settings', { budgets: { Travel: 2000 }, managers: [{ name: 'Fin', email: 'fin@example.com' }] });
  assert.equal(s.body.budgets.Travel, 2000);

  const cat = await call('POST', '/api/agent/categorize', { vendor: 'Google Ads' });
  assert.equal(cat.body.category, 'Marketing');

  const rep = await call('POST', '/api/automations/monthly-report/run', { month: '2026-08' });
  assert.equal(rep.body.month, '2026-08');
  assert.deepEqual((await call('GET', '/api/reports')).body, ['2026-08']);
  const html = await call('GET', '/api/reports/2026-08.html');
  assert.match(html.body, /Expense Report/);
  assert.equal((await call('POST', '/api/automations/nope/run')).status, 404);

  const notes = await call('GET', '/api/notifications');
  assert.equal(notes.body[0].type, 'monthly-report');
});

test('static files are served and path traversal is blocked', async () => {
  const index = await call('GET', '/');
  assert.match(index.body, /Expense Tracker/);
  const res = await fetch(`${baseUrl}/%2e%2e/src/server.js`);
  assert.equal(res.status, 404);
});
