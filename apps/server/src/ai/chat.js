import { randomUUID } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { HttpError } from '../http/errors.js';
import { homeTools, TOOL_GUIDE } from './tools.js';

export const DEFAULT_MODEL = 'claude-opus-5-5';
const MAX_TURNS = 16;
const MAX_CONVERSATIONS_PER_USER = 10;
const CONVERSATION_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_MESSAGE_CHARS = 4000;

const SYSTEM_PROMPT = `You are the assistant built into HomeyVibe, a smart home app. People talk to you to control their home and to set it up: finding devices, building dashboard pages, and creating actions (scenes and automations).

Keep replies short and friendly, in plain language; the person may be on a phone. Say what you did, not how. Use the tools to look things up rather than guessing, and use the person's names for rooms and devices.

Turning things on or off, dimming, and running an action: just do it. Before deleting anything, or before creating or changing more than a couple of pages or actions at once, describe the plan in a few lines and wait for the person to confirm.

${TOOL_GUIDE}`;

/**
 * API key and model for the in-app chat. The key comes from settings (set by an admin in the app)
 * or the ANTHROPIC_API_KEY environment variable; it is never sent back to clients.
 */
export class AiSettings {
  constructor({ store, env = process.env }) {
    this.store = store;
    this.env = env;
  }

  #read() {
    return this.store.read('ai-settings', {});
  }

  apiKey() {
    return this.#read().apiKey || this.env.ANTHROPIC_API_KEY || null;
  }

  model() {
    return this.#read().model || DEFAULT_MODEL;
  }

  status() {
    const saved = this.#read();
    return {
      configured: Boolean(this.apiKey()),
      source: saved.apiKey ? 'settings' : this.env.ANTHROPIC_API_KEY ? 'environment' : null,
      keyHint: saved.apiKey ? `…${saved.apiKey.slice(-4)}` : null,
      model: this.model(),
    };
  }

  update({ apiKey, model }) {
    const next = { ...this.#read() };
    if (apiKey !== undefined) {
      if (apiKey === null || apiKey === '') delete next.apiKey;
      else if (typeof apiKey !== 'string' || !apiKey.startsWith('sk-ant-') || apiKey.length > 300) {
        throw new HttpError(400, 'That does not look like a Claude API key (it starts with sk-ant-)');
      } else next.apiKey = apiKey.trim();
    }
    if (model !== undefined) {
      if (model === null || model === '') delete next.model;
      else if (typeof model !== 'string' || !/^claude-[a-z0-9.-]+$/.test(model)) throw new HttpError(400, 'Invalid model id');
      else next.model = model;
    }
    this.store.write('ai-settings', next);
    return this.status();
  }
}

/**
 * In-app chat: a Claude tool-use loop over the same tools the MCP server offers,
 * with each tool checked against the signed-in user's permissions.
 * Conversations live in memory (they hold thinking blocks that must be sent back unchanged).
 */
export class ChatService {
  #conversations = new Map(); // userId -> Map(conversationId -> { messages, updatedAt })

  constructor({ settings, registry, pages, actions, engine, floorplan = null, access = null, createClient = (apiKey) => new Anthropic({ apiKey }), now = () => Date.now() }) {
    this.settings = settings;
    this.deps = { registry, pages, actions, engine, floorplan, access };
    this.createClient = createClient;
    this.now = now;
  }

  #conversation(userId, conversationId) {
    let mine = this.#conversations.get(userId);
    if (!mine) this.#conversations.set(userId, (mine = new Map()));
    for (const [id, c] of mine) if (this.now() - c.updatedAt > CONVERSATION_TTL_MS) mine.delete(id);
    if (conversationId && mine.has(conversationId)) return { id: conversationId, convo: mine.get(conversationId) };
    if (mine.size >= MAX_CONVERSATIONS_PER_USER) {
      const oldest = [...mine.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt)[0][0];
      mine.delete(oldest);
    }
    const id = randomUUID();
    const convo = { messages: [], updatedAt: this.now() };
    mine.set(id, convo);
    return { id, convo };
  }

  /**
   * Run one user turn. `emit(event, data)` receives:
   *   start { conversationId }, text { delta }, tool { name, title }, tool_result { name, ok },
   *   done { conversationId }, error { message }
   */
  async send({ user, conversationId, message, emit, signal }) {
    const text = String(message ?? '').trim();
    if (!text) throw new HttpError(400, 'Say something first');
    if (text.length > MAX_MESSAGE_CHARS) throw new HttpError(400, `Keep messages under ${MAX_MESSAGE_CHARS} characters`);
    const apiKey = this.settings.apiKey();
    if (!apiKey) throw new HttpError(409, 'The AI chat is not set up yet. An admin can add a Claude API key in Set up with AI.');

    const client = this.createClient(apiKey);
    const { id, convo } = this.#conversation(user.id, conversationId);
    const { tools, call } = homeTools({ user, ...this.deps, by: `chat:${user.username}` });
    const byName = new Map(tools.map((t) => [t.name, { tool: t, schema: z.object(t.shape) }]));
    const apiTools = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: jsonSchema(t.shape),
      eager_input_streaming: true,
    }));

    // Work on a copy so a failed turn leaves the stored conversation untouched.
    const messages = [...convo.messages, { role: 'user', content: text }];
    emit('start', { conversationId: id });

    let jsonRetries = 0;
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const stream = client.beta.messages.stream({
        model: this.settings.model(),
        max_tokens: 64000,
        output_config: { effort: 'medium' },
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        system: [
          { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
          { type: 'text', text: `You are the HomeyVibe AI user, acting for ${user.displayName} (role: ${user.role}). You can only do what both of you are allowed to; get_home_overview lists your limits. Server time: ${new Date(this.now()).toString()}.` },
        ],
        tools: apiTools,
        messages,
      }, { signal });
      stream.on('text', (delta) => emit('text', { delta }));

      let reply;
      try {
        reply = await stream.finalMessage();
        jsonRetries = 0;
      } catch (err) {
        if (err instanceof Anthropic.APIError || signal?.aborted || jsonRetries++ >= 2) throw friendlyError(err);
        continue; // a tool input could not be parsed; ask again
      }

      messages.push({ role: 'assistant', content: reply.content });

      if (reply.stop_reason === 'refusal') {
        emit('error', { message: 'Claude declined to help with that request.' });
        break;
      }
      if (reply.stop_reason === 'pause_turn') continue;
      const toolUses = reply.content.filter((b) => b.type === 'tool_use');
      // A tool input cut off at max_tokens can parse as a valid partial object; never run it.
      if (reply.stop_reason === 'max_tokens' && toolUses.length) throw new HttpError(502, 'The reply was cut off. Try a smaller request.');
      if (reply.stop_reason !== 'tool_use' || toolUses.length === 0) {
        convo.messages = messages;
        convo.updatedAt = this.now();
        emit('done', { conversationId: id });
        return { conversationId: id };
      }

      const results = await Promise.all(toolUses.map(async (use) => {
        const entry = byName.get(use.name);
        emit('tool', { name: use.name, title: entry?.tool.title ?? use.name });
        if (!entry) return toolResult(use.id, false, `Unknown tool ${use.name}`);
        // Eager input streaming skips server-side validation, so check the input here.
        const parsed = entry.schema.safeParse(use.input);
        if (!parsed.success) {
          emit('tool_result', { name: use.name, ok: false });
          return toolResult(use.id, false, `Invalid input: ${z.prettifyError(parsed.error)}`);
        }
        const { ok, text: out } = await call(entry.tool, parsed.data);
        emit('tool_result', { name: use.name, ok });
        return toolResult(use.id, ok, out);
      }));
      messages.push({ role: 'user', content: results });
    }

    convo.messages = messages;
    convo.updatedAt = this.now();
    emit('done', { conversationId: id });
    return { conversationId: id };
  }

  reset(userId, conversationId) {
    this.#conversations.get(userId)?.delete(conversationId);
  }
}

function jsonSchema(shape) {
  const { $schema, ...schema } = z.toJSONSchema(z.object(shape), { target: 'draft-7' });
  return schema;
}

function toolResult(id, ok, content) {
  return { type: 'tool_result', tool_use_id: id, content, ...(ok ? {} : { is_error: true }) };
}

function friendlyError(err) {
  if (err instanceof Anthropic.AuthenticationError) return new HttpError(502, 'The Claude API key was rejected. Check it in Set up with AI.');
  if (err instanceof Anthropic.PermissionDeniedError) return new HttpError(502, 'This Claude API key is not allowed to use that model.');
  if (err instanceof Anthropic.RateLimitError) return new HttpError(503, 'Claude is busy or the usage limit was reached. Try again in a moment.');
  if (err instanceof Anthropic.APIConnectionError) return new HttpError(503, 'Could not reach Claude. Check the server’s internet connection.');
  if (err instanceof Anthropic.APIError) return new HttpError(502, `Claude API error: ${err.message}`);
  return err;
}
