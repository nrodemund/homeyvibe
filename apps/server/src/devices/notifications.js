import { createHash } from 'node:crypto';
import webPush from 'web-push';
import { HttpError } from '../http/errors.js';

const hash = (token) => createHash('sha256').update(token).digest('hex');
const knownHosts = ['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com'];

/** Send encrypted browser pushes after a live, visible device event. */
export class DeviceNotifications {
  #sends = new Set();
  #recent = new Map();

  constructor({ store, auth, access, registry, push = webPush, now = Date.now }) {
    this.store = store;
    this.auth = auth;
    this.access = access;
    this.now = now;
    this.push = push;
    this.keys = store.read('notification-keys', null);
    if (!this.keys) {
      this.keys = push.generateVAPIDKeys();
      store.write('notification-keys', this.keys);
    }
    registry.on('activity', (device, event) => this.send(device, event));
  }

  get(token) {
    const id = hash(token);
    const prefs = this.store.read('subscriptions', []).find((item) => item.session === id);
    return { enabled: Boolean(prefs), all: prefs?.all ?? true, devices: prefs?.devices ?? [],
      readings: prefs?.readings === true, publicKey: this.keys.publicKey };
  }

  update(token, user, body) {
    if (typeof body.all !== 'boolean' || (body.readings !== undefined && typeof body.readings !== 'boolean') ||
      !Array.isArray(body.devices) || body.devices.length > 500 ||
      !body.devices.every((id) => typeof id === 'string' && id.length <= 200 && this.access.policyFor(user).canSee(id))) {
      throw new HttpError(400, 'Choose all devices or a list of visible devices');
    }
    const { endpoint, keys } = body.subscription ?? {};
    let url;
    try { url = new URL(endpoint); } catch { throw new HttpError(400, 'Invalid browser notification subscription'); }
    const allowed = knownHosts.includes(url.hostname) || url.hostname.endsWith('.push.apple.com') ||
      url.hostname.endsWith('.notify.windows.com');
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !allowed || url.href.length > 2048 ||
      !/^[\w-]{22}$/.test(keys?.auth) || !/^[\w-]{87}$/.test(keys?.p256dh)) {
      throw new HttpError(400, 'This browser notification subscription is unsupported');
    }
    const entries = this.store.read('subscriptions', []).filter((entry) => entry.subscription.endpoint !== url.href);
    const session = hash(token);
    const next = entries.filter((entry) => entry.session !== session && this.auth.activeSession(entry.session));
    if (next.length >= 64) throw new HttpError(409, 'Too many devices are subscribed for notifications');
    next.push({ session, userId: user.id, all: body.all, devices: [...new Set(body.devices)], readings: body.readings === true,
      subscription: { endpoint: url.href, keys: { auth: keys.auth, p256dh: keys.p256dh } } });
    this.store.write('subscriptions', next);
    return this.get(token);
  }

  removeSession(token) {
    if (!token) return;
    const entries = this.store.read('subscriptions', []);
    const next = entries.filter((entry) => entry.session !== hash(token));
    if (next.length !== entries.length) this.store.write('subscriptions', next);
  }

  send(device, event) {
    const entries = this.store.read('subscriptions', []);
    const now = this.now();
    for (const entry of entries) {
      if (this.#sends.size >= 32) break;
      const user = this.auth.getUser(entry.userId);
      if (!user || !this.auth.activeSession(entry.session) || !this.access.policyFor(user).canSee(device.id) ||
        (!entry.all && !entry.devices.includes(device.id)) || (event.kind === 'reading' && !entry.readings)) continue;
      const key = JSON.stringify([entry.session, device.id, event.kind, event.property]);
      if ((this.#recent.get(key) ?? -Infinity) + (event.kind === 'reading' ? 300_000 : 5000) > now) continue;
      this.#recent.set(key, now);
      if (this.#recent.size > 2048) this.#recent.delete(this.#recent.keys().next().value);
      const body = event.kind === 'command' ? 'Device command sent'
        : `${event.property.replaceAll('_', ' ')} · ${String(event.value).slice(0, 80)}`;
      const pending = this.push.sendNotification(entry.subscription, JSON.stringify({ title: device.name, body }), {
        TTL: 30, timeout: 5000,
        vapidDetails: { ...this.keys, subject: process.env.HOMEYVIBE_PUSH_SUBJECT ?? 'https://github.com/nrodemund/homeyvibe' },
      }).catch((err) => {
        if (![404, 410].includes(err.statusCode)) return;
        const active = this.store.read('subscriptions', []);
        this.store.write('subscriptions', active.filter((item) =>
          item.session !== entry.session || item.subscription.endpoint !== entry.subscription.endpoint));
      }).finally(() => this.#sends.delete(pending));
      this.#sends.add(pending);
    }
  }
}
