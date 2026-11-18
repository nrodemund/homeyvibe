import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';

export const bridgeDevices = readFileSync(new URL('./fixtures/bridge-devices.json', import.meta.url));

/** Minimal stand-in for an mqtt.js client. */
export class FakeMqttClient extends EventEmitter {
  connected = true;
  subscriptions = [];
  published = [];
  subscribe(topics) {
    this.subscriptions.push(...[].concat(topics));
  }
  publish(topic, payload, cb) {
    this.published.push({ topic, payload });
    cb?.();
  }
  receive(topic, payload) {
    const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload));
    this.emit('message', topic, buf);
  }
}

/**
 * Start an API server with an in-memory auth store and three users.
 * Returns { base, tokens: { admin, member, guest }, auth, close }.
 */
export async function startApi(registry) {
  const { createServer } = await import('node:http');
  const { createApiHandler } = await import('../src/http/api.js');
  const { AuthService } = await import('../src/auth/auth.js');
  const { JsonStore } = await import('../src/store/json-store.js');
  const auth = new AuthService({ store: new JsonStore(null) });
  await auth.setup({ username: 'admin', password: 'admin-pass-1' });
  await auth.createUser({ username: 'member', password: 'member-pass-1', role: 'member' });
  await auth.createUser({ username: 'guest', password: 'guest-pass-1', role: 'guest' });
  const tokens = {
    admin: (await auth.login('admin', 'admin-pass-1')).token,
    member: (await auth.login('member', 'member-pass-1')).token,
    guest: (await auth.login('guest', 'guest-pass-1')).token,
  };
  const server = createServer(createApiHandler({ registry, auth }));
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    tokens,
    auth,
    close() {
      server.closeAllConnections();
      server.close();
    },
  };
}

/** fetch with a bearer token and JSON body. */
export function api(base, token, path, { method = 'GET', body, headers = {}, signal } = {}) {
  return fetch(`${base}${path}`, {
    method,
    signal,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
}
