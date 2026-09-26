// Delivers notifications. Every notification is recorded in the in-app notification
// feed (the outbox); when a webhook URL is configured (Settings or NOTIFY_WEBHOOK_URL)
// it is also POSTed there as JSON with a Slack-compatible `text` field, so it can go
// straight to a Slack/Teams incoming webhook or to an email relay such as Zapier.

export class Notifier {
  constructor({ store, fetchImpl = globalThis.fetch, logger = console } = {}) {
    this.store = store;
    this.fetch = fetchImpl;
    this.logger = logger;
  }

  get webhookUrl() {
    return process.env.NOTIFY_WEBHOOK_URL || this.store.settings.webhookUrl || '';
  }

  /**
   * @param {object} n
   * @param {string} n.type        e.g. 'weekly-summary', 'budget-alert', 'monthly-report', 'unusual-transaction'
   * @param {string} n.title
   * @param {string} n.body        plain-text message
   * @param {'managers'|'team'} [n.audience]
   * @param {object} [n.data]      structured payload for integrations
   */
  async send({ type, title, body, audience = 'managers', data = {} }) {
    const recipients = this.store.settings.managers.map((m) => m.email).filter(Boolean);
    const delivery = { channel: 'in-app', webhook: null };

    const url = this.webhookUrl;
    if (url) {
      try {
        const res = await this.fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: `*${title}*\n${body}`, type, title, body, recipients, data }),
        });
        delivery.webhook = res.ok ? 'delivered' : `failed (HTTP ${res.status})`;
      } catch (err) {
        delivery.webhook = `failed (${err.message})`;
      }
      if (delivery.webhook !== 'delivered') this.logger.warn(`[notify] webhook ${delivery.webhook} for "${title}"`);
    }

    return this.store.addNotification({ type, title, body, audience, recipients, delivery, data });
  }
}
