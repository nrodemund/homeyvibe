import { api } from '../api.js';
import { h, onSubmit, toast } from '../ui.js';
import { field } from './auth.js';
import { openLimitsDialog } from './limits.js';
import { summarize } from '../limits.js';

/** Modal for admins: list users, change roles and limits, add and remove people, and set the AI's limits. */
export async function openUsersDialog(currentUser) {
  const [roles, users, initialAccess] = await Promise.all([api.roles(), api.users(), api.access()]);
  let access = initialAccess;
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

  function aiSummary() {
    const parts = [];
    if (access.ai.canControl === false) parts.push('look only');
    if (access.ai.canConfigure === false) parts.push('no setup changes');
    const s = summarize(access.ai);
    if (s !== 'No limits') parts.push(s);
    return parts.length ? parts.join(' · ') : 'Same as the person using it';
  }

  function limitsButton(label, open) {
    return h('button.icon-button', { type: 'button', 'aria-label': label, onclick: () => open().catch((e) => toast(e.message)) }, 'Limits');
  }

  function renderList() {
    const aiItem = h('li.ai-user', {},
      h('div', {},
        h('strong', {}, '✦ HomeyVibe AI'),
        h('span.muted', {}, ` ${aiSummary()}`),
      ),
      h('div.row', {}, limitsButton('Limits for the HomeyVibe AI', () => openLimitsDialog({
        title: 'HomeyVibe AI',
        limits: access.ai,
        isAi: true,
        onSave: async (limits) => {
          access = { ...access, ai: await api.setAiAccess(limits) };
          renderList();
        },
      }))),
    );
    list.replaceChildren(aiItem, ...users.map((user) => {
      const select = h('select', {
        'aria-label': `Role for ${user.displayName}`,
        disabled: user.id === currentUser.id,
        onchange: async () => {
          try {
            Object.assign(user, await api.updateUser(user.id, { role: select.value }));
            renderList();
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
      const userLimits = access.users[user.id];
      const limits = user.role === 'admin' ? null : limitsButton(`Limits for ${user.displayName}`, () => openLimitsDialog({
        title: user.displayName,
        limits: userLimits ?? { default: 'control', devices: {} },
        isAi: false,
        onSave: async (next) => {
          const saved = await api.setUserAccess(user.id, next);
          access = { ...access, users: { ...access.users, [user.id]: saved } };
          renderList();
        },
      }));
      const limited = user.role !== 'admin' && userLimits && summarize(userLimits) !== 'No limits';
      return h('li', {},
        h('div', {},
          h('strong', {}, user.displayName),
          h('span.muted', {}, ` @${user.username}${user.id === currentUser.id ? ' (you)' : ''}`),
          limited ? h('p.limit-note', {}, summarize(userLimits)) : null,
        ),
        h('div.row', {}, select, limits, remove),
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
