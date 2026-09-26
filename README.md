# Pocketbook

Two expense trackers in one repository.

**Use Pocketbook online:** https://tomaryash2005-hue.github.io/Pocketbook---Expense-tracker/

| Folder | What it is | How to run it |
|---|---|---|
| [`pocketbook/`](pocketbook/) | A personal expense tracker for your phone or computer. It's a single web page with no build step and no server. | Open `pocketbook/index.html` in a browser, or host the folder anywhere (GitHub Pages works). |
| [`expense-tracker/`](expense-tracker/) | A team expense tracker. It has a submission form, a category ledger, a budget dashboard, an AI agent that categorizes expenses, and scheduled weekly summaries, budget alerts and month-end reports. | `cd expense-tracker && npm install && npm start`. See its [README](expense-tracker/README.md). |

## Pocketbook

- Log an expense with its amount, place, date, category, payment method and notes. If you leave the category on Auto, it's picked from places you've used before or from keywords.
- Set a monthly budget for each category. Categories past 80% of their budget, and any spend over 150% of that category's average, are flagged.
- See how much you can spend per day for the rest of the month, this week compared with last week, and the last 12 months compared with the year before.
- Each month has a report that compares every category with the previous month and the same month last year.
- Export a month's expenses as CSV.

When you open `index.html` directly, expenses are saved in that browser's local storage, so they stay on that device and in that browser. The same page also runs as a Claude artifact. There, expenses sync to your Claude account, and an "Ask Claude" button can suggest a category.

Until you add your first expense, the page shows example data so the charts aren't empty. The examples are labelled and disappear as soon as you save a real expense.
