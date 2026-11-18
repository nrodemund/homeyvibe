// Thin fetch wrapper: JSON in, JSON out, cookie session, errors carry the server message.

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function request(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? res.statusText);
  return data;
}

export const api = {
  status: () => request('/api/auth/status'),
  setup: (input) => request('/api/auth/setup', { method: 'POST', body: input }),
  login: (username, password) => request('/api/auth/login', { method: 'POST', body: { username, password } }),
  logout: () => request('/api/auth/logout', { method: 'POST' }),
  me: () => request('/api/auth/me'),
  roles: () => request('/api/roles'),
  users: () => request('/api/users'),
  createUser: (input) => request('/api/users', { method: 'POST', body: input }),
  updateUser: (id, changes) => request(`/api/users/${encodeURIComponent(id)}`, { method: 'PATCH', body: changes }),
  deleteUser: (id) => request(`/api/users/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  tokens: () => request('/api/auth/tokens'),
  createToken: (name) => request('/api/auth/tokens', { method: 'POST', body: { name } }),
  revokeToken: (id) => request(`/api/auth/tokens/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  aiSettings: () => request('/api/ai/settings'),
  updateAiSettings: (changes) => request('/api/ai/settings', { method: 'PATCH', body: changes }),
  forgetChat: (id) => request(`/api/ai/chat/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  devices: () => request('/api/devices'),
  deviceHistory: (id, property) => request(`/api/devices/${encodeURIComponent(id)}/history?property=${encodeURIComponent(property)}`),
  zigbee: () => request('/api/integrations/zigbee2mqtt'),
  saveZigbee: (body) => request('/api/integrations/zigbee2mqtt', { method: 'PUT', body }),
  resetZigbee: () => request('/api/integrations/zigbee2mqtt', { method: 'DELETE' }),
  retryZigbee: () => request('/api/integrations/zigbee2mqtt/retry', { method: 'POST' }),
  access: () => request('/api/access'),
  setAiAccess: (limits) => request('/api/access/ai', { method: 'PUT', body: limits }),
  setUserAccess: (id, limits) => request(`/api/access/users/${encodeURIComponent(id)}`, { method: 'PUT', body: limits }),
  pages: () => request('/api/pages'),
  savePage: (page) => saveConfig('/api/pages', page),
  setPageStart: (id, startPage) => request(`/api/pages/${encodeURIComponent(id)}`, { method: 'PATCH', body: { startPage } }),
  reorderPages: (ids) => request('/api/pages/order', { method: 'PUT', body: { ids } }),
  deletePage: (id) => request(`/api/pages/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  floorplan: () => request('/api/floorplan'),
  saveFloorplan: (plan) => request('/api/floorplan', { method: 'PUT', body: plan }),
  actions: () => request('/api/actions'),
  saveAction: (action) => saveConfig('/api/actions', action),
  deleteAction: (id) => request(`/api/actions/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  runAction: (id) => request(`/api/actions/${encodeURIComponent(id)}/run`, { method: 'POST' }),
  setDevice: (id, values) => request(`/api/devices/${encodeURIComponent(id)}/set`, { method: 'POST', body: values }),
};

function saveConfig(path, body) {
  return body.id
    ? request(`${path}/${encodeURIComponent(body.id)}`, { method: 'PATCH', body })
    : request(path, { method: 'POST', body });
}
