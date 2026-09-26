// Deterministic sample data: ~2 years of expenses ending in the current month, so the
// dashboard, year-over-year comparisons and anomaly detection have something to show.

import { toISODate } from './analytics.js';

const VENDORS = {
  'Travel': [['Delta Air Lines', 250, 650, 'Client visit flight'], ['Marriott', 180, 420, 'Hotel, 2 nights'], ['Uber', 18, 60, 'Airport ride']],
  'Meals & Entertainment': [['Starbucks', 8, 30, 'Team coffee'], ['Sweetgreen', 40, 120, 'Team lunch'], ['The Capital Grille', 150, 320, 'Client dinner']],
  'Office Supplies': [['Staples', 25, 140, 'Printer paper and toner'], ['Office Depot', 20, 90, 'Notebooks and pens']],
  'Software & Subscriptions': [['GitHub', 210, 210, 'Team plan, monthly'], ['Figma', 90, 90, 'Design seats'], ['AWS', 380, 900, 'Cloud hosting']],
  'Equipment': [['Best Buy', 60, 300, 'Monitor cables and headset'], ['Apple Store', 1200, 2100, 'Laptop for new hire']],
  'Utilities': [['Comcast Business', 180, 180, 'Office internet'], ['City Electric', 220, 380, 'Office electricity']],
  'Marketing': [['Google Ads', 600, 1400, 'Search campaign'], ['Mailchimp', 120, 120, 'Newsletter plan']],
  'Professional Services': [['Baker & Lee LLP', 900, 1800, 'Contract review'], ['Upwork', 300, 900, 'Freelance design work']],
  'Training & Education': [['Udemy', 15, 90, 'Course'], ['O\'Reilly Media', 49, 49, 'Learning platform subscription']],
  'Other': [['USPS', 10, 60, 'Shipping'], ['Local Florist', 40, 90, 'Office flowers']],
};
const METHODS = ['Corporate Card', 'Corporate Card', 'Corporate Card', 'Personal Card (Reimbursable)', 'Bank Transfer', 'Cash'];
const PEOPLE = ['Alex Kim', 'Priya Shah', 'Jordan Lee', 'Sam Rivera'];

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

export function seedDemoData(store, { force = false, now = new Date(), months = 24 } = {}) {
  if (store.listExpenses().length && !force) return 0;
  const rand = rng(20260214);
  const pickFrom = (arr) => arr[Math.floor(rand() * arr.length)];
  const today = toISODate(now);
  const expenses = [];

  for (let back = months - 1; back >= 0; back--) {
    const monthStart = new Date(now.getFullYear(), now.getMonth() - back, 1);
    const daysInMonth = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 0).getDate();
    // Spending grows ~8% year over year so YoY comparisons have a visible trend.
    const growth = 1 + 0.08 * ((months - back) / 12);
    for (const [category, vendors] of Object.entries(VENDORS)) {
      const perMonth = category === 'Equipment' || category === 'Professional Services' ? (rand() < 0.5 ? 1 : 0) : 1 + Math.floor(rand() * 3);
      for (let i = 0; i < perMonth; i++) {
        const [vendor, lo, hi, note] = pickFrom(vendors);
        const date = toISODate(new Date(monthStart.getFullYear(), monthStart.getMonth(), 1 + Math.floor(rand() * daysInMonth)));
        if (date > today) continue;
        const amount = Math.round((lo + rand() * (hi - lo)) * growth * 100) / 100;
        expenses.push({ date, amount, category, vendor, note });
      }
    }
  }

  // A few deliberate outliers so anomaly detection has something to flag.
  const recent = (daysAgo) => toISODate(new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo));
  expenses.push(
    { date: recent(3), amount: 2890, category: 'Meals & Entertainment', vendor: 'The Capital Grille', note: 'Offsite dinner, 18 guests' },
    { date: recent(6), amount: 3150, category: 'Travel', vendor: 'Emirates', note: 'Business class, conference' },
    { date: recent(40), amount: 740, category: 'Office Supplies', vendor: 'Staples', note: 'Bulk toner order' },
  );

  for (const e of expenses) {
    const ageDays = (now - new Date(`${e.date}T12:00:00`)) / 86400000;
    const status = ageDays < 10 ? 'Pending' : rand() < 0.04 ? 'Rejected' : 'Approved';
    store.state.expenses.push({
      id: crypto.randomUUID(),
      createdAt: new Date(`${e.date}T12:00:00`).toISOString(),
      updatedAt: new Date(`${e.date}T12:00:00`).toISOString(),
      date: e.date,
      amount: e.amount,
      category: e.category,
      vendor: e.vendor,
      paymentMethod: pickFrom(METHODS),
      receiptNotes: e.note,
      status,
      submittedBy: pickFrom(PEOPLE),
      ...(status !== 'Pending' ? { reviewedBy: 'Finance', reviewedAt: new Date(`${e.date}T12:00:00`).toISOString() } : {}),
      aiCategorization: { category: e.category, confidence: 0.9, source: 'seed', reasoning: 'Sample data', applied: false, agreesWithSubmitter: true },
    });
  }
  if (!store.settings.managers.length) {
    store.settings.managers = [{ name: 'Finance Manager', email: 'finance@example.com' }];
  }
  store.save();
  return expenses.length;
}
