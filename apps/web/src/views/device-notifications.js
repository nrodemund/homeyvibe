import { api } from '../api.js';
import { h, onSubmit } from '../ui.js';

/** Choose which devices send background alerts to this installed app or browser. */
export async function openDeviceNotifications() {
  const [settings, devices] = await Promise.all([api.notifications(), api.devices()]);
  const error = h('p.form-error', { role: 'alert' });
  const status = h('p.muted', { role: 'status' });
  const all = h('input', { type: 'checkbox', checked: settings.all, onchange: () => { choices.hidden = all.checked; } });
  const readings = h('input', { type: 'checkbox', checked: settings.readings });
  const choices = h('fieldset.settings-fields', { hidden: settings.all }, h('legend', {}, 'Devices'),
    devices.map((device) => h('label.row', {}, h('input', {
      type: 'checkbox', name: 'device', value: device.id, checked: settings.devices.includes(device.id),
    }), device.name)));
  const form = h('form.settings-fields', {}, h('label.row', {}, all, 'All visible devices'), choices,
    h('label.row', {}, readings, 'Include numeric reading changes'),
    status, error, h('div.row', {}, h('button.primary', { type: 'submit' }, 'Save and enable'),
      h('button', { type: 'button', onclick: disable }, 'Turn off here')));
  const dialog = h('dialog.panel.wide', { 'aria-label': 'Notifications' },
    h('header', {}, h('h2', {}, 'Notifications'), h('button.icon-button', {
      type: 'button', 'aria-label': 'Close', onclick: () => dialog.close(),
    }, '✕')),
    h('p.muted', {}, 'Get alerts for device activity such as a door opening, a button press, or a command.'),
    form);
  const show = (enabled) => { status.textContent = enabled ? 'Enabled on this device.' : 'Turned off on this device.'; };
  show(settings.enabled);

  async function disable() {
    try {
      await api.stopNotifications();
      const registration = await navigator.serviceWorker?.getRegistration();
      if (registration) await (await registration.pushManager.getSubscription())?.unsubscribe();
      show(false);
    } catch (err) { error.textContent = err.message; }
  }

  onSubmit(form, async () => {
    if (!('PushManager' in window) || !('Notification' in window)) {
      throw new Error('Open the HTTPS app in a browser that supports Web Push. On iPhone, add it to the Home Screen first.');
    }
    if (await Notification.requestPermission() !== 'granted') throw new Error('Allow notifications in this device’s browser settings.');
    const registration = await navigator.serviceWorker.getRegistration();
    if (!registration) throw new Error('Reload the installed HTTPS app and try again.');
    const subscription = await registration.pushManager.getSubscription() ??
      await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: settings.publicKey });
    await api.saveNotifications({
      all: all.checked, devices: new FormData(form).getAll('device'), readings: readings.checked, subscription: subscription.toJSON(),
    });
    show(true);
  });
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}
