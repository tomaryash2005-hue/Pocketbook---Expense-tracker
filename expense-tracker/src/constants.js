export const CATEGORIES = [
  'Travel',
  'Meals & Entertainment',
  'Office Supplies',
  'Software & Subscriptions',
  'Equipment',
  'Utilities',
  'Marketing',
  'Professional Services',
  'Training & Education',
  'Other',
];

export const PAYMENT_METHODS = [
  'Corporate Card',
  'Personal Card (Reimbursable)',
  'Cash',
  'Bank Transfer',
  'Check',
];

export const APPROVAL_STATUSES = ['Pending', 'Approved', 'Rejected'];

// Monthly limits used until someone edits them in Settings.
export const DEFAULT_BUDGETS = {
  'Travel': 5000,
  'Meals & Entertainment': 1500,
  'Office Supplies': 800,
  'Software & Subscriptions': 2500,
  'Equipment': 3000,
  'Utilities': 1200,
  'Marketing': 4000,
  'Professional Services': 3500,
  'Training & Education': 1000,
  'Other': 500,
};

// A transaction is "unusual" when it exceeds this multiple of its category average.
export const ANOMALY_MULTIPLIER = 1.5;
// Averages built from fewer transactions than this are too noisy to flag against.
export const ANOMALY_MIN_SAMPLES = 3;
// Managers are notified once a category crosses each of these fractions of its monthly limit.
export const BUDGET_ALERT_THRESHOLDS = [0.8, 1.0];
