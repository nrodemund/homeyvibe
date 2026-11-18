import { api, ApiError } from '../api.js';
import { h } from '../ui.js';
import { field } from './auth.js';
import { createClientChat, deviceKey } from '../ai/client-chat.js';

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
  let mode = null; // 'device', 'claude' (server) or 'openai' (server)
  const local = createClientChat();
  const modeNote = h('span.chat-mode');

  const log = h('div.chat-log', { role: 'log', 'aria-live': 'polite' });
  const input = h('textarea', { name: 'message', rows: 1, placeholder: 'Ask HomeyVibe…', maxLength: 4000, required: true });
  const sendButton = h('button.primary', { type: 'submit', 'aria-label': 'Send' }, '↑');
  const form = h('form.chat-input', {}, input, sendButton);
  const body = h('div.chat-body', {});
  const panel = h('section.chat-panel', { hidden: true, 'aria-label': 'HomeyVibe assistant' },
    h('header', {},
      h('div', {}, h('h2', {}, 'Assistant'), modeNote),
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
    if (deviceKey.get()) return useMode('device');
    const status = await api.aiSettings().catch(() => ({ configured: false }));
    if (status.configured) useMode(status.provider ?? 'claude');
    else showSetup();
  }

  function useMode(next) {
    if (mode !== next) {
      mode = next;
      conversationId = null;
      log.replaceChildren();
    }
    const provider = mode === 'openai' ? 'OpenAI' : 'Claude';
    modeNote.textContent = mode === 'device' ? 'Claude · API called from this device' : `${provider} · API called from the server`;
    modeNote.title = mode === 'device'
      ? 'Claude is called from this device with the key saved here; your HomeyVibe server only runs the tools.'
      : `Your HomeyVibe server calls ${provider} with its project key.`;
    showChat();
  }

  function showChat() {
    if (!body.contains(log)) body.replaceChildren(log, form);
    if (!log.children.length) renderWelcome();
    input.focus();
  }

  function showSetup(message = null) {
    modeNote.textContent = '';
    const input = h('input', { name: 'apiKey', type: 'password', placeholder: 'sk-ant-…', required: true, autocomplete: 'off' });
    const error = h('p.form-error', { role: 'alert' }, message ?? '');
    const onServer = canConfigure
      ? h('button.link-button', {
        type: 'button',
        onclick: async () => {
          error.textContent = '';
          try {
            await api.updateAiSettings({ provider: 'claude', apiKey: input.value.trim() });
            deviceKey.clear();
            useMode('claude');
          } catch (err) {
            error.textContent = err.message;
          }
        },
      }, 'Store it on the server for everyone instead')
      : null;
    const setup = h('form.chat-setup', {},
      h('p', {}, 'Add a Claude API key for this browser. Admins can also enable OpenAI or Claude in Set up with AI → Shared assistant.'),
      field('Claude API key', input),
      h('p.muted', {}, h('a', { href: 'https://platform.claude.com/settings/keys', target: '_blank', rel: 'noopener' }, 'Get a key from the Claude Console')),
      error,
      h('button.primary', { type: 'submit' }, 'Save on this device'),
      onServer,
    );
    setup.addEventListener('submit', (e) => {
      e.preventDefault();
      try {
        deviceKey.set(input.value);
        useMode('device');
      } catch (err) {
        error.textContent = err.message;
      }
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
    if (conversationId && mode === 'device') local.forget(conversationId);
    else if (conversationId) api.forgetChat(conversationId).catch(() => {});
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

    const handle = (event, data) => {
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
    };

    try {
      if (mode === 'device') {
        await local.send({ apiKey: deviceKey.get(), conversationId, message: text, emit: handle });
      } else {
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
        for await (const { event, data } of readEvents(res)) handle(event, data);
      }
      if (reply.classList.contains('thinking')) reply.remove();
    } catch (err) {
      if (reply.classList.contains('thinking')) reply.remove();
      bubble('error', err.message);
      if (err instanceof ApiError && err.status === 409) showSetup();
      if (mode === 'device' && /key on this device was rejected/.test(err.message)) {
        deviceKey.clear();
        showSetup(err.message);
      }
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
