import { randomUUID } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { HttpError } from '../http/errors.js';
import { homeTools, TOOL_GUIDE } from './tools.js';
import { DEFAULT_OPENAI_MODEL, runOpenAiTurn } from './openai.js';

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
 * or the ANTHROPIC_API_KEY / OPENAI_API_KEY environment variables.
 */
export class AiSettings {
  constructor({ store, env = process.env }) {
    this.store = store;
    this.env = env;
  }

  #read() {
    return this.store.read('ai-settings', {});
  }

  provider() {
    const saved = this.#read();
    return saved.provider ?? (this.env.OPENAI_API_KEY && !this.env.ANTHROPIC_API_KEY && !saved.apiKey ? 'openai' : 'claude');
  }

  apiKey(provider = this.provider()) {
    const saved = this.#read();
    return (provider === 'openai' ? saved.openaiApiKey || this.env.OPENAI_API_KEY : saved.apiKey || this.env.ANTHROPIC_API_KEY) || null;
  }

  model(provider = this.provider()) {
    const saved = this.#read();
    return provider === 'openai' ? saved.openaiModel || DEFAULT_OPENAI_MODEL : saved.model || DEFAULT_MODEL;
  }

  status() {
    const provider = this.provider();
    const stored = this.#read();
    const saved = provider === 'openai' ? stored.openaiApiKey : stored.apiKey;
    const key = this.apiKey(provider);
    return {
      provider,
      configured: Boolean(key),
      source: saved ? 'settings' : key ? 'environment' : null,
      keyHint: saved ? `…${saved.slice(-4)}` : null,
      model: this.model(provider),
    };
  }

  update({ apiKey, model, provider = this.provider() }) {
    if (!['claude', 'openai'].includes(provider)) throw new HttpError(400, 'Choose Claude or OpenAI');
    const next = { ...this.#read() };
    const keyField = provider === 'openai' ? 'openaiApiKey' : 'apiKey';
    const modelField = provider === 'openai' ? 'openaiModel' : 'model';
    if (apiKey !== undefined) {
      const key = typeof apiKey === 'string' ? apiKey.trim() : apiKey;
      const valid = provider === 'openai' ? /^sk-(?!ant-)\S+$/ : /^sk-ant-\S+$/;
      if (key === null || key === '') delete next[keyField];
      else if (typeof key !== 'string' || key.length > 512 || !valid.test(key)) {
        throw new HttpError(400, `Enter a valid ${provider === 'openai' ? 'OpenAI' : 'Claude'} API key`);
      } else next[keyField] = key;
    }
    if (model !== undefined) {
      const valid = provider === 'openai' ? /^[a-z0-9][a-z0-9._:-]*$/ : /^claude-[a-z0-9.-]+$/;
      if (model === null || model === '') delete next[modelField];
      else if (typeof model !== 'string' || model.length > 128 || !valid.test(model)) throw new HttpError(400, 'Invalid model id');
      else next[modelField] = model;
    }
    next.provider = provider;
    this.store.write('ai-settings', next);
    return this.status();
  }
}

/**
 * In-app chat loop over the same tools the MCP server offers,
 * with each tool checked against the signed-in user's permissions.
 * Conversations live in memory (they hold thinking blocks that must be sent back unchanged).
 */
export class ChatService {
  #conversations = new Map(); // userId -> Map(conversationId -> { messages, updatedAt })

  constructor({ settings, registry, pages, actions, engine, floorplan = null, access = null, zigbee = null,
    createClient = (apiKey) => new Anthropic({ apiKey }), openAiFetch, now = () => Date.now() }) {
    this.settings = settings;
    this.deps = { registry, pages, actions, engine, floorplan, access, zigbee };
    this.createClient = createClient;
    this.openAiFetch = openAiFetch;
    this.now = now;
  }

  #conversation(userId, conversationId, provider) {
    let mine = this.#conversations.get(userId);
    if (!mine) this.#conversations.set(userId, (mine = new Map()));
    for (const [id, c] of mine) if (this.now() - c.updatedAt > CONVERSATION_TTL_MS) mine.delete(id);
    if (conversationId && mine.get(conversationId)?.provider === provider) return { id: conversationId, convo: mine.get(conversationId) };
    if (mine.size >= MAX_CONVERSATIONS_PER_USER) {
      const oldest = [...mine.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt)[0][0];
      mine.delete(oldest);
    }
    const id = randomUUID();
    const convo = { messages: [], updatedAt: this.now(), provider };
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
    const provider = this.settings.provider();
    const apiKey = this.settings.apiKey(provider);
    if (!apiKey) throw new HttpError(409, 'The AI chat is not set up yet. An admin can add an API key in Set up with AI.');

    const { id, convo } = this.#conversation(user.id, conversationId, provider);
    const kit = aiToolkit({ user, deps: this.deps, by: `chat:${user.username}` });
    const messages = [...convo.messages, { role: 'user', content: text }];
    const model = this.settings.model(provider);
    const system = systemBlocks(user, this.now());
    emit('start', { conversationId: id });
    if (provider === 'openai') {
      await runOpenAiTurn({ apiKey, model, system, kit, messages, emit, signal, maxTurns: MAX_TURNS, fetchReply: this.openAiFetch });
    } else {
      await this.#runClaudeTurn({ apiKey, model, system, kit, messages, emit, signal });
    }
    convo.messages = messages;
    convo.updatedAt = this.now();
    emit('done', { conversationId: id });
    return { conversationId: id };
  }

  async #runClaudeTurn({ apiKey, model, system, kit, messages, emit, signal }) {
    const client = this.createClient(apiKey);
    const apiTools = kit.definitions.map(({ title, ...t }) => ({ ...t, eager_input_streaming: true }));

    let jsonRetries = 0;
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const stream = client.beta.messages.stream({
        model,
        max_tokens: 64000,
        output_config: { effort: 'medium' },
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        system,
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
      if (reply.stop_reason !== 'tool_use' || toolUses.length === 0) return;

      const results = await Promise.all(toolUses.map(async (use) => {
        emit('tool', { name: use.name, title: kit.title(use.name) });
        const { ok, text: out } = await kit.run(use.name, use.input);
        emit('tool_result', { name: use.name, ok });
        return toolResult(use.id, ok, out);
      }));
      messages.push({ role: 'user', content: results });
    }

  }

  reset(userId, conversationId) {
    this.#conversations.get(userId)?.delete(conversationId);
  }
}

/** System prompt blocks for a chat with `user`; the first block is shared by everyone and cached. */
export function systemBlocks(user, now = Date.now()) {
  return [
    { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: `You are the HomeyVibe AI user, acting for ${user.displayName} (role: ${user.role}). You can only do what both of you are allowed to; get_home_overview lists your limits. Server time: ${new Date(now).toString()}.` },
  ];
}

/**
 * The AI tools for one person, as plain data plus a runner. Used by the server-side chat and by
 * clients that run the model themselves (GET/POST /api/ai/tools), so the server never has to.
 * `run` validates the input against the tool's schema (eager input streaming skips that) and
 * applies the person's and the AI user's permissions and limits.
 */
export function aiToolkit({ user, deps, by }) {
  const { tools, call } = homeTools({ user, ...deps, by });
  const byName = new Map(tools.map((t) => [t.name, { tool: t, schema: z.object(t.shape) }]));
  return {
    definitions: tools.map((t) => ({ name: t.name, title: t.title, description: t.description, input_schema: jsonSchema(t.shape) })),
    title: (name) => byName.get(name)?.tool.title ?? name,
    async run(name, input) {
      const entry = byName.get(name);
      if (!entry) return { ok: false, text: `Unknown tool ${name}` };
      const parsed = entry.schema.safeParse(input ?? {});
      if (!parsed.success) return { ok: false, text: `Invalid input: ${z.prettifyError(parsed.error)}` };
      return call(entry.tool, parsed.data);
    },
  };
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
