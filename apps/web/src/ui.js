// Small DOM helpers shared by the views.

/** h('button.primary', { onclick }, 'Save') */
export function h(tag, props = {}, ...children) {
  const [name, ...classes] = tag.split('.');
  const el = document.createElement(name);
  if (classes.length) el.className = classes.join(' ');
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key in el && key !== 'list' && key !== 'role') el[key] = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

export function toast(message) {
  const el = h('div.toast', { role: 'alert' }, message);
  document.body.append(el);
  setTimeout(() => el.remove(), 4000);
}

/** Wire a form: disables while submitting, shows the error inline. */
export function onSubmit(form, handler) {
  const error = form.querySelector('.form-error');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const button = form.querySelector('button[type=submit]');
    button.disabled = true;
    if (error) error.textContent = '';
    try {
      await handler(Object.fromEntries(new FormData(form)));
    } catch (err) {
      if (error) error.textContent = err.message;
      else toast(err.message);
    } finally {
      button.disabled = false;
    }
  });
}
