import { HttpError } from './errors.js';
import { PERMISSIONS, ROLES, can } from '../auth/roles.js';
import { buildContext } from '../ai/context.js';
import { importConfig } from '../ai/importer.js';
import { handleMcpRequest } from '../ai/mcp.js';

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
 *   GET  /api/pages, /api/pages/:id           devices:read
 *   POST /api/pages, PATCH|DELETE /api/pages/:id         config:write
 *   GET  /api/actions, /api/actions/:id       devices:read
 *   POST /api/actions, PATCH|DELETE /api/actions/:id     config:write
 *   POST /api/actions/:id/run                 devices:control
 *   GET|POST /api/auth/tokens, DELETE /api/auth/tokens/:id   own access tokens
 *   GET  /api/ai/context                      devices:read (Markdown for any LLM)
 *   GET  /api/floorplan                       devices:read: { rooms, devices } (see config/floorplan.js)
 *   PUT  /api/floorplan                       config:write: replace the floor plan
 *   POST /api/ai/import                       config:write ({ pages, actions } from an LLM)
 *   POST /mcp                                 MCP (Streamable HTTP, stateless), Bearer token
 *   GET  /api/ai/settings                     signed in: { configured, source, keyHint, model }
 *   PATCH /api/ai/settings                    config:write: { apiKey?, model? }
 *   POST /api/ai/chat                         devices:read: { message, conversationId? } -> SSE
 *   DELETE /api/ai/chat/:id                   forget a conversation
 */
export function createApiHandler({ registry, auth, pages, actions, engine, aiSettings, chat, floorplan = null }) {
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
    ['GET', '/api/auth/tokens', {}, ({ user }) => auth.listAccessTokens(user.id)],
    ['POST', '/api/auth/tokens', { status: 201 }, ({ user, body }) => auth.createAccessToken(user.id, body.name)],
    ['DELETE', '/api/auth/tokens/:id', {}, ({ user, params }) => {
      auth.revokeAccessToken(user.id, params.id);
      return { ok: true };
    }],

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
      streamEvents(req, res, { registry, pages, actions, engine, floorplan })],

    ...(floorplan ? [
      ['GET', '/api/floorplan', { permission: PERMISSIONS.DEVICES_READ }, () => floorplan.get()],
      ['PUT', '/api/floorplan', { permission: PERMISSIONS.CONFIG_WRITE }, ({ body }) => floorplan.replace(body)],
    ] : []),
    ...(pages ? crudRoutes('pages', pages, 'page') : []),
    ...(actions ? crudRoutes('actions', actions, 'action') : []),
    ...(pages && actions ? [
      ['GET', '/api/ai/context', { permission: PERMISSIONS.DEVICES_READ, raw: true }, ({ res }) => {
        res.writeHead(200, {
          'content-type': 'text/markdown; charset=utf-8',
          'content-disposition': 'attachment; filename="homeyvibe-context.md"',
          'cache-control': 'no-store',
        });
        res.end(buildContext({ registry, pages, actions, floorplan }));
      }],
      ['POST', '/api/ai/import', { permission: PERMISSIONS.CONFIG_WRITE }, ({ body }) =>
        importConfig({ bundle: body, pages, actions, registry, floorplan })],
      ['POST', '/mcp', { permission: PERMISSIONS.DEVICES_READ, raw: true }, ({ req, res, body, user }) =>
        handleMcpRequest({ req, res, body, user, deps: { registry, pages, actions, engine, floorplan } })],
    ] : []),
    ...(aiSettings ? [
      ['GET', '/api/ai/settings', {}, () => aiSettings.status()],
      ['PATCH', '/api/ai/settings', { permission: PERMISSIONS.CONFIG_WRITE }, ({ body }) =>
        aiSettings.update(pick(body, ['apiKey', 'model']))],
    ] : []),
    ...(chat ? [
      ['POST', '/api/ai/chat', { permission: PERMISSIONS.DEVICES_READ, raw: true }, ({ req, res, body, user }) =>
        streamChat({ req, res, body, user, chat })],
      ['DELETE', '/api/ai/chat/:id', {}, ({ user, params }) => {
        chat.reset(user.id, params.id);
        return { ok: true };
      }],
    ] : []),
    ...(engine ? [['POST', '/api/actions/:id/run', { permission: PERMISSIONS.DEVICES_CONTROL }, ({ params, user }) =>
      engine.run(params.id, { by: `user:${user.username}` })]] : []),

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

/** Standard list/get/create/update/delete routes for a config collection. */
function crudRoutes(name, collection, noun) {
  const get = ({ params }) => {
    const item = collection.get(params.id);
    if (!item) throw new HttpError(404, `Unknown ${noun}`);
    return item;
  };
  return [
    ['GET', `/api/${name}`, { permission: PERMISSIONS.DEVICES_READ }, () => collection.list()],
    ['GET', `/api/${name}/:id`, { permission: PERMISSIONS.DEVICES_READ }, get],
    ['POST', `/api/${name}`, { permission: PERMISSIONS.CONFIG_WRITE, status: 201 }, ({ body }) => collection.create(body)],
    ['PATCH', `/api/${name}/:id`, { permission: PERMISSIONS.CONFIG_WRITE }, ({ params, body }) => collection.update(params.id, body)],
    ['DELETE', `/api/${name}/:id`, { permission: PERMISSIONS.CONFIG_WRITE }, ({ params }) => {
      collection.delete(params.id);
      return { ok: true };
    }],
  ];
}

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

/** Run a chat turn, streaming events as SSE. Errors before the first event become normal JSON errors. */
async function streamChat({ req, res, body, user, chat }) {
  const controller = new AbortController();
  res.on('close', () => { if (!res.writableFinished) controller.abort(); });
  const emit = (event, data) => {
    if (!res.headersSent) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    }
    if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  try {
    await chat.send({ user, conversationId: body.conversationId, message: body.message, emit, signal: controller.signal });
  } catch (err) {
    if (!res.headersSent) throw err;
    if (!controller.signal.aborted) {
      emit('error', { message: Number.isInteger(err.status) ? err.message : 'Something went wrong' });
      if (!Number.isInteger(err.status)) console.error(err);
    }
  }
  res.end();
}

const HEARTBEAT_MS = 25_000;

function streamEvents(req, res, { registry, pages, actions, engine, floorplan }) {
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
  const onPages = () => emit('pages', pages.list());
  const onActions = () => emit('actions', actions.list());
  const onRun = (result) => emit('run', result);
  const onFloorplan = (plan) => emit('floorplan', plan);
  floorplan?.on('changed', onFloorplan);
  pages?.on('changed', onPages);
  actions?.on('changed', onActions);
  engine?.on('run', onRun);
  const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);

  res.on('close', () => {
    clearInterval(heartbeat);
    registry.off('device:added', onDevice);
    registry.off('device:updated', onDevice);
    registry.off('device:removed', onRemoved);
    registry.off('state', onState);
    pages?.off('changed', onPages);
    actions?.off('changed', onActions);
    engine?.off('run', onRun);
    floorplan?.off('changed', onFloorplan);
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
