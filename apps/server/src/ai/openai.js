import { HttpError } from '../http/errors.js';

export const DEFAULT_OPENAI_MODEL = 'gpt-5-mini';

/** Run a tool-calling turn using the optional server-side OpenAI project key. */
export async function runOpenAiTurn({ apiKey, model, system, kit, messages, emit, signal, maxTurns, fetchReply = fetch }) {
  const tools = kit.definitions.map(({ name, description, input_schema }) => ({
    type: 'function',
    function: { name, description, parameters: input_schema, strict: false },
  }));

  for (let turn = 0; turn < maxTurns; turn++) {
    signal?.throwIfAborted();
    const timeout = AbortSignal.timeout(120_000);
    let response;
    try {
      response = await fetchReply('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model, tools, parallel_tool_calls: false, max_completion_tokens: 8192, store: false,
          messages: [{ role: 'developer', content: system.map((block) => block.text).join('\n\n') }, ...messages],
        }),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch {
      if (signal?.aborted) signal.throwIfAborted();
      throw new HttpError(503, 'Could not reach OpenAI. Check the server’s internet connection.');
    }
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 401) throw new HttpError(502, 'The OpenAI API key was rejected. Check it in Set up with AI.');
      if (response.status === 429) throw new HttpError(503, 'OpenAI is busy or the project usage limit was reached.');
      if ([400, 403, 404].includes(response.status)) throw new HttpError(502, 'OpenAI rejected the request. Check the model and project permissions in Set up with AI.');
      throw new HttpError(502, 'OpenAI could not complete the request.');
    }
    const reply = (await response.json().catch(() => null))?.choices?.[0];
    if (!reply?.message) throw new HttpError(502, 'OpenAI returned an invalid response.');
    if (reply.finish_reason === 'length') throw new HttpError(502, 'The reply was cut off. Try a smaller request.');
    const { content, refusal, tool_calls: calls } = reply.message;
    if (refusal || reply.finish_reason === 'content_filter') {
      emit('error', { message: 'OpenAI declined to help with that request.' });
      return;
    }
    if (content) emit('text', { delta: content });
    messages.push({ role: 'assistant', content, ...(calls?.length ? { tool_calls: calls } : {}) });
    if (reply.finish_reason !== 'tool_calls' || !calls?.length) return;

    for (const call of calls) {
      signal?.throwIfAborted();
      const { name, arguments: args } = call.function;
      emit('tool', { name, title: kit.title(name) });
      let input;
      try { input = JSON.parse(args); } catch { /* Report the invalid arguments to the model. */ }
      const result = input && typeof input === 'object' && !Array.isArray(input)
        ? await kit.run(name, input)
        : { ok: false, text: 'Invalid input. Provide a JSON object matching the tool schema.' };
      emit('tool_result', { name, ok: result.ok });
      messages.push({ role: 'tool', tool_call_id: call.id, content: result.ok ? result.text : `Error: ${result.text}` });
    }
  }
  emit('error', { message: 'The assistant reached its tool limit. Continue in another message.' });
}
