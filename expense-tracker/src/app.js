// Wires the store, agent, notifier and automations together and implements the
// expense workflows the HTTP API and CLI share.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.js';
import { ExpenseAgent } from './agent.js';
import { Notifier } from './notifier.js';
import { Automations } from './automations.js';
import { validateExpense } from './validation.js';
import {
  budgetComparison,
  detectAnomalies,
  monthOf,
  monthlyTrend,
  toISODate,
} from './analytics.js';
import { CATEGORIES } from './constants.js';

export const DEFAULT_DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');

export function createApp({
  dataDir = process.env.EXPENSE_DATA_DIR || DEFAULT_DATA_DIR,
  agentOptions = {},
  fetchImpl,
  now,
  logger = console,
} = {}) {
  const store = new Store(dataDir);
  const agent = new ExpenseAgent({ store, ...agentOptions });
  const notifier = new Notifier({ store, fetchImpl, logger });
  const automations = new Automations({ store, notifier, now });

  function withFlags(expenses) {
    const anomalies = detectAnomalies(store.listExpenses());
    return expenses.map((e) => ({ ...e, unusual: anomalies.get(e.id) ?? null }));
  }

  async function submitExpense(input) {
    const fields = validateExpense(input);
    const review = await agent.review(fields);
    const expense = store.addExpense({
      ...fields,
      category: review.category,
      aiCategorization: review.categorization,
    });
    const events = [];
    if (review.anomaly) events.push(await automations.unusualTransaction(expense, review.anomaly));
    events.push(...(await automations.checkBudgets([monthOf(expense.date)])));
    return { expense: withFlags([expense])[0], review, notifications: events };
  }

  async function updateExpense(id, input) {
    const before = store.getExpense(id);
    if (!before) return null;
    const patch = validateExpense(input, { partial: true });
    // Clearing the category (or sending "auto") asks the agent to re-categorize.
    if (input.category !== undefined && !patch.category) {
      const suggestion = await agent.categorize({ ...before, ...patch });
      patch.category = suggestion.category;
      patch.aiCategorization = { ...suggestion, applied: true, agreesWithSubmitter: null };
    }
    if (patch.status && patch.status !== before.status) patch.reviewedAt = new Date().toISOString();
    const beforeMonth = monthOf(before.date);
    const expense = store.updateExpense(id, patch);
    await automations.checkBudgets([beforeMonth, monthOf(expense.date)]);
    return withFlags([expense])[0];
  }

  function listExpenses({ month, category, status, flagged } = {}) {
    let list = store.listExpenses();
    if (month) list = list.filter((e) => monthOf(e.date) === month);
    if (category) list = list.filter((e) => e.category === category);
    if (status) list = list.filter((e) => e.status === status);
    list = withFlags(list);
    if (flagged === 'true') list = list.filter((e) => e.unusual);
    return list.sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
  }

  /** Category-based ledger: expenses grouped by category with subtotals and budget. */
  function ledger(month) {
    const expenses = listExpenses({ month });
    const budget = budgetComparison(store.listExpenses(), store.settings.budgets, month);
    const groups = CATEGORIES.map((category) => {
      const items = expenses.filter((e) => e.category === category);
      const b = budget.categories.find((c) => c.category === category);
      return {
        category,
        items,
        subtotal: b.spent,
        rejectedTotal: Math.round(items.filter((e) => e.status === 'Rejected').reduce((s, e) => s + e.amount, 0) * 100) / 100,
        limit: b.limit,
        pct: b.pct,
        status: b.status,
      };
    }).filter((g) => g.items.length);
    return { month, groups, totals: budget.totals };
  }

  function dashboard(month) {
    const insights = agent.insights(month);
    const inMonth = listExpenses({ month });
    return {
      ...insights,
      trend: monthlyTrend(store.listExpenses(), month, 12),
      pendingApprovals: inMonth.filter((e) => e.status === 'Pending').length,
      byPaymentMethod: Object.entries(
        inMonth
          .filter((e) => e.status !== 'Rejected')
          .reduce((acc, e) => ({ ...acc, [e.paymentMethod]: (acc[e.paymentMethod] ?? 0) + e.amount }), {}),
      ).map(([method, total]) => ({ method, total: Math.round(total * 100) / 100 })),
      recentNotifications: store.listNotifications(5),
    };
  }

  return {
    store,
    agent,
    notifier,
    automations,
    submitExpense,
    updateExpense,
    listExpenses,
    ledger,
    dashboard,
    currentMonth: () => monthOf(toISODate(now ? now() : new Date())),
  };
}
