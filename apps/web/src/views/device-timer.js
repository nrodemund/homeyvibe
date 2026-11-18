import { api } from '../api.js';
import { h, onSubmit } from '../ui.js';
import { field } from './auth.js';

/** Configure automatic shutoff for a command that turns a binary capability on. */
export function timerField(target, device) {
  const active = device?.capabilities.filter((cap) => cap.type === 'binary' && cap.writable &&
    cap.valueOn !== undefined && cap.valueOff !== undefined && Object.hasOwn(target.values, cap.property) &&
    target.values[cap.property] === cap.valueOn) ?? [];
  if (!active.length) {
    delete target.timer;
    return null;
  }
  const input = h('input', {
    type: 'number', min: 1 / 60, max: 10080, step: 'any', value: target.timer ? target.timer.seconds / 60 : '',
    placeholder: 'Off', oninput: (e) => {
      if (!e.target.value) delete target.timer;
      else target.timer = { seconds: Math.round(e.target.valueAsNumber * 60),
        values: Object.fromEntries(active.map((cap) => [cap.property, cap.valueOff])) };
    },
  });
  if (target.timer) target.timer.values = Object.fromEntries(active.map((cap) => [cap.property, cap.valueOff]));
  return field('Turn off after (minutes)', input);
}

export function timerLabel(timer, now = Date.now()) {
  if (timer.retrying) return 'Waiting to turn off';
  const total = Math.max(0, Math.ceil((timer.expiresAt - now) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total / 60) % 60;
  return `Off in ${hours ? `${hours}h ` : ''}${minutes ? `${minutes}m` : hours ? '' : `${total % 60}s`}`.trim();
}

/** Edit a live timer without repeating the original command. */
export function openTimer(device, timer) {
  const remaining = Math.max(1, Math.ceil((timer.expiresAt - Date.now()) / 60_000));
  const error = h('p.form-error', { role: 'alert' });
  const form = h('form.settings-fields', {}, field('Minutes from now',
    h('input', { name: 'minutes', type: 'number', min: 1, max: 10080, value: remaining, required: true })), error,
    h('div.row', {},
      h('button.primary', { type: 'submit' }, 'Update timer'),
      h('button', { type: 'button', onclick: async () => {
        try { await api.changeTimer(device.id, null); dialog.close(); }
        catch (err) { error.textContent = err.message; }
      } }, 'Cancel shutoff')));
  const dialog = h('dialog.panel', { 'aria-label': `${device.name} timer` }, h('header', {}, h('h2', {}, device.name),
    h('button.icon-button', { type: 'button', 'aria-label': 'Close', onclick: () => dialog.close() }, '✕')), form);
  onSubmit(form, async ({ minutes }) => { await api.changeTimer(device.id, Number(minutes) * 60); dialog.close(); });
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}
