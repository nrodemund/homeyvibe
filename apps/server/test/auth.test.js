import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { DeviceRegistry } from '../src/devices/registry.js';
import { createDemoProvider } from '../src/providers/demo/index.js';
import { createApiHandler } from '../src/http/api.js';
import { AuthService } from '../src/auth/auth.js';
import { JsonStore } from '../src/store/json-store.js';
import { startApi, api } from './helpers.js';

let ctx, demo;

before(async () => {
  const registry = new DeviceRegistry();
  demo = createDemoProvider({ registry, tickMs: 60_000 });
  ctx = await startApi(registry);
});
after(() => {
  demo.stop();
  ctx.close();
});

// ---- first-run setup ------------------------------------------------------------

test('first run: status says setup is needed, setup creates an admin and signs in', async () => {
  const auth = new AuthService({ store: new JsonStore(null) });
  const server = createServer(createApiHandler({ registry: new DeviceRegistry(), auth }));
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.deepEqual(await (await api(base, null, '/api/auth/status')).json(), { needsSetup: true, user: null });
    const res = await api(base, null, '/api/auth/setup', { method: 'POST', body: { username: 'Niko', password: 'long-enough' } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('set-cookie'), /^hv_session=.+; Path=\/; HttpOnly; SameSite=Lax/);
    const { user } = await res.json();
    assert.equal(user.username, 'niko');
    assert.equal(user.role, 'admin');
    const again = await api(base, null, '/api/auth/setup', { method: 'POST', body: { username: 'x2', password: 'long-enough' } });
    assert.equal(again.status, 409);
  } finally {
    server.close();
  }
});

// ---- login, cookies, logout -------------------------------------------------------

test('login sets a session cookie that works for later requests; logout revokes it', async () => {
  const login = await api(ctx.base, null, '/api/auth/login', { method: 'POST', body: { username: 'member', password: 'member-pass-1' } });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const me = await fetch(`${ctx.base}/api/auth/me`, { headers: { cookie } });
  assert.equal((await me.json()).username, 'member');
  await fetch(`${ctx.base}/api/auth/logout`, { method: 'POST', headers: { cookie } });
  assert.equal((await fetch(`${ctx.base}/api/auth/me`, { headers: { cookie } })).status, 401);
});

test('wrong password is rejected and repeated failures lock the account briefly', async () => {
  for (let i = 0; i < 5; i++) {
    const res = await api(ctx.base, null, '/api/auth/login', { method: 'POST', body: { username: 'guest', password: 'nope' } });
    assert.equal(res.status, 401);
  }
  const locked = await api(ctx.base, null, '/api/auth/login', { method: 'POST', body: { username: 'guest', password: 'guest-pass-1' } });
  assert.equal(locked.status, 429);
});

test('unknown users get the same error as wrong passwords', async () => {
  const res = await api(ctx.base, null, '/api/auth/login', { method: 'POST', body: { username: 'ghost', password: 'whatever1' } });
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error, 'Wrong username or password');
});

// ---- permissions --------------------------------------------------------------------

test('signed-out requests are refused', async () => {
  assert.equal((await api(ctx.base, null, '/api/devices')).status, 401);
  assert.equal((await api(ctx.base, null, '/api/events')).status, 401);
  assert.equal((await api(ctx.base, 'bogus-token', '/api/devices')).status, 401);
});

test('guests can read but not control; members can control but not manage users', async () => {
  const set = (token) => api(ctx.base, token, '/api/devices/demo:hallway_switch/set', { method: 'POST', body: { state_left: 'ON' } });
  assert.equal((await api(ctx.base, ctx.tokens.guest, '/api/devices')).status, 200);
  assert.equal((await set(ctx.tokens.guest)).status, 403);
  assert.equal((await set(ctx.tokens.member)).status, 202);
  assert.equal((await api(ctx.base, ctx.tokens.member, '/api/users')).status, 403);
  assert.equal((await api(ctx.base, ctx.tokens.admin, '/api/users')).status, 200);
});

test('cookie-authenticated writes from another origin are refused', async () => {
  const login = await api(ctx.base, null, '/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'admin-pass-1' } });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const res = await fetch(`${ctx.base}/api/devices/demo:hallway_switch/set`, {
    method: 'POST',
    headers: { cookie, origin: 'https://evil.example', 'content-type': 'application/json' },
    body: JSON.stringify({ state_left: 'OFF' }),
  });
  assert.equal(res.status, 403);
  const formPost = await fetch(`${ctx.base}/api/devices/demo:hallway_switch/set`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'text/plain' },
    body: JSON.stringify({ state_left: 'OFF' }),
  });
  assert.equal(formPost.status, 415);
});

// ---- user management ------------------------------------------------------------------

test('admin creates, updates and deletes users', async () => {
  const created = await api(ctx.base, ctx.tokens.admin, '/api/users', {
    method: 'POST',
    body: { username: 'kid', password: 'kid-pass-12', role: 'guest', displayName: 'Kiddo' },
  });
  assert.equal(created.status, 201);
  const kid = await created.json();
  assert.equal(kid.displayName, 'Kiddo');
  assert.equal(kid.passwordHash, undefined);
  assert.deepEqual(kid.permissions, ['devices:read']);

  const dup = await api(ctx.base, ctx.tokens.admin, '/api/users', { method: 'POST', body: { username: 'kid', password: 'kid-pass-12', role: 'guest' } });
  assert.equal(dup.status, 409);
  const badRole = await api(ctx.base, ctx.tokens.admin, '/api/users', { method: 'POST', body: { username: 'x1', password: 'long-enough', role: 'root' } });
  assert.equal(badRole.status, 400);
  const short = await api(ctx.base, ctx.tokens.admin, '/api/users', { method: 'POST', body: { username: 'x1', password: 'short', role: 'guest' } });
  assert.equal(short.status, 400);

  const promoted = await api(ctx.base, ctx.tokens.admin, `/api/users/${kid.id}`, { method: 'PATCH', body: { role: 'member' } });
  assert.equal((await promoted.json()).role, 'member');
  assert.equal((await api(ctx.base, ctx.tokens.admin, `/api/users/${kid.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await api(ctx.base, ctx.tokens.admin, `/api/users/${kid.id}`, { method: 'DELETE' })).status, 404);
});

test('the last admin cannot be demoted or deleted, and admins cannot delete themselves', async () => {
  const me = await (await api(ctx.base, ctx.tokens.admin, '/api/auth/me')).json();
  const demote = await api(ctx.base, ctx.tokens.admin, `/api/users/${me.id}`, { method: 'PATCH', body: { role: 'member' } });
  assert.equal(demote.status, 409);
  const del = await api(ctx.base, ctx.tokens.admin, `/api/users/${me.id}`, { method: 'DELETE' });
  assert.equal(del.status, 409);
});

test('users can change their own name and password but not their role', async () => {
  const me = await (await api(ctx.base, ctx.tokens.member, '/api/auth/me')).json();
  const named = await api(ctx.base, ctx.tokens.member, `/api/users/${me.id}`, { method: 'PATCH', body: { displayName: 'Mem' } });
  assert.equal((await named.json()).displayName, 'Mem');
  const role = await api(ctx.base, ctx.tokens.member, `/api/users/${me.id}`, { method: 'PATCH', body: { role: 'admin' } });
  assert.equal(role.status, 403);
  const other = await api(ctx.base, ctx.tokens.member, '/api/users/someone-else', { method: 'PATCH', body: { displayName: 'x' } });
  assert.equal(other.status, 403);
});

test('changing a password signs out that user everywhere', async () => {
  const { auth } = ctx;
  const user = await auth.createUser({ username: 'pw', password: 'first-pass-1', role: 'guest' });
  const { token } = await auth.login('pw', 'first-pass-1');
  assert.ok(auth.authenticate(token));
  await auth.updateUser(user.id, { password: 'second-pass-2' });
  assert.equal(auth.authenticate(token), null);
  assert.ok((await auth.login('pw', 'second-pass-2')).token);
});

// ---- persistence ----------------------------------------------------------------------

test('users and sessions persist to disk without plaintext secrets', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hv-auth-'));
  try {
    const first = new AuthService({ store: new JsonStore(dir) });
    await first.setup({ username: 'owner', password: 'super-secret-1' });
    const { token } = await first.login('owner', 'super-secret-1');

    const reloaded = new AuthService({ store: new JsonStore(dir) });
    assert.equal(reloaded.needsSetup(), false);
    assert.equal(reloaded.authenticate(token).username, 'owner');

    const raw = readFileSync(join(dir, 'users.json'), 'utf8') + readFileSync(join(dir, 'sessions.json'), 'utf8');
    assert.ok(!raw.includes('super-secret-1'));
    assert.ok(!raw.includes(token));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sessions expire', async () => {
  let now = Date.now();
  const auth = new AuthService({ store: new JsonStore(null), now: () => now });
  await auth.setup({ username: 'owner', password: 'super-secret-1' });
  const { token } = await auth.login('owner', 'super-secret-1');
  now += 31 * 24 * 60 * 60 * 1000;
  assert.equal(auth.authenticate(token), null);
});
