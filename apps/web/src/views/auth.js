import { api } from '../api.js';
import { h, onSubmit } from '../ui.js';

/** First-run screen: create the admin account. Resolves with the signed-in user. */
export function renderSetup(root) {
  return new Promise((resolve) => {
    const form = h('form.auth-card', {},
      h('h1', {}, 'Welcome to HomeyVibe'),
      h('p.muted', {}, 'Create the admin account. You can add the rest of the household afterwards.'),
      field('Your name', h('input', { name: 'displayName', autocomplete: 'name', placeholder: 'Optional' })),
      field('Username', h('input', { name: 'username', autocomplete: 'username', required: true, minLength: 2, maxLength: 32 })),
      field('Password', h('input', { name: 'password', type: 'password', autocomplete: 'new-password', required: true, minLength: 8 })),
      h('p.form-error', { role: 'alert' }),
      h('button.primary', { type: 'submit' }, 'Create account'),
    );
    onSubmit(form, async (values) => resolve((await api.setup(values)).user));
    root.replaceChildren(h('main.auth', {}, form));
    form.querySelector('input').focus();
  });
}

/** Sign-in screen. Resolves with the signed-in user. */
export function renderLogin(root) {
  return new Promise((resolve) => {
    const form = h('form.auth-card', {},
      h('h1', {}, 'HomeyVibe'),
      field('Username', h('input', { name: 'username', autocomplete: 'username', required: true })),
      field('Password', h('input', { name: 'password', type: 'password', autocomplete: 'current-password', required: true })),
      h('p.form-error', { role: 'alert' }),
      h('button.primary', { type: 'submit' }, 'Sign in'),
    );
    onSubmit(form, async ({ username, password }) => resolve((await api.login(username, password)).user));
    root.replaceChildren(h('main.auth', {}, form));
    form.querySelector('input').focus();
  });
}

export function field(label, input) {
  return h('label.field', {}, h('span', {}, label), input);
}
