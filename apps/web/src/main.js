import './style.css';
import { controlKind, splitCapabilities, labelFor, formatValue, deviceIcon } from './controls.js';

const ICONS = {
  light: '💡', switch: '🔘', cover: '🪟', climate: '🌡️', lock: '🔒', fan: '🌀', sensor: '📟', device: '📦',
};

const devices = new Map();
const app = document.querySelector('#app');
app.innerHTML = `
  <header class="topbar">
    <h1>HomeyVibe</h1>
    <span class="conn" data-conn="connecting">Connecting…</span>
  </header>
  <main class="grid" aria-live="polite"></main>
  <p class="empty" hidden>No devices yet. Pair a device in zigbee2mqtt, or start the server with <code>npm run demo</code>.</p>
`;
const grid = app.querySelector('.grid');
const conn = app.querySelector('.conn');
const empty = app.querySelector('.empty');

// ---- live connection -------------------------------------------------------

function connect() {
  const source = new EventSource('/api/events');
  source.addEventListener('open', () => setConn('online', 'Live'));
  source.addEventListener('error', () => setConn('offline', 'Reconnecting…'));
  source.addEventListener('snapshot', (e) => {
    devices.clear();
    for (const d of JSON.parse(e.data)) devices.set(d.id, d);
    renderAll();
  });
  source.addEventListener('device', (e) => {
    const d = JSON.parse(e.data);
    devices.set(d.id, d);
    renderCard(d);
    updateEmpty();
  });
  source.addEventListener('removed', (e) => {
    const { id } = JSON.parse(e.data);
    devices.delete(id);
    cardEl(id)?.remove();
    updateEmpty();
  });
  source.addEventListener('state', (e) => {
    const { id, changes } = JSON.parse(e.data);
    const d = devices.get(id);
    if (!d) return;
    d.state = { ...d.state, ...changes };
    updateValues(d, Object.keys(changes));
  });
}

function setConn(status, text) {
  conn.dataset.conn = status;
  conn.textContent = text;
}

async function send(id, values) {
  const res = await fetch(`/api/devices/${encodeURIComponent(id)}/set`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(values),
  });
  if (!res.ok) {
    const { error } = await res.json().catch(() => ({ error: res.statusText }));
    toast(error);
  }
}

// ---- rendering -------------------------------------------------------------

function cardEl(id) {
  return grid.querySelector(`[data-device="${CSS.escape(id)}"]`);
}

function renderAll() {
  grid.replaceChildren();
  const sorted = [...devices.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const d of sorted) renderCard(d);
  updateEmpty();
}

function updateEmpty() {
  empty.hidden = devices.size > 0;
}

function renderCard(device) {
  const card = document.createElement('article');
  card.className = 'card';
  card.dataset.device = device.id;
  card.classList.toggle('unavailable', device.available === false);

  const { primary, diagnostic } = splitCapabilities(device.capabilities);
  card.innerHTML = `
    <header>
      <span class="icon" aria-hidden="true">${ICONS[deviceIcon(device)]}</span>
      <div class="title">
        <h2></h2>
        <p class="meta"></p>
      </div>
    </header>
    <div class="caps"></div>
    ${diagnostic.length ? '<details><summary>Details</summary><div class="caps diag"></div></details>' : ''}
  `;
  card.querySelector('h2').textContent = device.name;
  card.querySelector('.meta').textContent =
    [device.vendor, device.model].filter(Boolean).join(' · ') + (device.available === false ? ' · offline' : '');

  const caps = card.querySelector('.caps');
  for (const cap of primary) caps.append(renderCap(device, cap));
  const diag = card.querySelector('.diag');
  for (const cap of diagnostic) diag.append(renderCap(device, cap));

  const existing = cardEl(device.id);
  if (existing) existing.replaceWith(card);
  else grid.append(card);
}

function renderCap(device, cap) {
  const row = document.createElement('div');
  row.className = 'cap';
  row.dataset.prop = cap.property;
  const kind = controlKind(cap);
  const label = document.createElement('label');
  label.textContent = labelFor(cap);
  row.append(label);
  const value = device.state[cap.property];
  const inputId = `${device.id}:${cap.property}`;
  label.htmlFor = inputId;

  switch (kind) {
    case 'toggle': {
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.role = 'switch';
      input.className = 'toggle';
      input.id = inputId;
      input.checked = value === cap.valueOn;
      input.addEventListener('change', () => send(device.id, { [cap.property]: input.checked ? cap.valueOn : cap.valueOff }));
      row.append(input);
      break;
    }
    case 'slider': {
      const wrap = document.createElement('div');
      wrap.className = 'slider';
      const input = document.createElement('input');
      input.type = 'range';
      input.id = inputId;
      input.min = cap.min;
      input.max = cap.max;
      input.step = cap.step ?? 1;
      input.value = value ?? cap.min;
      const out = document.createElement('output');
      out.textContent = formatValue(cap, value);
      input.addEventListener('input', () => (out.textContent = formatValue(cap, Number(input.value))));
      input.addEventListener('change', () => send(device.id, { [cap.property]: Number(input.value) }));
      wrap.append(input, out);
      row.append(wrap);
      break;
    }
    case 'buttons': {
      const group = document.createElement('div');
      group.className = 'buttons';
      group.role = 'group';
      for (const v of cap.values) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = v.charAt(0) + v.slice(1).toLowerCase();
        b.dataset.value = v;
        b.setAttribute('aria-pressed', String(value === v));
        b.addEventListener('click', () => send(device.id, { [cap.property]: v }));
        group.append(b);
      }
      row.append(group);
      break;
    }
    case 'select': {
      const select = document.createElement('select');
      select.id = inputId;
      select.append(new Option('—', ''));
      for (const v of cap.values) select.append(new Option(v, v, false, value === v));
      select.addEventListener('change', () => select.value && send(device.id, { [cap.property]: select.value }));
      row.append(select);
      break;
    }
    case 'json':
    case 'value':
    default: {
      const out = document.createElement('output');
      out.id = inputId;
      out.className = 'value';
      out.textContent = formatValue(cap, value);
      row.append(out);
    }
  }
  return row;
}

/** Update only the changed controls, leaving one the user is dragging alone. */
function updateValues(device, props) {
  const card = cardEl(device.id);
  if (!card) return;
  for (const prop of props) {
    const row = card.querySelector(`[data-prop="${CSS.escape(prop)}"]`);
    const cap = device.capabilities.find((c) => c.property === prop);
    if (!row || !cap) continue;
    const value = device.state[prop];
    const input = row.querySelector('input, select');
    if (input && document.activeElement === input && input.type === 'range') continue;
    if (input?.type === 'checkbox') input.checked = value === cap.valueOn;
    else if (input?.type === 'range') {
      input.value = value;
      row.querySelector('output').textContent = formatValue(cap, value);
    } else if (input?.tagName === 'SELECT') input.value = value ?? '';
    else if (row.querySelector('.buttons')) {
      for (const b of row.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.value === value));
    } else {
      const out = row.querySelector('output');
      if (out) out.textContent = formatValue(cap, value);
    }
  }
}

function toast(message) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.role = 'alert';
  el.textContent = message;
  document.body.append(el);
  setTimeout(() => el.remove(), 4000);
}

connect();

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
