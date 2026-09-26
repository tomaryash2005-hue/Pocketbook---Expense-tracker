// Command-line entry points, handy for system cron or a one-off demo:
//   node src/cli.js seed                      load ~2 years of sample expenses
//   node src/cli.js run weekly-summary        send last week's summary now
//   node src/cli.js run budget-check [YYYY-MM]
//   node src/cli.js run monthly-report [YYYY-MM]
//   node src/cli.js tick                      run whatever scheduled jobs are due

import { createApp } from './app.js';
import { seedDemoData } from './seed.js';

const [cmd, arg, extra] = process.argv.slice(2);
const app = createApp();

try {
  if (cmd === 'seed') {
    const n = seedDemoData(app.store, { force: arg === '--force' });
    console.log(n ? `Seeded ${n} expenses into ${app.store.file}` : 'Store already has expenses; use "seed --force" to add sample data anyway.');
  } else if (cmd === 'run') {
    const opts = /^\d{4}-\d{2}$/.test(extra ?? '') ? { month: extra } : undefined;
    const result = await app.automations.run(arg, opts);
    const list = Array.isArray(result) ? result : [result];
    if (arg === 'monthly-report') console.log(`Report written to ${app.store.reportsDir}/expense-report-${result.month}.html`);
    else if (!list.length) console.log('No alerts: every category is under its thresholds or was already alerted.');
    else for (const n of list) console.log(`\n# ${n.title}\n${n.body}`);
  } else if (cmd === 'tick') {
    console.log(`Ran: ${(await app.automations.tick()).join(', ') || 'nothing due'}`);
  } else {
    console.log('Usage: node src/cli.js <seed [--force] | run <weekly-summary|budget-check|monthly-report> [YYYY-MM] | tick>');
    process.exitCode = 1;
  }
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
}
