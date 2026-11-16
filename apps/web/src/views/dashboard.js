import { controlKind, splitCapabilities, labelFor, formatValue, deviceIcon } from '../controls.js';
import { api, ApiError } from '../api.js';
import { h, toast } from '../ui.js';
import { openUsersDialog } from './users.js';
import { openAiDialog } from './ai.js';
import { createChat } from './chat.js';

const ICONS = {
  light: '💡', switch: '🔘', cover: '🪟', climate: '🌡️', lock: '🔒', fan: '🌀', sensor: '📟', device: '📦',
};

/**
 * Device dashboard. Returns a cleanup function.
 * @param {HTMLElement} root
 * @param {object} user signed-in user (with permissions)
 * @param {() => void} onSignedOut called when the session ends
 */
export function renderDashboard(root, user, onSignedOut) {
  const canControl = user.permissions.includes('devices:control');
  const devices = new Map();
  const app = root;
  app.innerHTML = `
    <header class="topbar">
      <h1>HomeyVibe</h1>
      <div class="row">
        <span class="conn" data-conn="connecting">Connecting…</span>
        <details class="menu">
          <summary></summary>
          <div class="menu-items"></div>
        </details>
      </div>
    </header>
    <nav class="tabs" aria-label="Pages"></nav>
    <main class="view" aria-live="polite"></main>
    <p class="empty" hidden>No devices yet. Pair a device in zigbee2mqtt, or start the server with <code>npm run demo</code>.</p>
  `;
  app.append(createChat(user));
  const view = app.querySelector('.view');
  const tabs = app.querySelector('.tabs');
  let pages = [];
  let actions = [];
  let controlSeq = 0;
  const conn = app.querySelector('.conn');
  const empty = app.querySelector('.empty');
  const menu = app.querySelector('.menu');
  menu.querySelector('summary').textContent = user.displayName;
  menu.querySelector('.menu-items').append(...[
    h('p.muted', {}, `@${user.username} · ${user.role}`),
    h('button', { type: 'button', onclick: () => { menu.open = false; openAiDialog(user).catch((e) => toast(e.message)); } }, 'Set up with AI'),
    user.permissions.includes('users:manage')
      ? h('button', { type: 'button', onclick: () => { menu.open = false; openUsersDialog(user).catch((e) => toast(e.message)); } }, 'People')
      : null,
    h('button', { type: 'button', onclick: async () => { await api.logout().catch(() => {}); stop(); onSignedOut(); } }, 'Sign out'),
  ].filter(Boolean));

  // ---- live connection -------------------------------------------------------

  let source;
  function connect() {
    source = new EventSource('/api/events');
    source.addEventListener('open', () => setConn('online', 'Live'));
    source.addEventListener('error', async () => {
      setConn('offline', 'Reconnecting…');
      try {
        await api.me();
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          stop();
          onSignedOut();
        }
      }
    });
    source.addEventListener('snapshot', async (e) => {
      devices.clear();
      for (const d of JSON.parse(e.data)) devices.set(d.id, d);
      [pages, actions] = await Promise.all([api.pages(), api.actions()]).catch(() => [pages, actions]);
      renderTabs();
      renderView();
    });
    source.addEventListener('device', (e) => {
      const d = JSON.parse(e.data);
      const isNew = !devices.has(d.id);
      devices.set(d.id, d);
      if (isNew) renderView();
      else for (const card of cardEls(d.id)) card.replaceWith(renderCard(d, card.dataset.properties ? card.dataset.properties.split(',') : null));
    });
    source.addEventListener('removed', (e) => {
      devices.delete(JSON.parse(e.data).id);
      renderView();
    });
    source.addEventListener('pages', (e) => {
      pages = JSON.parse(e.data);
      renderTabs();
      renderView();
    });
    source.addEventListener('actions', (e) => {
      actions = JSON.parse(e.data);
      renderView();
    });
    source.addEventListener('run', (e) => {
      const run = JSON.parse(e.data);
      if (!run.ok) toast(`${actionName(run.actionId)} failed: ${run.error}`);
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

  let stop = () => {
    source?.close();
  };

  async function send(id, values) {
    try {
      await api.setDevice(id, values);
    } catch (err) {
      toast(err.message);
    }
  }

  // ---- rendering -------------------------------------------------------------

  function cardEls(id) {
    return view.querySelectorAll(`[data-device="${CSS.escape(id)}"]`);
  }

  function currentPageId() {
    const m = /^#\/page\/(.+)$/.exec(location.hash);
    return m ? decodeURIComponent(m[1]) : null;
  }

  function renderTabs() {
    const current = currentPageId();
    const link = (href, label, active) => h('a', { href, 'aria-current': active ? 'page' : undefined }, label);
    tabs.replaceChildren(
      link('#/', 'All devices', !current || !pages.some((p) => p.id === current)),
      ...pages.map((p) => link(`#/page/${encodeURIComponent(p.id)}`, `${p.icon ? `${p.icon} ` : ''}${p.title}`, p.id === current)),
    );
    tabs.hidden = pages.length === 0;
  }

  function renderView() {
    const page = pages.find((p) => p.id === currentPageId());
    view.replaceChildren();
    empty.hidden = devices.size > 0;
    if (!page) {
      const enabled = actions.filter((a) => a.enabled);
      if (enabled.length) view.append(section('Actions', enabled.map(renderAction), 'actions'));
      const sorted = [...devices.values()].sort((a, b) => a.name.localeCompare(b.name));
      view.append(section(null, sorted.map((d) => renderCard(d))));
      return;
    }
    for (const sec of page.sections) {
      const items = sec.items.map((item) => {
        if (item.type === 'action') {
          const action = actions.find((a) => a.id === item.actionId);
          return action ? renderAction(action) : missing(`Action ${item.actionId} not found`);
        }
        const device = devices.get(item.deviceId);
        return device ? renderCard(device, item.properties ?? null) : missing(`Device ${item.deviceId} not found`);
      });
      const onlyActions = sec.items.length > 0 && sec.items.every((i) => i.type === 'action');
      view.append(section(sec.title, items, onlyActions ? 'actions' : 'devices'));
    }
    if (!page.sections.length) view.append(h('p.empty', {}, 'This page is empty.'));
  }

  function section(title, children, kind = 'devices') {
    return h('section.page-section', {},
      title ? h('h2.section-title', {}, title) : null,
      h(`div.grid.${kind}`, {}, children),
    );
  }

  function missing(text) {
    return h('article.card.missing', {}, h('p.muted', {}, text));
  }

  function actionName(id) {
    return actions.find((a) => a.id === id)?.name ?? id;
  }

  function renderAction(action) {
    const button = h('button.action', {
      type: 'button',
      disabled: !canControl,
      title: action.description ?? undefined,
      onclick: async () => {
        button.classList.add('running');
        try {
          const result = await api.runAction(action.id);
          if (!result.ok) toast(`${action.name} failed: ${result.error}`);
        } catch (err) {
          toast(err.message);
        } finally {
          button.classList.remove('running');
        }
      },
    }, h('span.action-icon', { 'aria-hidden': 'true' }, '▶'), action.name);
    return button;
  }

  /** @param {string[]|null} only limit the card to these capability properties */
  function renderCard(device, only = null) {
    const card = document.createElement('article');
    card.className = 'card';
    card.dataset.device = device.id;
    if (only) card.dataset.properties = only.join(',');
    card.classList.toggle('unavailable', device.available === false);

    const capabilities = only ? device.capabilities.filter((c) => only.includes(c.property)) : device.capabilities;
    const { primary, diagnostic } = splitCapabilities(capabilities);
    card.innerHTML = `
      <header>
        <span class="icon" aria-hidden="true">${ICONS[deviceIcon(device)]}</span>
        <div class="title">
          <h3></h3>
          <p class="meta"></p>
        </div>
      </header>
      <div class="caps"></div>
      ${diagnostic.length ? '<details><summary>Details</summary><div class="caps diag"></div></details>' : ''}
    `;
    card.querySelector('h3').textContent = device.name;
    card.querySelector('.meta').textContent =
      [device.vendor, device.model].filter(Boolean).join(' · ') + (device.available === false ? ' · offline' : '');

    const caps = card.querySelector('.caps');
    for (const cap of primary) caps.append(renderCap(device, cap));
    const diag = card.querySelector('.diag');
    for (const cap of diagnostic) diag.append(renderCap(device, cap));
    return card;
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
    const inputId = `c${++controlSeq}`;
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
    if (!canControl) for (const el of row.querySelectorAll('input, select, button')) el.disabled = true;
    return row;
  }

  /** Update only the changed controls, leaving one the user is dragging alone. */
  function updateValues(device, props) {
    for (const card of cardEls(device.id)) updateCard(card, device, props);
  }

  function updateCard(card, device, props) {
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

  const onHash = () => {
    renderTabs();
    renderView();
  };
  window.addEventListener('hashchange', onHash);
  const baseStop = stop;
  stop = () => {
    window.removeEventListener('hashchange', onHash);
    baseStop();
  };

  connect();
  return () => stop();
}
