import { api } from '../api.js';
import { h, onSubmit } from '../ui.js';
import { field } from './auth.js';

/** Connection settings and live diagnostics for the Zigbee2MQTT integration. */
export async function openZigbeeDialog() {
  const initial = await api.zigbee();
  const phase = h('strong');
  const message = h('p.muted');
  const detail = h('p.muted');
  const source = h('p.muted');
  const error = h('p.form-error', { role: 'alert' });
  const mode = h('select', { name: 'mode', onchange: syncMode },
    new Option('Find a local broker', 'auto'),
    new Option('Enter a broker address', 'manual'),
    new Option('Disabled', 'disabled'),
  );
  const url = h('input', { name: 'url', type: 'url', maxLength: 512, placeholder: 'mqtt://192.168.1.20:1883', required: true });
  const username = h('input', { name: 'username', maxLength: 256, autocomplete: 'off' });
  const password = h('input', { name: 'password', type: 'password', maxLength: 1024, autocomplete: 'new-password' });
  const clear = h('input', { name: 'clear', type: 'checkbox' });
  const manual = h('fieldset.settings-fields', {},
    field('Broker URL', url),
    h('p.muted', {}, 'Use the MQTT server from Zigbee2MQTT’s settings. In Docker, use the Pi’s LAN address, a shared Docker service name, or host.docker.internal for a broker listening on the host.'),
    field('MQTT username', username),
    field('MQTT password', password),
    h('label.row', {}, clear, 'Remove saved password'),
  );
  const base = h('input', { name: 'baseTopic', maxLength: 256, placeholder: 'Auto-detect (e.g. zigbee2mqtt)' });
  const reset = h('button', { type: 'button', onclick: () => refreshWith(api.resetZigbee, true) }, 'Restore deployment defaults');
  const retry = h('button', { type: 'button', onclick: () => refreshWith(api.retryZigbee) }, 'Retry discovery');
  const form = h('form.settings-fields', {},
    field('Connection', mode), manual,
    field('Zigbee2MQTT base topic', base),
    h('p.muted', {}, 'Leave blank to detect a single-level topic automatically. Enter the exact topic for nested topics or restricted MQTT accounts.'),
    error,
    h('div.row', {}, h('button.primary', { type: 'submit' }, 'Save and connect'), retry, reset),
  );
  const dialog = h('dialog.panel.wide', { 'aria-labelledby': 'zigbee-title' },
    h('header', {}, h('h2', { id: 'zigbee-title' }, 'Zigbee2MQTT'),
      h('button.icon-button', { type: 'button', 'aria-label': 'Close', onclick: () => dialog.close() }, '✕')),
    h('div.ai-block', { role: 'status' }, phase, message, detail),
    source, form,
  );
  let requestVersion = 0;
  let busy = false;

  function syncMode() {
    manual.hidden = mode.value !== 'manual';
    manual.disabled = manual.hidden;
    base.disabled = mode.value === 'disabled';
  }

  function renderStatus(status) {
    phase.textContent = {
      disabled: 'Disabled', connecting: 'Connecting to MQTT',
      waiting: 'MQTT connected · waiting for Zigbee2MQTT', ready: 'Zigbee2MQTT catalog received',
      'bridge-offline': 'Zigbee2MQTT offline', 'multiple-bridges': 'Multiple Zigbee2MQTT topics',
      'subscription-denied': 'MQTT subscription denied', 'connection-error': 'MQTT unavailable',
      'auth-error': 'MQTT authentication failed', 'tls-error': 'MQTT TLS failed',
    }[status.phase] ?? 'Zigbee2MQTT status';
    message.textContent = status.message;
    detail.textContent = [
      status.broker, status.detectedBase && `Topic: ${status.detectedBase}`,
      status.phase === 'ready' && `${status.deviceCount} paired device(s)`,
      status.phase === 'multiple-bridges' && status.candidates?.join(', '),
    ].filter(Boolean).join(' · ');
    source.textContent = status.source === 'settings' ? 'Using settings saved in HomeyVibe.' : 'Using deployment defaults.';
    reset.hidden = status.source !== 'settings';
  }

  function populate(status) {
    const s = status.settings;
    mode.value = s.mode;
    url.value = s.url;
    username.value = s.username;
    password.value = '';
    password.placeholder = s.hasPassword ? 'Saved for this broker and username' : 'Optional';
    clear.checked = false;
    clear.parentElement.hidden = !s.hasPassword;
    base.value = s.baseTopic;
    syncMode();
    renderStatus(status);
  }

  async function refreshWith(request, replaceForm = false) {
    if (busy) return;
    busy = true;
    requestVersion += 1;
    retry.disabled = reset.disabled = true;
    error.textContent = '';
    try {
      const status = await request();
      if (replaceForm) populate(status);
      else renderStatus(status);
    } catch (err) {
      error.textContent = err.message;
    } finally {
      busy = false;
      retry.disabled = reset.disabled = false;
    }
  }

  onSubmit(form, (input) => refreshWith(() => api.saveZigbee({
    mode: input.mode, url: input.url, username: input.username, baseTopic: input.baseTopic ?? base.value,
    password: input.clear ? null : input.password || undefined,
  }), true));
  populate(initial);
  const poll = setInterval(async () => {
    if (busy) return;
    const version = ++requestVersion;
    try {
      const status = await api.zigbee();
      if (version === requestVersion) renderStatus(status);
    } catch (err) {
      if (version === requestVersion) message.textContent = err.message;
    }
  }, 2000);
  dialog.addEventListener('close', () => { clearInterval(poll); dialog.remove(); });
  document.body.append(dialog);
  dialog.showModal();
}
