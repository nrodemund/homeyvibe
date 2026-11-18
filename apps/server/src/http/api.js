import { HttpError } from './errors.js';
import { PERMISSIONS, ROLES, can } from '../auth/roles.js';

const MAX_BODY = 64 * 1024;
const COOKIE = 'hv_session';
const COOKIE_MAX_AGE_S = 30 * 24 * 60 * 60;

/**
 * JSON API on top of node:http.
 *
 * Public:
 *   GET  /api/health
 *   GET  /api/auth/status          { needsSetup, user|null }
 *   POST /api/auth/setup           first admin { username, password, displayName? }
 *   POST /api/auth/login           { username, password } -> session cookie + { token, user }
 *   POST /api/auth/logout
 *
 * Signed in (cookie or "Authorization: Bearer <token>"):
 *   GET  /api/auth/me
 *   GET  /api/devices                         devices:read
 *   GET  /api/devices/:id                     devices:read
 *   POST /api/devices/:id/set                 devices:control
 *   GET  /api/events                          devices:read (Server-Sent Events)
 *   GET  /api/roles                           any signed-in user
 *   GET  /api/users                           users:manage
 *   POST /api/users                           users:manage
 *   PATCH  /api/users/:id                     users:manage, or self for displayName/password
 *   DELETE /api/users/:id                     users:manage
 */
export function createApiHandler({ registry, auth }) {
  const routes = [
    ['GET', '/api/health', { public: true }, () => ({ ok: true, name: 'homeyvibe' })],

    ['GET', '/api/auth/status', { public: true }, ({ user }) => ({ needsSetup: auth.needsSetup(), user })],
    ['POST', '/api/auth/setup', { public: true }, async ({ req, res, body }) => {
      await auth.setup(body);
      return startSession(req, res, await auth.login(body.username, body.password));
    }],
    ['POST', '/api/auth/login', { public: true }, async ({ req, res, body }) =>
      startSession(req, res, await auth.login(body.username, body.password))],
    ['POST', '/api/auth/logout', { public: true }, ({ req, res, token }) => {
      auth.logout(token);
      setCookie(req, res, '', 0);
      return { ok: true };
    }],
    ['GET', '/api/auth/me', {}, ({ user }) => user],

    ['GET', '/api/roles', {}, () =>
      Object.entries(ROLES).map(([id, r]) => ({ id, label: r.label, description: r.description, permissions: r.permissions }))],

    ['GET', '/api/devices', { permission: PERMISSIONS.DEVICES_READ }, () => registry.list()],
    ['GET', '/api/devices/:id', { permission: PERMISSIONS.DEVICES_READ }, ({ params }) => {
      const device = registry.get(params.id);
      if (!device) throw new HttpError(404, 'Unknown device');
      return device;
    }],
    ['POST', '/api/devices/:id/set', { permission: PERMISSIONS.DEVICES_CONTROL, status: 202 }, ({ params, body }) =>
      registry.command(params.id, body)],
    ['GET', '/api/events', { permission: PERMISSIONS.DEVICES_READ, raw: true }, ({ req, res }) =>
      streamEvents(req, res, registry)],

    ['GET', '/api/users', { permission: PERMISSIONS.USERS_MANAGE }, () => auth.listUsers()],
    ['POST', '/api/users', { permission: PERMISSIONS.USERS_MANAGE, status: 201 }, ({ body }) => auth.createUser(body)],
    ['PATCH', '/api/users/:id', {}, ({ user, params, body }) => {
      const isAdmin = can(user, PERMISSIONS.USERS_MANAGE);
      if (!isAdmin) {
        if (params.id !== user.id) throw new HttpError(403, 'Forbidden');
        if (body.role !== undefined) throw new HttpError(403, 'Only admins can change roles');
      }
      return auth.updateUser(params.id, pick(body, ['displayName', 'password', 'role']));
    }],
    ['DELETE', '/api/users/:id', { permission: PERMISSIONS.USERS_MANAGE }, ({ user, params }) => {
      if (params.id === user.id) throw new HttpError(409, 'You cannot delete yourself');
      auth.deleteUser(params.id);
      return { ok: true };
    }],
  ].map(([method, path, opts, handler]) => ({ method, ...compile(path), opts, handler }));

  return async function handle(req, res) {
    try {
      const url = new URL(req.url, 'http://localhost');
      const match = findRoute(routes, req.method, url.pathname);
      if (!match) throw new HttpError(404, 'Not found');
      const { route, params } = match;

      const { token, fromCookie } = readToken(req);
      const user = auth.authenticate(token);
      if (!route.opts.public) {
        if (!user) throw new HttpError(401, 'Sign in required');
        if (route.opts.permission && !can(user, route.opts.permission)) throw new HttpError(403, 'Forbidden');
      }
      if (req.method !== 'GET' && fromCookie) checkSameOrigin(req);

      const body = ['POST', 'PATCH', 'PUT'].includes(req.method) ? await readJson(req) : undefined;
      const result = await route.handler({ req, res, params, body, user, token });
      if (route.opts.raw) return;
      send(res, route.opts.status ?? 200, result ?? { ok: true });
    } catch (err) {
      const status = Number.isInteger(err.status) ? err.status : 500;
      if (res.headersSent) return res.end();
      if (status === 405) res.setHeader('allow', err.allow);
      send(res, status, { error: status === 500 ? 'Internal error' : err.message });
      if (status === 500) console.error(err);
    }
  };
}

// ---- routing -------------------------------------------------------------------

function compile(path) {
  const keys = [];
  const pattern = path.replace(/:(\w+)/g, (_, key) => {
    keys.push(key);
    return '([^/]+)';
  });
  return { path, regex: new RegExp(`^${pattern}/?$`), keys };
}

function findRoute(routes, method, pathname) {
  const allowed = [];
  for (const route of routes) {
    const m = route.regex.exec(pathname);
    if (!m) continue;
    if (route.method !== method) {
      allowed.push(route.method);
      continue;
    }
    const params = Object.fromEntries(route.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
    return { route, params };
  }
  if (allowed.length) throw Object.assign(new HttpError(405, 'Method not allowed'), { allow: allowed.join(', ') });
  return null;
}

// ---- sessions --------------------------------------------------------------------

function readToken(req) {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return { token: header.slice(7).trim(), fromCookie: false };
  const cookies = Object.fromEntries(
    (req.headers.cookie ?? '').split(';').map((c) => c.trim().split('=')).filter(([k]) => k),
  );
  return { token: cookies[COOKIE] ? decodeURIComponent(cookies[COOKIE]) : null, fromCookie: Boolean(cookies[COOKIE]) };
}

function startSession(req, res, { token, user }) {
  setCookie(req, res, token, COOKIE_MAX_AGE_S);
  return { token, user };
}

function setCookie(req, res, value, maxAge) {
  const secure = req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader(
    'set-cookie',
    `${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`,
  );
}

/** Cookie-authenticated writes must come from our own origin (CSRF protection on top of SameSite). */
function checkSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return;
  const host = req.headers['x-forwarded-host'] ?? req.headers.host;
  let originHost;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw new HttpError(403, 'Bad origin');
  }
  if (originHost !== host) throw new HttpError(403, 'Cross-origin request refused');
}

// ---- helpers ---------------------------------------------------------------------

function pick(obj, keys) {
  return Object.fromEntries(keys.filter((k) => obj?.[k] !== undefined).map((k) => [k, obj[k]]));
}

const HEARTBEAT_MS = 25_000;

function streamEvents(req, res, registry) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  const emit = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  emit('snapshot', registry.list());

  const onDevice = (device) => emit('device', device);
  const onRemoved = (device) => emit('removed', { id: device.id });
  const onState = (device, changes) => emit('state', { id: device.id, changes });
  registry.on('device:added', onDevice);
  registry.on('device:updated', onDevice);
  registry.on('device:removed', onRemoved);
  registry.on('state', onState);
  const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);

  res.on('close', () => {
    clearInterval(heartbeat);
    registry.off('device:added', onDevice);
    registry.off('device:updated', onDevice);
    registry.off('device:removed', onRemoved);
    registry.off('state', onState);
  });
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  const type = req.headers['content-type'] ?? '';
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, 'Body too large');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString();
  if (!text) return {};
  if (!type.startsWith('application/json')) throw new HttpError(415, 'Send JSON with content-type application/json');
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}
