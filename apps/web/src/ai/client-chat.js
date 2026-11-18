// The assistant running on this device: Claude is called from the browser (or desktop app) with a key
// kept here, and only the tools run on the HomeyVibe server. So a small server, such as a Raspberry Pi,
// never does any AI work and does not need to reach the internet.

import { request } from '../api.js';

const KEY_STORAGE = 'homeyvibe.claudeApiKey';
const MAX_TURNS = 16;
const MAX_MESSAGE_CHARS = 4000;
const MAX_CONVERSATIONS = 10;

/** The Claude API key saved in this browser, if any. Storage can be blocked, so every access is guarded. */
export const deviceKey = {
  get() {
    try {
      return localStorage.getItem(KEY_STORAGE);
    } catch {
      return null;
    }
  },
  set(key) {
    const value = String(key ?? '').trim();
    if (!value.startsWith('sk-ant-') || value.length > 300) throw new Error('That does not look like a Claude API key (it starts with sk-ant-)');
    try {
      localStorage.setItem(KEY_STORAGE, value);
    } catch {
      throw new Error('This browser does not allow saving the key. Try another browser, or store the key on the server.');
    }
  },
  clear() {
    try {
      localStorage.removeItem(KEY_STORAGE);
    } catch {
      // nothing saved
    }
  },
  hint() {
    const key = this.get();
    return key ? `…${key.slice(-4)}` : null;
  },
};

/** Works on plain http too, where crypto.randomUUID is not available. */
const newId = () => globalThis.crypto?.randomUUID?.() ?? `c${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;

async function defaultClient(apiKey) {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  return new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
}

/**
 * @param {object} [opts]
 * @param {() => Promise<object>} [opts.loadKit] GET /api/ai/tools
 * @param {(name: string, input: object) => Promise<{ok: boolean, text: string}>} [opts.runTool]
 * @param {(apiKey: string) => Promise<object>} [opts.createClient] Anthropic client factory (tests pass a fake)
 */
export function createClientChat({
  loadKit = () => request('/api/ai/tools'),
  runTool = (name, input) => request(`/api/ai/tools/${encodeURIComponent(name)}`, { method: 'POST', body: input ?? {} }),
  createClient = defaultClient,
} = {}) {
  const conversations = new Map(); // id -> messages (kept as returned, thinking blocks included)

  /**
   * Run one user turn. `emit(event, data)` gets the same events as the server-side chat:
   * start, text, tool, tool_result, done, error.
   */
  async function send({ apiKey, conversationId, message, emit, signal }) {
    const text = String(message ?? '').trim();
    if (!text) throw new Error('Say something first');
    if (text.length > MAX_MESSAGE_CHARS) throw new Error(`Keep messages under ${MAX_MESSAGE_CHARS} characters`);
    if (!apiKey) throw new Error('Add a Claude API key first');

    const [kit, client] = await Promise.all([loadKit(), createClient(apiKey)]);
    const titles = new Map(kit.tools.map((t) => [t.name, t.title]));
    const tools = kit.tools.map(({ title, ...t }) => ({ ...t, eager_input_streaming: true }));

    let id = conversationId && conversations.has(conversationId) ? conversationId : null;
    if (!id) {
      id = newId();
      if (conversations.size >= MAX_CONVERSATIONS) conversations.delete(conversations.keys().next().value);
    }
    const messages = [...(conversations.get(id) ?? []), { role: 'user', content: text }];
    emit('start', { conversationId: id });

    let jsonRetries = 0;
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const stream = client.beta.messages.stream({
        model: kit.model,
        max_tokens: 64000,
        output_config: { effort: 'medium' },
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        system: kit.system,
        tools,
        messages,
      }, { signal });
      stream.on('text', (delta) => emit('text', { delta }));

      let reply;
      try {
        reply = await stream.finalMessage();
        jsonRetries = 0;
      } catch (err) {
        const { APIError } = await import('@anthropic-ai/sdk');
        if (err instanceof APIError || signal?.aborted || jsonRetries++ >= 2) throw await friendlyError(err);
        continue; // a streamed tool input could not be parsed; ask again
      }

      messages.push({ role: 'assistant', content: reply.content });
      if (reply.stop_reason === 'refusal') {
        emit('error', { message: 'Claude declined to help with that request.' });
        break;
      }
      if (reply.stop_reason === 'pause_turn') continue;
      const toolUses = reply.content.filter((b) => b.type === 'tool_use');
      // A tool input cut off at max_tokens can parse as a valid partial object; never run it.
      if (reply.stop_reason === 'max_tokens' && toolUses.length) throw new Error('The reply was cut off. Try a smaller request.');
      if (reply.stop_reason !== 'tool_use' || !toolUses.length) break;

      // The server validates each input and applies the person's and the AI's permissions and limits.
      const results = await Promise.all(toolUses.map(async (use) => {
        emit('tool', { name: use.name, title: titles.get(use.name) ?? use.name });
        let result;
        try {
          result = await runTool(use.name, use.input);
        } catch (err) {
          result = { ok: false, text: err.message };
        }
        emit('tool_result', { name: use.name, ok: result.ok });
        return { type: 'tool_result', tool_use_id: use.id, content: result.text, ...(result.ok ? {} : { is_error: true }) };
      }));
      messages.push({ role: 'user', content: results });
    }

    conversations.set(id, messages);
    emit('done', { conversationId: id });
    return { conversationId: id };
  }

  return {
    send,
    forget: (id) => conversations.delete(id),
    history: (id) => conversations.get(id),
  };
}

/** Turn SDK errors into messages a person can act on. */
export async function friendlyError(err) {
  const sdk = await import('@anthropic-ai/sdk');
  if (err instanceof sdk.AuthenticationError) return new Error('The Claude API key on this device was rejected. Check it in the assistant.');
  if (err instanceof sdk.PermissionDeniedError) return new Error('This Claude API key is not allowed to use that model.');
  if (err instanceof sdk.RateLimitError) return new Error('Claude is busy or the usage limit was reached. Try again in a moment.');
  if (err instanceof sdk.APIUserAbortError) return new Error('Stopped.');
  if (err instanceof sdk.APIConnectionError) return new Error('Could not reach Claude from this device. Check its internet connection.');
  if (err instanceof sdk.APIError) return new Error(`Claude API error: ${err.message}`);
  return err instanceof Error ? err : new Error(String(err));
}
