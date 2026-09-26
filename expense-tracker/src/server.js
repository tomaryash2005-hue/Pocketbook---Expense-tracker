import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { ValidationError } from './validation.js';
import { CATEGORIES, PAYMENT_METHODS, APPROVAL_STATUSES, ANOMALY_MULTIPLIER, BUDGET_ALERT_THRESHOLDS } from './constants.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const MONTH_RE = /^\d{4}-\d{2}$/;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw new HttpError(413, 'Request body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Invalid JSON body');
  }
}

function monthParam(url, app) {
  const month = url.searchParams.get('month') || app.currentMonth();
  if (!MONTH_RE.test(month)) throw new HttpError(400, 'month must be YYYY-MM');
  return month;
}

function validateSettings(body) {
  const patch = {};
  if (body.budgets !== undefined) {
    patch.budgets = {};
    for (const [cat, v] of Object.entries(body.budgets)) {
      if (!CATEGORIES.includes(cat)) throw new HttpError(400, `Unknown category: ${cat}`);
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) throw new HttpError(400, `Budget for ${cat} must be a non-negative number`);
      patch.budgets[cat] = Math.round(n * 100) / 100;
    }
  }
  if (body.managers !== undefined) {
    if (!Array.isArray(body.managers)) throw new HttpError(400, 'managers must be an array');
    patch.managers = body.managers
      .map((m) => ({ name: String(m.name ?? '').trim(), email: String(m.email ?? '').trim() }))
      .filter((m) => m.name || m.email);
    for (const m of patch.managers) {
      if (m.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(m.email)) throw new HttpError(400, `Invalid manager email: ${m.email}`);
    }
  }
  if (body.webhookUrl !== undefined) {
    const u = String(body.webhookUrl).trim();
    if (u && !/^https?:\/\//.test(u)) throw new HttpError(400, 'webhookUrl must start with http:// or https://');
    patch.webhookUrl = u;
  }
  if (body.currency !== undefined) {
    if (!/^[A-Z]{3}$/.test(body.currency)) throw new HttpError(400, 'currency must be a 3-letter ISO code');
    patch.currency = body.currency;
  }
  return patch;
}

export function createServer(app) {
  const routes = [
    ['GET', /^\/api\/meta$/, () => ({
      categories: CATEGORIES,
      paymentMethods: PAYMENT_METHODS,
      statuses: APPROVAL_STATUSES,
      anomalyMultiplier: ANOMALY_MULTIPLIER,
      alertThresholds: BUDGET_ALERT_THRESHOLDS,
      agentMode: app.agent.mode,
      currentMonth: app.currentMonth(),
    })],
    ['GET', /^\/api\/expenses$/, (req, url) => app.listExpenses(Object.fromEntries(url.searchParams))],
    ['POST', /^\/api\/expenses$/, async (req) => [201, await app.submitExpense(await readJson(req))]],
    ['GET', /^\/api\/expenses\/([\w-]+)$/, (req, url, [id]) => {
      const e = app.listExpenses().find((x) => x.id === id);
      if (!e) throw new HttpError(404, 'Expense not found');
      return e;
    }],
    ['PATCH', /^\/api\/expenses\/([\w-]+)$/, async (req, url, [id]) => {
      const e = await app.updateExpense(id, await readJson(req));
      if (!e) throw new HttpError(404, 'Expense not found');
      return e;
    }],
    ['DELETE', /^\/api\/expenses\/([\w-]+)$/, (req, url, [id]) => {
      if (!app.store.deleteExpense(id)) throw new HttpError(404, 'Expense not found');
      return [204, null];
    }],
    ['GET', /^\/api\/ledger$/, (req, url) => app.ledger(monthParam(url, app))],
    ['GET', /^\/api\/dashboard$/, (req, url) => app.dashboard(monthParam(url, app))],
    ['POST', /^\/api\/agent\/categorize$/, async (req) => {
      const body = await readJson(req);
      if (!String(body.vendor ?? '').trim()) throw new HttpError(400, 'vendor is required');
      return app.agent.categorize({
        vendor: String(body.vendor),
        amount: Number(body.amount) || 0,
        date: body.date,
        paymentMethod: body.paymentMethod,
        receiptNotes: String(body.receiptNotes ?? ''),
      });
    }],
    ['GET', /^\/api\/agent\/insights$/, (req, url) => app.agent.insights(monthParam(url, app))],
    ['GET', /^\/api\/settings$/, () => app.store.settings],
    ['PUT', /^\/api\/settings$/, async (req) => app.store.updateSettings(validateSettings(await readJson(req)))],
    ['GET', /^\/api\/notifications$/, (req, url) => app.store.listNotifications(Number(url.searchParams.get('limit')) || 50)],
    ['GET', /^\/api\/reports$/, () => app.store.listReports()],
    ['GET', /^\/api\/reports\/(\d{4}-\d{2})\.html$/, (req, url, [month]) => {
      const html = app.store.readReport(month, 'html');
      if (!html) throw new HttpError(404, 'Report not found');
      return [200, html, 'text/html; charset=utf-8'];
    }],
    ['GET', /^\/api\/reports\/(\d{4}-\d{2})$/, (req, url, [month]) => {
      const json = app.store.readReport(month);
      if (!json) throw new HttpError(404, 'Report not found');
      return JSON.parse(json);
    }],
    ['POST', /^\/api\/automations\/([\w-]+)\/run$/, async (req, url, [job]) => {
      const body = await readJson(req);
      if (body.month && !MONTH_RE.test(body.month)) throw new HttpError(400, 'month must be YYYY-MM');
      try {
        return await app.automations.run(job, body);
      } catch (err) {
        if (err.message.startsWith('Unknown job')) throw new HttpError(404, err.message);
        throw err;
      }
    }],
  ];

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) {
        const pathMatches = routes.filter(([, re]) => re.test(url.pathname));
        if (!pathMatches.length) throw new HttpError(404, 'Not found');
        const route = pathMatches.find(([m]) => m === req.method);
        if (!route) throw new HttpError(405, 'Method not allowed');
        const params = url.pathname.match(route[1]).slice(1);
        const result = await route[2](req, url, params);
        if (Array.isArray(result) && typeof result[0] === 'number') {
          const [status, body, type] = result;
          if (status === 204) { res.writeHead(204); return res.end(); }
          return send(res, status, body, type);
        }
        return send(res, 200, result);
      }

      // Static files
      const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const file = path.resolve(PUBLIC_DIR, rel);
      if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        throw new HttpError(404, 'Not found');
      }
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    } catch (err) {
      if (err instanceof ValidationError) return send(res, 400, { error: 'Validation failed', details: err.errors });
      if (err instanceof HttpError) return send(res, err.status, { error: err.message });
      console.error(err);
      send(res, 500, { error: 'Internal server error' });
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const app = createApp();
  const port = Number(process.env.PORT) || 3000;
  createServer(app).listen(port, () => {
    console.log(`Expense tracker running at http://localhost:${port}`);
    console.log(`Categorization agent: ${app.agent.mode}`);
  });
  if (process.env.DISABLE_SCHEDULER !== '1') app.automations.start();
}
