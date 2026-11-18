import { api } from '../api.js';
import { h, onSubmit } from '../ui.js';
import { field } from './auth.js';

/** Ask for the configured approval and run the action with a one-time nonce. */
export async function runSavedAction(action) {
  if (!action) throw new Error('Action not found');
  const { id, security, name } = action;
  if (!security || security === 'none') return api.runAction(id);
  if (security === 'confirm' && !window.confirm(`Run “${name}”?`)) return null;
  if (security === 'passkey' && !window.PublicKeyCredential) throw new Error('Open HomeyVibe over HTTPS on a device with passkey support.');
  const { nonce, options } = await api.actionApproval(id);
  if (!nonce) throw new Error('The action settings changed. Try again.');
  let response;
  if (options) {
    const { startAuthentication } = await import('@simplewebauthn/browser');
    response = await startAuthentication({ optionsJSON: options });
  }
  return api.runAction(id, { nonce, response });
}

/** Register or remove this account's passkeys after checking the account password. */
export async function openPasskeys() {
  let keys = await api.passkeys();
  const list = h('div.settings-fields');
  const password = h('input', { type: 'password', name: 'password', required: true, autocomplete: 'current-password' });
  const remove = h('select', { name: 'id', hidden: true });
  const error = h('p.form-error', { role: 'alert' });
  const form = h('form.settings-fields', {}, field('Account password', password), remove,
    h('div.row', {}, h('button.primary', { type: 'submit', value: 'add' }, 'Add passkey'),
      h('button', { type: 'button', onclick: async () => {
        if (!remove.value || !password.reportValidity()) return;
        try {
          keys = await api.removePasskey(remove.value, password.value);
          password.value = '';
          render();
        } catch (err) { error.textContent = err.message; }
      } }, 'Remove selected passkey')), error);
  const dialog = h('dialog.panel.wide', { 'aria-label': 'Passkeys' },
    h('header', {}, h('h2', {}, 'Passkeys'), h('button.icon-button', {
      type: 'button', 'aria-label': 'Close', onclick: () => dialog.close(),
    }, '✕')),
    h('p.muted', {}, 'Verify protected actions with your device’s passkey, using fingerprint, face recognition, or its PIN.'),
    list, form);
  function render() {
    const options = keys.map((key) => new Option(
      `${key.rpId} · ${new Date(key.createdAt).toLocaleString()}`, key.id));
    remove.replaceChildren(...options);
    remove.hidden = !keys.length;
    remove.setAttribute('aria-label', 'Select a passkey to remove');
    list.textContent = keys.length ? '' : 'No passkeys registered.';
  }
  onSubmit(form, async (values) => {
    if (!window.PublicKeyCredential) throw new Error('Open HomeyVibe over HTTPS to register a passkey.');
    const { options, nonce } = await api.passkeyOptions(values.password);
    const { startRegistration } = await import('@simplewebauthn/browser');
    const response = await startRegistration({ optionsJSON: options });
    keys = await api.savePasskey({ nonce, response });
    password.value = '';
    render();
  });
  render();
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}
