import { api } from '../api.js';
import { h, onSubmit, toast } from '../ui.js';
import { field } from './auth.js';

/** Modal for admins: list users, change roles, add and remove people. */
export async function openUsersDialog(currentUser) {
  const [roles, users] = await Promise.all([api.roles(), api.users()]);
  const list = h('ul.user-list');
  const dialog = h('dialog.panel', { 'aria-labelledby': 'users-title' },
    h('header', {},
      h('h2', { id: 'users-title' }, 'People'),
      h('button.icon-button', { type: 'button', 'aria-label': 'Close', onclick: () => dialog.close() }, '✕'),
    ),
    list,
    addUserForm(roles, (user) => {
      users.push(user);
      renderList();
    }),
  );
  dialog.addEventListener('close', () => dialog.remove());

  function renderList() {
    list.replaceChildren(...users.map((user) => {
      const select = h('select', {
        'aria-label': `Role for ${user.displayName}`,
        disabled: user.id === currentUser.id,
        onchange: async () => {
          try {
            Object.assign(user, await api.updateUser(user.id, { role: select.value }));
          } catch (err) {
            select.value = user.role;
            toast(err.message);
          }
        },
      }, roles.map((r) => h('option', { value: r.id, selected: r.id === user.role }, r.label)));
      const remove = user.id === currentUser.id ? null : h('button.icon-button', {
        type: 'button',
        'aria-label': `Remove ${user.displayName}`,
        onclick: async () => {
          if (remove.dataset.confirm !== 'yes') {
            remove.dataset.confirm = 'yes';
            remove.textContent = 'Remove?';
            setTimeout(() => {
              remove.dataset.confirm = '';
              remove.textContent = '🗑';
            }, 3000);
            return;
          }
          try {
            await api.deleteUser(user.id);
            users.splice(users.indexOf(user), 1);
            renderList();
          } catch (err) {
            toast(err.message);
          }
        },
      }, '🗑');
      return h('li', {},
        h('div', {},
          h('strong', {}, user.displayName),
          h('span.muted', {}, ` @${user.username}${user.id === currentUser.id ? ' (you)' : ''}`),
        ),
        h('div.row', {}, select, remove),
      );
    }));
  }

  renderList();
  document.body.append(dialog);
  dialog.showModal();
}

function addUserForm(roles, onAdded) {
  const form = h('form.add-user', {},
    h('h3', {}, 'Add a person'),
    field('Name', h('input', { name: 'displayName', placeholder: 'Optional' })),
    field('Username', h('input', { name: 'username', required: true, minLength: 2, maxLength: 32, autocomplete: 'off' })),
    field('Password', h('input', { name: 'password', type: 'password', required: true, minLength: 8, autocomplete: 'new-password' })),
    field('Role', h('select', { name: 'role' },
      roles.map((r) => h('option', { value: r.id, defaultSelected: r.id === 'member' }, `${r.label}: ${r.description}`)))),
    h('p.form-error', { role: 'alert' }),
    h('button.primary', { type: 'submit' }, 'Add'),
  );
  onSubmit(form, async (values) => {
    onAdded(await api.createUser(values));
    form.reset();
  });
  return form;
}
