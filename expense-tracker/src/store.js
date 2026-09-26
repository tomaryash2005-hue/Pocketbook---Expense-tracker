// JSON-file persistence. Everything lives in one document that is rewritten atomically
// (write to a temp file, then rename) after each mutation, so a crash mid-write never
// leaves a half-written database behind.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DEFAULT_BUDGETS } from './constants.js';

function emptyState() {
  return {
    expenses: [],
    settings: {
      budgets: { ...DEFAULT_BUDGETS },
      managers: [],
      webhookUrl: '',
      currency: 'USD',
    },
    notifications: [],
    // Keys of budget alerts already sent, e.g. "2026-09|Travel|0.8", so each fires once.
    alertsSent: [],
    // job name -> period key of the last successful run (see automations.js).
    jobRuns: {},
  };
}

export class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'db.json');
    this.reportsDir = path.join(dataDir, 'reports');
    fs.mkdirSync(this.reportsDir, { recursive: true });
    this.state = this.#load();
  }

  #load() {
    if (!fs.existsSync(this.file)) return emptyState();
    const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    const base = emptyState();
    return {
      ...base,
      ...raw,
      settings: {
        ...base.settings,
        ...raw.settings,
        budgets: { ...base.settings.budgets, ...raw.settings?.budgets },
      },
    };
  }

  save() {
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmp, this.file);
  }

  // --- expenses ---

  listExpenses() {
    return this.state.expenses;
  }

  getExpense(id) {
    return this.state.expenses.find((e) => e.id === id) ?? null;
  }

  addExpense(fields) {
    const now = new Date().toISOString();
    const expense = { id: crypto.randomUUID(), createdAt: now, updatedAt: now, ...fields };
    this.state.expenses.push(expense);
    this.save();
    return expense;
  }

  updateExpense(id, patch) {
    const expense = this.getExpense(id);
    if (!expense) return null;
    Object.assign(expense, patch, { updatedAt: new Date().toISOString() });
    this.save();
    return expense;
  }

  deleteExpense(id) {
    const before = this.state.expenses.length;
    this.state.expenses = this.state.expenses.filter((e) => e.id !== id);
    if (this.state.expenses.length === before) return false;
    this.save();
    return true;
  }

  // --- settings ---

  get settings() {
    return this.state.settings;
  }

  updateSettings(patch) {
    const s = this.state.settings;
    if (patch.budgets) s.budgets = { ...s.budgets, ...patch.budgets };
    if (patch.managers) s.managers = patch.managers;
    if (patch.webhookUrl !== undefined) s.webhookUrl = patch.webhookUrl;
    if (patch.currency) s.currency = patch.currency;
    this.save();
    return s;
  }

  // --- notifications & automation bookkeeping ---

  addNotification(n) {
    const record = { id: crypto.randomUUID(), createdAt: new Date().toISOString(), ...n };
    this.state.notifications.unshift(record);
    this.state.notifications = this.state.notifications.slice(0, 500);
    this.save();
    return record;
  }

  listNotifications(limit = 50) {
    return this.state.notifications.slice(0, limit);
  }

  hasAlert(key) {
    return this.state.alertsSent.includes(key);
  }

  markAlert(key) {
    this.state.alertsSent.push(key);
    this.save();
  }

  lastRun(job) {
    return this.state.jobRuns[job] ?? null;
  }

  markRun(job, periodKey) {
    this.state.jobRuns[job] = periodKey;
    this.save();
  }

  // --- reports ---

  saveReport(month, report, html) {
    fs.writeFileSync(path.join(this.reportsDir, `expense-report-${month}.json`), JSON.stringify(report, null, 2));
    fs.writeFileSync(path.join(this.reportsDir, `expense-report-${month}.html`), html);
  }

  listReports() {
    return fs
      .readdirSync(this.reportsDir)
      .map((f) => f.match(/^expense-report-(\d{4}-\d{2})\.json$/)?.[1])
      .filter(Boolean)
      .sort()
      .reverse();
  }

  readReport(month, ext = 'json') {
    const file = path.join(this.reportsDir, `expense-report-${month}.${ext}`);
    if (!/^\d{4}-\d{2}$/.test(month) || !fs.existsSync(file)) return null;
    return fs.readFileSync(file, 'utf8');
  }
}
