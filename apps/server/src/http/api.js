import { HttpError } from './errors.js';
import { PERMISSIONS, ROLES, can } from '../auth/roles.js';
import { buildContext } from '../ai/context.js';
import { importConfig } from '../ai/importer.js';
import { handleMcpRequest } from '../ai/mcp.js';
import { scopedRegistry } from '../auth/access.js';
import { aiToolkit, systemBlocks, DEFAULT_MODEL } from '../ai/chat.js';
import { normalizeFloorplan } from '../config/floorplan.js';
import { checkPlacementSettings, visibleFloorplan } from '../config/floorplan-settings.js';
import { HISTORY_RANGES } from '../devices/history-db.js';

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
 *   GET|PUT|DELETE /api/integrations/zigbee2mqtt   config:write: diagnostics, save settings, restore deployment defaults
 *   POST /api/integrations/zigbee2mqtt/retry        config:write: reconnect and rediscover
 *   GET  /api/devices/:id                     devices:read
 *   GET  /api/devices/:id/history             devices:read for a visible numeric capability (?property=...)
 *   POST /api/devices/:id/set                 devices:control
 *   GET  /api/events                          devices:read (Server-Sent Events)
 *   GET  /api/roles                           any signed-in user
 *   GET  /api/users                           users:manage
 *   POST /api/users                           users:manage
 *   PATCH  /api/users/:id                     users:manage, or self for displayName/password
 *   DELETE /api/users/:id                     users:manage
 *   GET  /api/pages, /api/pages/:id           devices:read
 *   PUT  /api/pages/order                    config:write: reorder pages by id
 *   POST /api/pages, PATCH|DELETE /api/pages/:id         config:write
 *   GET  /api/actions, /api/actions/:id       devices:read
 *   POST /api/actions, PATCH|DELETE /api/actions/:id     config:write
 *   POST /api/actions/:id/run                 devices:control (checked against the person's limits)
 *   GET  /api/access                          users:manage: { ai, users } device limits (see auth/access.js)
 *   PUT  /api/access/ai                       users:manage: { canControl, canConfigure, default, devices }
 *   PUT  /api/access/users/:id                users:manage: { default, devices } for a non-admin
 *   GET|POST /api/auth/tokens, DELETE /api/auth/tokens/:id   own access tokens
 *   GET  /api/ai/context                      devices:read (Markdown for any LLM)
 *   GET  /api/floorplan                       devices:read: { rooms, devices } (see config/floorplan.js)
 *   PUT  /api/floorplan                       config:write: replace the floor plan
 *   POST /api/ai/import                       config:write ({ pages, actions } from an LLM)
 *   GET  /api/ai/tools                        devices:read: { model, system, tools } for a client-side AI chat
 *   POST /api/ai/tools/:name                  devices:read: run one tool with the AI's limits -> { ok, text }
 *   POST /mcp                                 MCP (Streamable HTTP, stateless), Bearer token
 *   GET  /api/ai/settings                     signed in: { provider, configured, source, keyHint, model }
 *   PATCH /api/ai/settings                    config:write: { provider?, apiKey?, model? }
 *   POST /api/ai/chat                         devices:read: { message, conversationId? } -> SSE
 *   DELETE /api/ai/chat/:id                   forget a conversation
 */
export function createApiHandler({ registry, auth, pages, actions, engine, aiSettings, chat, floorplan = null, access = null, zigbee = null, historySelection = null, approval = null, notifications = null }) {
  /** The registry as this person may see and use it. */
  const devicesFor = (user) => (access ? scopedRegistry(registry, access.policyFor(user)) : registry);
  /** The registry as the AI sees it when acting for this person. */
  const devicesForAi = (user) => (access ? scopedRegistry(registry, access.aiFor(user).policy) : registry);
  const floorplanFor = (user, plan) => visibleFloorplan(plan, access?.policyFor(user), can(user, PERMISSIONS.DEVICES_CONTROL));
  const aiDeps = { registry, pages, actions, engine, floorplan, access, zigbee };
  function findDevice(user, id) {
    const device = devicesFor(user).get(id);
    if (!device) throw new HttpError(404, 'Unknown device');
    return device;
  }
  function numericProperty(device, property) {
    if (!device.capabilities.some((cap) => cap.property === property && cap.readable && cap.type === 'numeric')) {
      throw new HttpError(400, 'Choose a readable numeric device property');
    }
    return property;
  }
  function checkActionWrite({ params, body, fromCookie }) {
    const previous = params.id && actions.get(params.id);
    if (!fromCookie && [previous?.security, body?.security].some((value) => value && value !== 'none')) {
      throw new HttpError(403, 'Manage protected actions in HomeyVibe while signed in');
    }
  }
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
      notifications?.removeSession(token);
      auth.logout(token);
      setCookie(req, res, '', 0);
      return { ok: true };
    }],
    ['GET', '/api/auth/me', {}, ({ user }) => user],
    ...(notifications ? [
      ['GET', '/api/notifications', { session: true }, ({ token }) => notifications.get(token)],
      ['PUT', '/api/notifications', { session: true }, ({ token, user, body }) => notifications.update(token, user, body)],
      ['DELETE', '/api/notifications', { session: true }, ({ token }) => { notifications.removeSession(token); }],
    ] : []),
    ...(approval ? [
      ['GET', '/api/auth/passkeys', { session: true }, ({ user }) => approval.keys(user)],
      ['POST', '/api/auth/passkeys/options', { session: true }, ({ req, token, user, body }) =>
        approval.beginRegistration(req, token, user, body.password)],
      ['POST', '/api/auth/passkeys', { session: true }, ({ token, user, body }) => approval.register(token, user, body)],
      ['POST', '/api/auth/passkeys/remove', { session: true }, ({ user, body }) => approval.remove(user, body.id, body.password)],
    ] : []),
    ['GET', '/api/auth/tokens', {}, ({ user }) => auth.listAccessTokens(user.id)],
    ['POST', '/api/auth/tokens', { status: 201 }, ({ user, body }) => auth.createAccessToken(user.id, body.name)],
    ['DELETE', '/api/auth/tokens/:id', {}, ({ user, params }) => {
      auth.revokeAccessToken(user.id, params.id);
      return { ok: true };
    }],

    ['GET', '/api/roles', {}, () =>
      Object.entries(ROLES).map(([id, r]) => ({ id, label: r.label, description: r.description, permissions: r.permissions }))],

    ['GET', '/api/devices', { permission: PERMISSIONS.DEVICES_READ }, ({ user }) => devicesFor(user).list()],
    ...(zigbee ? [
      ['GET', '/api/integrations/zigbee2mqtt', { permission: PERMISSIONS.CONFIG_WRITE }, () => zigbee.status()],
      ['PUT', '/api/integrations/zigbee2mqtt', { permission: PERMISSIONS.CONFIG_WRITE }, ({ body }) => zigbee.update(body)],
      ['DELETE', '/api/integrations/zigbee2mqtt', { permission: PERMISSIONS.CONFIG_WRITE }, () => zigbee.reset()],
      ['POST', '/api/integrations/zigbee2mqtt/retry', { permission: PERMISSIONS.CONFIG_WRITE }, () => zigbee.start()],
    ] : []),
    ['GET', '/api/devices/:id', { permission: PERMISSIONS.DEVICES_READ }, ({ params, user }) => {
      const device = devicesFor(user).get(params.id);
      if (!device) throw new HttpError(404, 'Unknown device');
      return device;
    }],
    ['GET', '/api/devices/:id/history', { permission: PERMISSIONS.DEVICES_READ }, ({ params, user, url }) => {
      const device = findDevice(user, params.id);
      const property = numericProperty(device, url.searchParams.get('property'));
      const range = url.searchParams.get('range') ?? '24h';
      if (!Object.hasOwn(HISTORY_RANGES, range)) throw new HttpError(400, 'Choose 2h, 24h, 30d or all');
      return { points: registry.history(device.id, property, range), ...historySelection?.get(device.id, property) };
    }],
    ...(historySelection ? [
      ['PUT', '/api/devices/:id/history', { permission: PERMISSIONS.CONFIG_WRITE }, ({ params, user, body }) => {
        const device = findDevice(user, params.id);
        const property = numericProperty(device, body.property);
        if (typeof body.enabled !== 'boolean') throw new HttpError(400, 'enabled must be true or false');
        return historySelection.update(device.id, property, body.enabled);
      }],
    ] : []),
    ['GET', '/api/devices/:id/activity', { permission: PERMISSIONS.DEVICES_READ }, ({ params, user, url }) => {
      const device = findDevice(user, params.id);
      const before = Number(url.searchParams.get('before') ?? Number.MAX_SAFE_INTEGER);
      if (!Number.isSafeInteger(before) || before < 1) throw new HttpError(400, 'Invalid activity cursor');
      const control = can(user, PERMISSIONS.DEVICES_CONTROL) && device.access !== 'view';
      const events = registry.deviceHistory.activity(device.id, before).map((event) =>
        event.kind === 'command' && !control ? { ...event, value: null } : event);
      return { events };
    }],
    ['POST', '/api/devices/:id/set', { permission: PERMISSIONS.DEVICES_CONTROL, status: 202 }, ({ params, body, user }) =>
      devicesFor(user).command(params.id, body)],
    ...(registry.timers ? [
      ['GET', '/api/timers', { permission: PERMISSIONS.DEVICES_READ }, ({ user }) =>
        registry.timers.list().filter((timer) => devicesFor(user).get(timer.deviceId)).map(publicTimer)],
      ['POST', '/api/devices/:id/timed', { permission: PERMISSIONS.DEVICES_CONTROL, status: 202 }, ({ params, body, user }) =>
        devicesFor(user).command(params.id, body.values, body.timer ?? {})],
      ['PATCH', '/api/devices/:id/timer', { permission: PERMISSIONS.DEVICES_CONTROL }, async ({ params, body, user }) => {
        const device = findDevice(user, params.id);
        const scoped = devicesFor(user);
        const timer = await registry.timers.update(device, body.seconds, (values) => scoped.check?.(device.id, values));
        return { timer: publicTimer(timer) };
      }],
    ] : []),
    ['GET', '/api/events', { permission: PERMISSIONS.DEVICES_READ, raw: true }, ({ req, res, user }) =>
      streamEvents(req, res, { registry, pages, actions, engine, floorplan, access, user })],

    ...(floorplan ? [
      ['GET', '/api/floorplan', { permission: PERMISSIONS.DEVICES_READ }, ({ user }) => floorplanFor(user, floorplan.get())],
      ['PUT', '/api/floorplan', { permission: PERMISSIONS.CONFIG_WRITE, maxBody: 512 * 1024 }, ({ body, user }) => {
        const plan = normalizeFloorplan(body);
        const errors = checkPlacementSettings(plan, floorplan.get(), {
          registry: devicesFor(user), lookupAction: (id) => actions?.get(id),
          canControl: can(user, PERMISSIONS.DEVICES_CONTROL),
        });
        if (errors.length) throw new HttpError(400, errors.join('; '));
        return floorplan.replace(plan);
      }],
    ] : []),
    ...(pages ? [
      ...crudRoutes('pages', pages, 'page'),
      ['PUT', '/api/pages/order', { permission: PERMISSIONS.CONFIG_WRITE }, ({ body }) => pages.reorder(body.ids)],
    ] : []),
    ...(actions ? crudRoutes('actions', actions, 'action', checkActionWrite) : []),
    ...(pages && actions ? [
      ['GET', '/api/ai/context', { permission: PERMISSIONS.DEVICES_READ, raw: true }, ({ res, user }) => {
        res.writeHead(200, {
          'content-type': 'text/markdown; charset=utf-8',
          'content-disposition': 'attachment; filename="homeyvibe-context.md"',
          'cache-control': 'no-store',
        });
        const aiUser = access?.aiFor(user).user ?? user;
        const aiFloorplan = floorplan && { get: () => visibleFloorplan(floorplan.get(), access?.aiFor(user).policy, can(aiUser, PERMISSIONS.DEVICES_CONTROL)) };
        res.end(buildContext({ registry: devicesForAi(user), pages, actions, floorplan: aiFloorplan }));
      }],
      ['POST', '/api/ai/import', { permission: PERMISSIONS.CONFIG_WRITE }, ({ body, user }) =>
        importConfig({ bundle: body, pages, actions, registry: devicesFor(user), floorplan })],
      // For clients that run the model themselves (the Pi only runs the tools).
      ['GET', '/api/ai/tools', { permission: PERMISSIONS.DEVICES_READ }, ({ user }) => ({
        model: aiSettings?.model('claude') ?? DEFAULT_MODEL,
        system: systemBlocks(user),
        tools: aiToolkit({ user, deps: aiDeps }).definitions,
      })],
      ['POST', '/api/ai/tools/:name', { permission: PERMISSIONS.DEVICES_READ }, ({ user, params, body }) =>
        aiToolkit({ user, deps: aiDeps, by: `client-ai:${user.username}` }).run(params.name, body)],
      ['POST', '/mcp', { permission: PERMISSIONS.DEVICES_READ, raw: true }, ({ req, res, body, user }) =>
        handleMcpRequest({ req, res, body, user, deps: aiDeps })],
    ] : []),
    ...(aiSettings ? [
      ['GET', '/api/ai/settings', {}, () => aiSettings.status()],
      ['PATCH', '/api/ai/settings', { permission: PERMISSIONS.CONFIG_WRITE }, ({ body }) =>
        aiSettings.update(pick(body, ['apiKey', 'model', 'provider']))],
    ] : []),
    ...(chat ? [
      ['POST', '/api/ai/chat', { permission: PERMISSIONS.DEVICES_READ, raw: true }, ({ req, res, body, user }) =>
        streamChat({ req, res, body, user, chat })],
      ['DELETE', '/api/ai/chat/:id', {}, ({ user, params }) => {
        chat.reset(user.id, params.id);
        return { ok: true };
      }],
    ] : []),
    ...(engine ? [
      ...(approval ? [['POST', '/api/actions/:id/approval', { permission: PERMISSIONS.DEVICES_CONTROL, session: true },
        ({ req, params, user, token }) => {
          const action = actions.get(params.id);
          if (!action) throw new HttpError(404, 'Unknown action');
          const scoped = devicesFor(user);
          if (scoped.check) engine.preflight(params.id, scoped.check);
          return approval.beginAction(req, token, user, action);
        }]] : []),
      ['POST', '/api/actions/:id/run', { permission: PERMISSIONS.DEVICES_CONTROL }, async ({ params, user, token, body, fromCookie }) => {
        const action = actions?.get(params.id);
        const scoped = devicesFor(user);
        if (scoped.check) engine.preflight(params.id, scoped.check);
        let approved;
        if (action?.security && action.security !== 'none') {
          if (!approval || !fromCookie) throw new HttpError(403, 'Approve this action in HomeyVibe');
          if (await approval.approve(token, user, action, body)) approved = JSON.stringify(action);
        }
        return engine.run(params.id, { by: `user:${user.username}`, approved });
      }],
    ] : []),
    ...(access ? [
      ['GET', '/api/access', { permission: PERMISSIONS.USERS_MANAGE }, () => access.all()],
      ['PUT', '/api/access/ai', { permission: PERMISSIONS.USERS_MANAGE }, ({ body }) => access.setAi(body)],
      ['PUT', '/api/access/users/:id', { permission: PERMISSIONS.USERS_MANAGE }, ({ params, body }) => {
        const target = auth.getUser(params.id);
        if (!target) throw new HttpError(404, 'Unknown user');
        if (target.role === 'admin') throw new HttpError(400, 'Admins always have full access');
        return access.setUser(params.id, body);
      }],
    ] : []),

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
      access?.removeUser(params.id);
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
        if (route.opts.session && (!fromCookie || !auth.isSession(token))) {
          throw new HttpError(403, 'Use a signed-in HomeyVibe browser session');
        }
        if (route.opts.permission && !can(user, route.opts.permission)) throw new HttpError(403, 'Forbidden');
      }
      if (req.method !== 'GET' && fromCookie) checkSameOrigin(req);

      const body = ['POST', 'PATCH', 'PUT'].includes(req.method) ? await readJson(req, route.opts.maxBody) : undefined;
      const result = await route.handler({ req, res, params, body, user, token, url, fromCookie: fromCookie && auth.isSession(token) });
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
function crudRoutes(name, collection, noun, checkWrite = () => {}) {
  const get = ({ params }) => {
    const item = collection.get(params.id);
    if (!item) throw new HttpError(404, `Unknown ${noun}`);
    return item;
  };
  return [
    ['GET', `/api/${name}`, { permission: PERMISSIONS.DEVICES_READ }, () => collection.list()],
    ['GET', `/api/${name}/:id`, { permission: PERMISSIONS.DEVICES_READ }, get],
    ['POST', `/api/${name}`, { permission: PERMISSIONS.CONFIG_WRITE, status: 201 }, (context) => {
      checkWrite(context);
      return collection.create(context.body);
    }],
    ['PATCH', `/api/${name}/:id`, { permission: PERMISSIONS.CONFIG_WRITE }, (context) => {
      checkWrite(context);
      return collection.update(context.params.id, context.body);
    }],
    ['DELETE', `/api/${name}/:id`, { permission: PERMISSIONS.CONFIG_WRITE }, (context) => {
      checkWrite(context);
      collection.delete(context.params.id);
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
  const secure = req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https' ||
    req.headers.origin === `https://${req.headers['x-forwarded-host'] ?? req.headers.host}`;
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

function streamEvents(req, res, { registry, pages, actions, engine, floorplan, access, user }) {
  let policy = access?.policyFor(user) ?? null;
  const visible = (device) => (policy ? policy.decorate(device) : device);
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  const emit = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const snapshot = () => emit('snapshot', registry.list().map(visible).filter(Boolean));
  snapshot();

  const onDevice = (device) => {
    const shown = visible(device);
    if (shown) emit('device', shown);
  };
  const onRemoved = (device) => { if (!policy || policy.canSee(device.id)) emit('removed', { id: device.id }); };
  const onState = (device, changes) => {
    if (!policy || policy.canSee(device.id)) emit('state', { id: device.id, changes });
  };
  const onAccess = () => {
    policy = access.policyFor(user);
    snapshot();
  };
  access?.on('changed', onAccess);
  registry.on('device:added', onDevice);
  registry.on('device:updated', onDevice);
  registry.on('device:removed', onRemoved);
  registry.on('state', onState);
  const onPages = () => emit('pages', pages.list());
  const onActions = () => emit('actions', actions.list());
  const onRun = (result) => emit('run', result);
  const onTimer = (id, timer) => {
    if (!policy || policy.canSee(id)) emit('timer', { deviceId: id, timer: publicTimer(timer) });
  };
  registry.on('timer', onTimer);
  const onFloorplan = (plan) => emit('floorplan', visibleFloorplan(plan, policy, can(user, PERMISSIONS.DEVICES_CONTROL)));
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
    registry.off('timer', onTimer);
    pages?.off('changed', onPages);
    actions?.off('changed', onActions);
    engine?.off('run', onRun);
    floorplan?.off('changed', onFloorplan);
    access?.off('changed', onAccess);
  });
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function publicTimer(timer) {
  return timer ? { deviceId: timer.deviceId, expiresAt: timer.expiresAt, retrying: Boolean(timer.retryAt) } : null;
}

async function readJson(req, maxBody = MAX_BODY) {
  const type = req.headers['content-type'] ?? '';
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBody) throw new HttpError(413, 'Body too large');
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
