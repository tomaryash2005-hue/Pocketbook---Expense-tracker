// The expense agent: categorizes expenses, compares spending to budget, and flags
// unusual transactions.
//
// Categorization uses Claude when ANTHROPIC_API_KEY (or another Anthropic credential)
// is configured, and falls back to a local classifier otherwise, so the app works
// offline and in tests. The local classifier learns from how each vendor was
// categorized before, then falls back to keyword rules.

import { CATEGORIES } from './constants.js';
import {
  budgetComparison,
  checkAnomaly,
  detectAnomalies,
  monthOf,
  expensesInMonth,
} from './analytics.js';

const DEFAULT_MODEL = 'claude-opus-5';

const KEYWORDS = {
  'Travel': ['airline', 'airlines', 'flight', 'delta', 'united', 'american air', 'southwest', 'jetblue', 'lufthansa', 'emirates', 'hotel', 'marriott', 'hilton', 'hyatt', 'airbnb', 'uber', 'lyft', 'taxi', 'cab', 'amtrak', 'train', 'rail', 'hertz', 'avis', 'enterprise rent', 'rental car', 'parking', 'toll', 'expedia', 'booking.com', 'mileage', 'fuel', 'gas station', 'shell', 'chevron', 'exxon'],
  'Meals & Entertainment': ['restaurant', 'cafe', 'coffee', 'starbucks', 'lunch', 'dinner', 'breakfast', 'catering', 'doordash', 'grubhub', 'uber eats', 'ubereats', 'pizza', 'bar ', 'grill', 'bistro', 'diner', 'client meal', 'team meal', 'sweetgreen', 'chipotle'],
  'Office Supplies': ['staples', 'office depot', 'officemax', 'paper', 'toner', 'ink', 'pens', 'stationery', 'notebook', 'supplies', 'post-it', 'binder', 'printer paper'],
  'Software & Subscriptions': ['software', 'subscription', 'saas', 'license', 'github', 'atlassian', 'jira', 'slack', 'zoom', 'google workspace', 'microsoft 365', 'office 365', 'adobe', 'figma', 'notion', 'aws', 'amazon web services', 'azure', 'gcp', 'google cloud', 'heroku', 'vercel', 'dropbox', 'salesforce', 'hubspot', 'openai', 'anthropic', 'datadog', 'annual plan', 'monthly plan'],
  'Equipment': ['laptop', 'monitor', 'macbook', 'dell', 'lenovo', 'apple store', 'best buy', 'keyboard', 'mouse', 'headset', 'webcam', 'desk', 'chair', 'hardware', 'server', 'ipad', 'iphone', 'phone'],
  'Utilities': ['electric', 'electricity', 'water', 'gas bill', 'internet', 'comcast', 'verizon', 'at&t', 't-mobile', 'utility', 'utilities', 'power', 'broadband', 'phone bill', 'wireless'],
  'Marketing': ['advertising', 'ads', 'google ads', 'facebook ads', 'meta ads', 'linkedin ads', 'marketing', 'promotion', 'sponsorship', 'billboard', 'print ad', 'campaign', 'swag', 'trade show', 'booth', 'mailchimp', 'seo'],
  'Professional Services': ['consulting', 'consultant', 'legal', 'attorney', 'lawyer', 'law firm', 'accounting', 'accountant', 'cpa', 'audit', 'contractor', 'freelance', 'upwork', 'fiverr', 'agency', 'advisory', 'recruiting'],
  'Training & Education': ['course', 'training', 'workshop', 'seminar', 'conference', 'certification', 'udemy', 'coursera', 'pluralsight', 'o\'reilly', 'book', 'books', 'tuition', 'webinar', 'bootcamp'],
};

const normalizeVendor = (v) => v.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Local, deterministic categorizer used when Claude is unavailable. */
export function heuristicCategorize({ vendor = '', receiptNotes = '' }, history = []) {
  const key = normalizeVendor(vendor);

  // 1. Vendor history: reuse the category this vendor was filed under most often.
  if (key) {
    const counts = {};
    for (const e of history) {
      if (e.category && normalizeVendor(e.vendor) === key) counts[e.category] = (counts[e.category] ?? 0) + 1;
    }
    const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    if (best) {
      const total = Object.values(counts).reduce((s, n) => s + n, 0);
      return {
        category: best[0],
        confidence: Math.round(Math.min(0.95, 0.6 + 0.35 * (best[1] / total)) * 100) / 100,
        source: 'history',
        reasoning: `${vendor} was filed under ${best[0]} in ${best[1]} of ${total} previous expense(s).`,
      };
    }
  }

  // 2. Keyword rules over vendor + notes; vendor matches weigh double.
  const vendorText = ` ${vendor.toLowerCase()} `;
  const notesText = ` ${receiptNotes.toLowerCase()} `;
  let best = null;
  for (const [category, words] of Object.entries(KEYWORDS)) {
    let score = 0;
    const hits = [];
    for (const w of words) {
      if (vendorText.includes(w)) { score += 2; hits.push(w); }
      else if (notesText.includes(w)) { score += 1; hits.push(w); }
    }
    if (score > 0 && (!best || score > best.score)) best = { category, score, hits };
  }
  if (best) {
    return {
      category: best.category,
      confidence: Math.round(Math.min(0.9, 0.45 + 0.15 * best.score) * 100) / 100,
      source: 'rules',
      reasoning: `Matched keyword(s): ${best.hits.slice(0, 4).join(', ')}.`,
    };
  }

  return { category: 'Other', confidence: 0.2, source: 'rules', reasoning: 'No vendor history or keyword match.' };
}

const CATEGORY_SCHEMA = {
  type: 'object',
  properties: {
    category: { type: 'string', enum: CATEGORIES },
    confidence: { type: 'number' },
    reasoning: { type: 'string' },
  },
  required: ['category', 'confidence', 'reasoning'],
  additionalProperties: false,
};

const SYSTEM_PROMPT = `You categorize business expenses for an expense tracking system.
Pick exactly one category from the allowed list based on the vendor, amount, payment method and receipt notes.
Prefer how the company has categorized the same or similar vendors before, when examples are given.
confidence is a number from 0 to 1. reasoning is one short sentence a finance reviewer can read.`;

export class ExpenseAgent {
  /**
   * @param {object} opts
   * @param {import('./store.js').Store} opts.store
   * @param {object} [opts.client] an Anthropic client; created lazily from env when omitted
   * @param {boolean} [opts.useClaude] force Claude on/off (defaults to "credentials present")
   */
  constructor({ store, client = null, useClaude, model } = {}) {
    this.store = store;
    this.client = client;
    this.model = model ?? process.env.EXPENSE_AGENT_MODEL ?? DEFAULT_MODEL;
    this.useClaude = useClaude ?? Boolean(client || process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
  }

  get mode() {
    return this.useClaude ? `claude (${this.model})` : 'local rules';
  }

  async #getClient() {
    if (!this.client) {
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      this.client = new Anthropic();
    }
    return this.client;
  }

  #examples(history) {
    // A few recent, distinct vendor->category pairs give Claude the company's conventions.
    const seen = new Set();
    const out = [];
    for (const e of [...history].reverse()) {
      const key = normalizeVendor(e.vendor);
      if (!e.category || seen.has(key)) continue;
      seen.add(key);
      out.push(`- ${e.vendor} -> ${e.category}`);
      if (out.length >= 25) break;
    }
    return out.join('\n');
  }

  async #categorizeWithClaude(expense, history) {
    const client = await this.#getClient();
    const examples = this.#examples(history);
    const content = [
      `Allowed categories: ${CATEGORIES.join(', ')}`,
      examples ? `Past categorizations:\n${examples}` : '',
      'Expense to categorize:',
      JSON.stringify({
        vendor: expense.vendor,
        amount: expense.amount,
        date: expense.date,
        paymentMethod: expense.paymentMethod,
        receiptNotes: expense.receiptNotes,
      }),
    ].filter(Boolean).join('\n\n');

    const response = await client.beta.messages.create({
      model: this.model,
      max_tokens: 1024,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: {
        effort: 'low',
        format: { type: 'json_schema', schema: CATEGORY_SCHEMA },
      },
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content }],
    });

    if (response.stop_reason === 'refusal') throw new Error('Claude declined to categorize this expense');
    const text = response.content.find((b) => b.type === 'text')?.text;
    if (!text) throw new Error('Claude returned no categorization');
    const parsed = JSON.parse(text);
    if (!CATEGORIES.includes(parsed.category)) throw new Error(`Unknown category from Claude: ${parsed.category}`);
    return {
      category: parsed.category,
      confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0)),
      source: 'claude',
      reasoning: parsed.reasoning,
    };
  }

  /** Suggests a category. Never throws: Claude errors degrade to the local classifier. */
  async categorize(expense) {
    const history = this.store.listExpenses().filter((e) => e.id !== expense.id);
    if (this.useClaude) {
      try {
        return await this.#categorizeWithClaude(expense, history);
      } catch (err) {
        const fallback = heuristicCategorize(expense, history);
        return { ...fallback, reasoning: `${fallback.reasoning} (Claude unavailable: ${err.message})` };
      }
    }
    return heuristicCategorize(expense, history);
  }

  /**
   * Full review of an incoming expense: fills the category when missing, checks the
   * category's budget for the expense's month, and tests the amount against the
   * category average.
   */
  async review(expense) {
    const existing = this.store.listExpenses();
    const suggestion = await this.categorize(expense);
    const category = expense.category ?? suggestion.category;
    const reviewed = { ...expense, category };

    const anomaly = checkAnomaly(reviewed, existing);
    const month = monthOf(reviewed.date);
    const afterSubmit = budgetComparison(
      [...existing.filter((e) => e.id !== reviewed.id), { ...reviewed, status: reviewed.status ?? 'Pending' }],
      this.store.settings.budgets,
      month,
    ).categories.find((c) => c.category === category);

    return {
      category,
      categorization: { ...suggestion, applied: expense.category == null, agreesWithSubmitter: expense.category == null ? null : expense.category === suggestion.category },
      anomaly,
      budget: afterSubmit,
    };
  }

  /** Budget comparison plus anomalies and plain-language observations for a month. */
  insights(month) {
    const expenses = this.store.listExpenses();
    const budget = budgetComparison(expenses, this.store.settings.budgets, month);
    const anomalies = detectAnomalies(expenses);
    const flagged = expensesInMonth(expenses, month)
      .filter((e) => anomalies.has(e.id))
      .map((e) => ({ id: e.id, date: e.date, vendor: e.vendor, category: e.category, amount: e.amount, ...anomalies.get(e.id) }))
      .sort((a, b) => b.ratio - a.ratio);

    const observations = [];
    for (const c of budget.categories) {
      if (c.status === 'over') observations.push(`${c.category} is over budget: ${c.pct}% of its monthly limit used.`);
      else if (c.status === 'warning') observations.push(`${c.category} has used ${c.pct}% of its monthly limit.`);
    }
    for (const f of flagged.slice(0, 5)) {
      observations.push(`${f.vendor} (${f.date}) is ${f.ratio}x the ${f.category} average of ${f.average.toFixed(2)}.`);
    }
    if (!observations.length) observations.push('All categories are within budget and no unusual transactions were found.');

    return { month, mode: this.mode, budget, flagged, observations };
  }
}
