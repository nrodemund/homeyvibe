import { api, ApiError } from '../api.js';
import { h, onSubmit } from '../ui.js';
import { field } from './auth.js';

const SUGGESTIONS = [
  'Set up pages for my home',
  'Turn off all the lights',
  'Make a movie night scene',
  'Open the blinds every weekday at 7',
];

/** Floating chat with the built-in AI. Returns the root element to mount. */
export function createChat(user) {
  const canConfigure = user.permissions.includes('config:write');
  let conversationId = null;
  let busy = false;

  const log = h('div.chat-log', { role: 'log', 'aria-live': 'polite' });
  const input = h('textarea', { name: 'message', rows: 1, placeholder: 'Ask HomeyVibe…', maxLength: 4000, required: true });
  const sendButton = h('button.primary', { type: 'submit', 'aria-label': 'Send' }, '↑');
  const form = h('form.chat-input', {}, input, sendButton);
  const body = h('div.chat-body', {});
  const panel = h('section.chat-panel', { hidden: true, 'aria-label': 'HomeyVibe assistant' },
    h('header', {},
      h('h2', {}, 'Assistant'),
      h('div.row', {},
        h('button.icon-button', { type: 'button', onclick: () => newChat() }, 'New chat'),
        h('button.icon-button', { type: 'button', 'aria-label': 'Close', onclick: () => toggle(false) }, '✕'),
      ),
    ),
    body,
  );
  const fab = h('button.chat-fab', { type: 'button', 'aria-label': 'Open assistant', onclick: () => toggle(true) }, '✦');
  const root = h('div.chat', {}, fab, panel);

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      form.requestSubmit();
    }
  });
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (text && !busy) send(text);
  });

  async function toggle(open) {
    panel.hidden = !open;
    fab.hidden = open;
    if (!open) return;
    const status = await api.aiSettings().catch(() => ({ configured: false }));
    if (status.configured) showChat();
    else showSetup();
  }

  function showChat() {
    if (!body.contains(log)) body.replaceChildren(log, form);
    if (!log.children.length) renderWelcome();
    input.focus();
  }

  function showSetup() {
    if (!canConfigure) {
      body.replaceChildren(h('p.chat-note', {}, 'The assistant is not set up yet. Ask an admin to add a Claude API key under Set up with AI.'));
      return;
    }
    const setup = h('form.chat-setup', {},
      h('p', {}, 'To use the built-in assistant, add a Claude API key. It stays on your HomeyVibe server and is used for everyone in the home.'),
      field('Claude API key', h('input', { name: 'apiKey', type: 'password', placeholder: 'sk-ant-…', required: true, autocomplete: 'off' })),
      h('p.muted', {}, h('a', { href: 'https://platform.claude.com/settings/keys', target: '_blank', rel: 'noopener' }, 'Get a key from the Claude Console')),
      h('p.form-error', { role: 'alert' }),
      h('button.primary', { type: 'submit' }, 'Save and start'),
    );
    onSubmit(setup, async ({ apiKey }) => {
      await api.updateAiSettings({ apiKey });
      showChat();
    });
    body.replaceChildren(setup);
  }

  function renderWelcome() {
    log.append(h('div.chat-welcome', {},
      h('p', {}, `Hi ${user.displayName}! I can control your devices and set up pages and actions for you.`),
      h('div.chat-suggestions', {}, SUGGESTIONS.map((s) => h('button', { type: 'button', onclick: () => send(s) }, s))),
    ));
  }

  function newChat() {
    if (conversationId) api.forgetChat(conversationId).catch(() => {});
    conversationId = null;
    log.replaceChildren();
    renderWelcome();
  }

  function bubble(role, text = '') {
    const el = h(`div.msg.${role}`, {}, text);
    log.append(el);
    log.scrollTop = log.scrollHeight;
    return el;
  }

  async function send(text) {
    busy = true;
    sendButton.disabled = true;
    input.value = '';
    input.style.height = 'auto';
    log.querySelector('.chat-welcome')?.remove();
    bubble('user', text);
    let reply = bubble('assistant thinking');
    let replyText = '';
    try {
      const res = await fetch('/api/ai/chat', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: text, conversationId }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new ApiError(res.status, data.error ?? res.statusText);
      }
      for await (const { event, data } of readEvents(res)) {
        if (event === 'start' || event === 'done') conversationId = data.conversationId;
        else if (event === 'text') {
          if (reply.classList.contains('tool')) {
            reply = bubble('assistant');
            replyText = '';
          }
          reply.classList.remove('thinking');
          replyText += data.delta;
          reply.textContent = replyText;
        } else if (event === 'tool') {
          if (reply.classList.contains('thinking')) reply.remove();
          reply = bubble('assistant tool', `${data.title}…`);
          reply.dataset.tool = data.name;
        } else if (event === 'tool_result') {
          const chip = [...log.querySelectorAll(`.msg.tool[data-tool="${CSS.escape(data.name)}"]:not(.finished)`)].at(-1);
          if (chip) {
            chip.classList.add('finished', data.ok ? 'ok' : 'failed');
            chip.textContent = `${chip.textContent.replace(/…$/, '')} ${data.ok ? '✓' : '✕'}`;
          }
        } else if (event === 'error') {
          bubble('error', data.message);
        }
        log.scrollTop = log.scrollHeight;
      }
      if (reply.classList.contains('thinking')) reply.remove();
    } catch (err) {
      reply.remove();
      bubble('error', err.message);
      if (err instanceof ApiError && err.status === 409) showSetup();
    } finally {
      busy = false;
      sendButton.disabled = false;
      input.focus();
    }
  }

  return root;
}

/** Parse a Server-Sent Events response body. */
export async function* readEvents(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const event = /^event: (.*)$/m.exec(block)?.[1];
      const data = /^data: (.*)$/m.exec(block)?.[1];
      if (event && data) yield { event, data: JSON.parse(data) };
    }
  }
}
