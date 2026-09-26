import { CATEGORIES, PAYMENT_METHODS, APPROVAL_STATUSES } from './constants.js';

export class ValidationError extends Error {
  constructor(errors) {
    super(errors.join('; '));
    this.errors = errors;
  }
}

const isRealDate = (s) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s);
};

/**
 * Validates and normalizes expense input. With `partial`, only the supplied fields are
 * checked (used for PATCH). An empty/"auto" category is allowed and left for the agent.
 */
export function validateExpense(input, { partial = false } = {}) {
  const errors = [];
  const out = {};
  const has = (k) => input[k] !== undefined;

  if (!partial || has('date')) {
    const date = String(input.date ?? '').trim();
    if (!isRealDate(date)) errors.push('date must be a valid YYYY-MM-DD date');
    else out.date = date;
  }

  if (!partial || has('amount')) {
    const amount = Number(input.amount);
    if (!Number.isFinite(amount) || amount <= 0) errors.push('amount must be a positive number');
    else if (amount > 10_000_000) errors.push('amount is unrealistically large');
    else out.amount = Math.round(amount * 100) / 100;
  }

  if (!partial || has('vendor')) {
    const vendor = String(input.vendor ?? '').trim();
    if (!vendor) errors.push('vendor is required');
    else if (vendor.length > 120) errors.push('vendor must be 120 characters or fewer');
    else out.vendor = vendor;
  }

  if (has('category')) {
    const category = String(input.category ?? '').trim();
    if (category && category.toLowerCase() !== 'auto') {
      if (!CATEGORIES.includes(category)) errors.push(`category must be one of: ${CATEGORIES.join(', ')}`);
      else out.category = category;
    }
  }

  if (!partial || has('paymentMethod')) {
    const pm = String(input.paymentMethod ?? '').trim();
    if (!PAYMENT_METHODS.includes(pm)) errors.push(`paymentMethod must be one of: ${PAYMENT_METHODS.join(', ')}`);
    else out.paymentMethod = pm;
  }

  if (has('receiptNotes')) {
    const notes = String(input.receiptNotes ?? '');
    if (notes.length > 2000) errors.push('receiptNotes must be 2000 characters or fewer');
    else out.receiptNotes = notes.trim();
  } else if (!partial) {
    out.receiptNotes = '';
  }

  if (has('status')) {
    if (!APPROVAL_STATUSES.includes(input.status)) errors.push(`status must be one of: ${APPROVAL_STATUSES.join(', ')}`);
    else out.status = input.status;
  } else if (!partial) {
    out.status = 'Pending';
  }

  if (has('submittedBy')) out.submittedBy = String(input.submittedBy).trim().slice(0, 120);
  if (has('reviewedBy')) out.reviewedBy = String(input.reviewedBy).trim().slice(0, 120);

  if (errors.length) throw new ValidationError(errors);
  return out;
}
