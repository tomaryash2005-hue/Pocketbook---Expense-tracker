# Pocketbook

Two expense trackers in one repository.

**Use Pocketbook online:** https://tomaryash2005-hue.github.io/Pocketbook---Expense-tracker/

On a phone it installs like an app: in Chrome use ⋮ → **Install app** (or **Add to Home screen**), and on iPhone use Share → **Add to Home Screen**. It gets its own icon, opens full-screen, and works offline.

| Folder | What it is | How to run it |
|---|---|---|
| [`pocketbook/`](pocketbook/) | A personal expense tracker for your phone or computer. It's a single web page with no build step and no server. | Open `pocketbook/index.html` in a browser, or host the folder anywhere (GitHub Pages works). |
| [`expense-tracker/`](expense-tracker/) | A team expense tracker. It has a submission form, a category ledger, a budget dashboard, an AI agent that categorizes expenses, and scheduled weekly summaries, budget alerts and month-end reports. | `cd expense-tracker && npm install && npm start`. See its [README](expense-tracker/README.md). |

## Pocketbook

- Log an expense with its amount, place, date, category, payment method and notes. If you leave the category on Auto, it's picked from places you've used before or from keywords.
- Set a monthly budget for each category. Categories past 80% of their budget, and any spend over 150% of that category's average, are flagged.
- See the month's spending by category in a donut chart. Your six biggest categories keep the same colour every month.
- See how much you can spend per day for the rest of the month, this week compared with last week, and the last 12 months compared with the year before.
- Each month has a report that compares every category with the previous month and the same month last year.
- Export a month's expenses as CSV.

When you open `index.html` directly (or on GitHub Pages), expenses are saved in that browser's local storage.

- **Sync across devices:** on the Sync tab, paste a GitHub token that has only the `gist` permission. Pocketbook keeps your data in a secret gist named `pocketbook-data.json` on your GitHub account. Paste the same token on each device and they share one copy of the data. Edits and deletions merge by time, so the newest change to an expense wins. The token stays in that browser.
- **Backup file:** the Sync tab can also download everything as a JSON file and restore from one. Restoring merges with what's already there and never deletes anything. The same page also runs as a Claude artifact. There, expenses sync to your Claude account, and an "Ask Claude" button can suggest a category.

Until you add your first expense, the page shows example data so the charts aren't empty. The examples are labelled and disappear as soon as you save a real expense.
