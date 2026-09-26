# Expense Tracker

An expense tracking system with a submission form, a category-based ledger, a monthly budget dashboard, an AI agent that categorizes expenses and flags unusual spending, and scheduled automations for summaries, budget alerts and month-end reports.

It is a single Node.js app (Node 20+). The only dependency is the Anthropic SDK, and the app still runs without an API key.

```bash
cd expense-tracker
npm install
npm run seed      # optional: loads about 2 years of sample expenses
npm start         # http://localhost:3000
npm test
```

## Features

| Area | What it does |
|---|---|
| **Submission form** | Date, amount, vendor, category, payment method, receipt notes, approval status and submitter. You can leave the category on **Auto** for the agent to pick, or click **Ask agent** to see its suggestion before submitting. |
| **Ledger** | Expenses for a month, grouped by category. Each group shows its subtotal against the monthly limit. You can filter by status or show only unusual expenses, and you can approve, reject, re-categorize or delete an expense inline. |
| **Dashboard** | KPI tiles, a budget-vs-spend meter for each category (80% warning, 100% over), the agent's insights, the list of unusual transactions, a 12-month trend against the prior year, and spend by payment method. |
| **Notifications & Reports** | Every notification sent, links to the generated monthly reports, and buttons to run each automation now. |
| **Settings** | Monthly limit for each category, the managers who get alerts, and a webhook URL. |

### The AI agent (`src/agent.js`)

- **Categorization.** When `ANTHROPIC_API_KEY` is set, the agent asks Claude (`claude-opus-5`, low effort, JSON-schema structured output) to pick one of the allowed categories. The prompt includes the company's recent vendor-to-category history so Claude follows existing conventions. Without a key, or if the API call fails, a local classifier takes over. It first reuses the category the same vendor was filed under before, then falls back to keyword rules. Every result stores its category, confidence, source (`claude`, `history` or `rules`) and a one-line reason, and the ledger shows these.
- **Budget comparison.** For each category it compares the month's spend with the limit and gives the percentage used, the amount remaining and a status. Rejected expenses are not counted. Pending and approved expenses are counted, so alerts fire before approval.
- **Unusual transactions.** An expense is flagged when its amount is **more than 150%** of the average of the *other* non-rejected expenses in the same category. The expense being checked is left out of its own average so one very large charge can't raise the average enough to hide itself. At least 3 other expenses are needed before anything is flagged. Flagged expenses are marked in the ledger and on the dashboard, and managers are notified when one is submitted.

Set `EXPENSE_AGENT_MODEL` to use a different Claude model.

### Automations (`src/automations.js`)

| Job | When | Who |
|---|---|---|
| `weekly-summary` | Every Monday at 09:00 (server local time), covering the previous Monday to Sunday | Team |
| `budget-check` | After every submission or edit, plus hourly. Alerts **once** per category per month at **80%** and again at **100%** of the monthly limit | Managers |
| `unusual-transaction` | As soon as a flagged expense is submitted | Managers |
| `monthly-report` | On the 1st at 06:00, for the month that just ended. Includes month-over-month, **year-over-year** (same month last year) and year-to-date comparisons by category. Saved as HTML and JSON in `data/reports/` | Managers |

The scheduler runs inside the server process and checks once a minute. Each job records the week or month it last covered. A restart therefore never sends a job twice, and a server that was down catches up on the most recent missed period. To use system cron instead, set `DISABLE_SCHEDULER=1` and run these commands:

```bash
npm run job -- weekly-summary
npm run job -- budget-check [YYYY-MM]
npm run job -- monthly-report [YYYY-MM]
node src/cli.js tick           # run whatever is due
```

**Delivery.** Every notification is recorded in the in-app feed. If a webhook URL is set (in Settings or with `NOTIFY_WEBHOOK_URL`), each notification is also POSTed there as JSON: `{ text, type, title, body, recipients, data }`. The `text` field makes it work directly with Slack or Teams incoming webhooks. To get email, point the webhook at an email relay such as Zapier or Make, or at your own mail service. `recipients` holds the email addresses of the managers configured in Settings. The app does not send email over SMTP itself.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `ANTHROPIC_API_KEY` | unset | Turns on Claude categorization |
| `EXPENSE_AGENT_MODEL` | `claude-opus-5` | Claude model used for categorization |
| `EXPENSE_DATA_DIR` | `./data` | Location of the JSON database and reports |
| `NOTIFY_WEBHOOK_URL` | unset | Webhook for notifications; overrides the Settings value |
| `DISABLE_SCHEDULER` | unset | Set to `1` to run the jobs from external cron |

Data is kept in `data/db.json`, which is written atomically after each change. This file is ignored by git.

## API

| Method & path | Purpose |
|---|---|
| `GET /api/meta` | Categories, payment methods, statuses and agent mode |
| `GET /api/expenses?month=&category=&status=&flagged=true` | List expenses, each with an `unusual` flag |
| `POST /api/expenses` | Submit an expense (omit `category` or send `"auto"` to let the agent choose) |
| `PATCH /api/expenses/:id` | Edit, approve or reject (`{"category":"auto"}` re-runs the agent) |
| `DELETE /api/expenses/:id` | Delete an expense |
| `GET /api/ledger?month=` | Expenses grouped by category with subtotals and budget |
| `GET /api/dashboard?month=` | Budget comparison, insights, trend, payment mix |
| `POST /api/agent/categorize` | Suggest a category without saving |
| `GET /api/agent/insights?month=` | Budget comparison, anomalies and observations |
| `GET/PUT /api/settings` | Budgets, managers, webhook |
| `GET /api/notifications` | Notification feed |
| `GET /api/reports`, `GET /api/reports/:month`, `GET /api/reports/:month.html` | Monthly reports |
| `POST /api/automations/:job/run` | Run `weekly-summary`, `budget-check` or `monthly-report` (body: `{ "month": "YYYY-MM" }`) |

## Layout

```
src/
  server.js       HTTP API + static files
  app.js          wires everything together; submission/update workflows
  agent.js        categorization (Claude + local fallback), insights
  analytics.js    budget comparison, anomaly detection, summaries, YoY reports
  automations.js  scheduled jobs, budget alerts, report rendering
  notifier.js     in-app feed + webhook delivery
  store.js        JSON-file persistence
  validation.js   input validation
  seed.js, cli.js sample data and command-line jobs
public/           single-page UI (no build step)
test/             node:test suites
```

The app has no login. Anyone who can reach it can approve expenses and change budgets, so put it behind your own authentication (for example a reverse proxy with SSO) before exposing it beyond a trusted network.
