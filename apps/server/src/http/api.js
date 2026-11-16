import { RegistryError } from '../devices/registry.js';

const MAX_BODY = 64 * 1024;

/**
 * Minimal JSON API on top of node:http.
 *   GET  /api/health
 *   GET  /api/devices
 *   GET  /api/devices/:id
 *   POST /api/devices/:id/set   body: { property: value, ... }
 */
export function createApiHandler({ registry }) {
  return async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    try {
      if (parts[0] !== 'api') return send(res, 404, { error: 'Not found' });

      if (parts[1] === 'health' && parts.length === 2 && req.method === 'GET') {
        return send(res, 200, { ok: true, name: 'homeyvibe', devices: registry.list().length });
      }

      if (parts[1] === 'devices') {
        if (parts.length === 2 && req.method === 'GET') return send(res, 200, registry.list());
        const device = registry.get(parts[2]);
        if (parts.length === 3 && req.method === 'GET') {
          return device ? send(res, 200, device) : send(res, 404, { error: 'Unknown device' });
        }
        if (parts.length === 4 && parts[3] === 'set' && req.method === 'POST') {
          const body = await readJson(req);
          return send(res, 202, await registry.command(parts[2], body));
        }
      }
      send(res, 404, { error: 'Not found' });
    } catch (err) {
      const status = err instanceof RegistryError || err.status ? err.status : 500;
      send(res, status, { error: status === 500 ? 'Internal error' : err.message });
      if (status === 500) console.error(err);
    }
  };
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new RegistryError(413, 'Body too large');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString() || '{}');
  } catch {
    throw new RegistryError(400, 'Invalid JSON');
  }
}
