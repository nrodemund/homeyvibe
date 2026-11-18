import { api, request } from '../api.js';
import { h, onSubmit, toast } from '../ui.js';
import { field } from './auth.js';
import { deviceKey } from '../ai/client-chat.js';

/** "AI setup" dialog: connect Claude/Codex over MCP, or use a context file with any LLM. */
export async function openAiDialog(user) {
  const canConfigure = user.permissions.includes('config:write');
  const mcpUrl = `${location.origin}/mcp`;
  const [tokens, aiStatus] = await Promise.all([api.tokens(), api.aiSettings().catch(() => null)]);

  const tokenList = h('ul.token-list');
  const reveal = h('div.reveal');
  const dialog = h('dialog.panel.wide', { 'aria-labelledby': 'ai-title' },
    h('header', {},
      h('h2', { id: 'ai-title' }, 'Set up with AI'),
      h('button.icon-button', { type: 'button', 'aria-label': 'Close', onclick: () => dialog.close() }, '✕'),
    ),
    h('p.muted', {}, canConfigure
      ? 'Let an AI find your devices, build pages and create actions. Connect Claude or Codex directly, or hand any AI a context file.'
      : 'Connect an AI assistant to see and control your devices. Ask an admin if you want it to change pages and actions.'),

    h('section.ai-block', {},
      h('h3', {}, 'Connect Codex or Claude Code'),
      h('p.muted', {}, 'Create a token, then paste the command or config into your AI tool. The AI acts with your permissions.'),
      tokenForm(),
      reveal,
      tokenList,
    ),

    h('section.ai-block', {},
      h('h3', {}, 'Use ChatGPT with a context file'),
      h('p.muted', {}, 'Give the downloaded home description to ChatGPT or another assistant. Ask it to create a HomeyVibe configuration, then import its JSON response here.'),
      h('div.row', {},
        h('a.button', { href: '/api/ai/context', download: 'homeyvibe-context.md' }, 'Download context file'),
      ),
      canConfigure ? importForm() : null,
    ),

    deviceBlock(),
    canConfigure && aiStatus ? assistantBlock(aiStatus) : null,
  );
  dialog.addEventListener('close', () => dialog.remove());

  function renderTokens() {
    tokenList.replaceChildren(...tokens.map((t) => h('li', {},
      h('span', {}, h('strong', {}, t.name), h('span.muted', {}, ` · created ${new Date(t.createdAt).toLocaleDateString()}`)),
      h('button.icon-button', {
        type: 'button',
        'aria-label': `Revoke ${t.name}`,
        onclick: async () => {
          try {
            await api.revokeToken(t.id);
            tokens.splice(tokens.indexOf(t), 1);
            renderTokens();
          } catch (err) {
            toast(err.message);
          }
        },
      }, 'Revoke'),
    )));
  }

  function tokenForm() {
    const form = h('form.inline-form', {},
      field('Token name', h('input', { name: 'name', placeholder: 'e.g. Claude Code on my laptop', required: true, maxLength: 64 })),
      h('button.primary', { type: 'submit' }, 'Create token'),
      h('p.form-error', { role: 'alert' }),
    );
    onSubmit(form, async ({ name }) => {
      const created = await api.createToken(name);
      tokens.push(created);
      renderTokens();
      form.reset();
      reveal.replaceChildren(...setupSnippets(mcpUrl, created.token));
    });
    return form;
  }

  function importForm() {
    const textarea = h('textarea', { name: 'bundle', rows: 6, spellcheck: false, placeholder: '{ "pages": [ … ], "actions": [ … ] }' });
    const result = h('p.muted', { role: 'status' });
    const form = h('form.import-form', {},
      field('Paste the AI’s answer (JSON)', textarea),
      h('div.row', {},
        h('label.button', {}, 'Load file…', h('input', {
          type: 'file',
          accept: '.json,application/json,text/plain',
          hidden: true,
          onchange: async (e) => {
            const file = e.target.files[0];
            if (file) textarea.value = await file.text();
          },
        })),
        h('button.primary', { type: 'submit' }, 'Import'),
      ),
      h('p.form-error', { role: 'alert' }),
      result,
    );
    onSubmit(form, async ({ bundle }) => {
      result.textContent = '';
      const parsed = parseBundle(bundle);
      const r = await request('/api/ai/import', { method: 'POST', body: parsed });
      const parts = [];
      if (r.created.pages.length) parts.push(`created pages: ${r.created.pages.join(', ')}`);
      if (r.created.actions.length) parts.push(`created actions: ${r.created.actions.join(', ')}`);
      if (r.updated.pages.length) parts.push(`updated pages: ${r.updated.pages.join(', ')}`);
      if (r.updated.actions.length) parts.push(`updated actions: ${r.updated.actions.join(', ')}`);
      result.textContent = `Imported. ${parts.join('; ')}.`;
      textarea.value = '';
    });
    return form;
  }

  function deviceBlock() {
    const state = h('p.muted', { role: 'status' });
    const forget = h('button.icon-button', {
      type: 'button',
      onclick: () => {
        deviceKey.clear();
        describe();
      },
    }, 'Forget key on this device');
    const describe = () => {
      const hint = deviceKey.hint();
      state.textContent = hint
        ? `The assistant runs on this device with key ${hint}. Your server only runs the tools.`
        : 'No key on this device. Open the ✦ assistant to add one; it stays in this browser.';
      forget.hidden = !hint;
    };
    describe();
    return h('section.ai-block', {},
      h('h3', {}, 'Claude on this device'),
      h('p.muted', {}, 'Chat with Claude in HomeyVibe. Claude is called from your phone or computer, so a small server like a Raspberry Pi does no AI work and needs no internet access for it.'),
      state,
      forget,
    );
  }

  function assistantBlock(status) {
    const state = h('p.muted', { role: 'status' });
    const provider = h('select', { name: 'provider' }, new Option('Claude', 'claude'), new Option('OpenAI', 'openai'));
    provider.value = status.provider;
    const key = h('input', { name: 'apiKey', type: 'password', autocomplete: 'new-password', maxLength: 512 });
    const model = h('input', { name: 'model', maxLength: 128 });
    const remove = h('button.icon-button', { type: 'button', onclick: async () => {
      remove.disabled = true;
      try {
        describe(await api.updateAiSettings({ provider: provider.value, apiKey: null }));
      } catch (err) {
        toast(err.message);
      } finally {
        remove.disabled = false;
      }
    } }, 'Remove saved key');
    const describe = (s) => {
      status = s;
      const selected = provider.value === s.provider;
      state.textContent = s.configured
        ? `Active provider: ${s.provider === 'openai' ? 'OpenAI' : 'Claude'} · ${s.model}${s.keyHint ? ` · key ${s.keyHint}` : ' · key from deployment'}`
        : 'Add a project API key to enable the shared assistant.';
      key.placeholder = provider.value === 'openai' ? 'sk-proj-…' : 'sk-ant-…';
      model.placeholder = selected ? s.model : 'Provider default';
      key.value = '';
      model.value = '';
      remove.hidden = s.source !== 'settings' || !selected;
    };
    provider.addEventListener('change', () => describe(status));
    describe(status);
    const form = h('form.settings-fields', {},
      field('Provider', provider),
      field('Project API key', key),
      field('Model', model),
      h('div.row', {}, h('button.primary', { type: 'submit' }, 'Save assistant settings'), remove),
      h('p.form-error', { role: 'alert' }),
    );
    onSubmit(form, async ({ provider: selection, apiKey, model: modelId }) => {
      describe(await api.updateAiSettings({ provider: selection, apiKey: apiKey.trim() || undefined, model: modelId.trim() || undefined }));
    });
    return h('section.ai-block', {},
      h('h3', {}, 'Shared assistant'),
      h('p.muted', {}, 'Use a Claude or OpenAI project API key on the server. Devices with a local Claude key keep using it. API usage is billed to your provider project.'),
      state,
      form,
    );
  }

  renderTokens();
  document.body.append(dialog);
  dialog.showModal();
}

/** Accepts raw JSON or a Markdown answer with a ```json block. */
export function parseBundle(text) {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const raw = (fenced ? fenced[1] : text).trim();
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('That is not valid JSON. Paste the JSON part of the AI’s answer.');
  }
}

function setupSnippets(mcpUrl, token) {
  const snippets = [
    ['Claude Code', `claude mcp add --transport http homeyvibe ${mcpUrl} --header "Authorization: Bearer ${token}"`],
    ['Codex (~/.codex/config.toml)', `[mcp_servers.homeyvibe]\nurl = "${mcpUrl}"\nbearer_token_env_var = "HOMEYVIBE_TOKEN"`],
    ['Start Codex on macOS or Linux', `export HOMEYVIBE_TOKEN='${token}'\ncodex`],
    ['Start Codex in Windows PowerShell', `$env:HOMEYVIBE_TOKEN = '${token}'\ncodex`],
    ['Claude Desktop and other MCP apps (via mcp-remote)', JSON.stringify({
      mcpServers: { homeyvibe: { command: 'npx', args: ['-y', 'mcp-remote', mcpUrl, '--header', `Authorization: Bearer ${token}`] } },
    }, null, 2)],
  ];
  return [
    h('p.notice', {}, 'Copy your token now. It will not be shown again.'),
    h('code.token', {}, token),
    ...snippets.map(([title, code]) => h('div.snippet', {},
      h('div.snippet-head', {},
        h('span', {}, title),
        h('button.icon-button', {
          type: 'button',
          onclick: async (e) => {
            try {
              await navigator.clipboard.writeText(code);
              e.target.textContent = 'Copied';
            } catch {
              const range = document.createRange();
              range.selectNodeContents(e.target.closest('.snippet').querySelector('pre'));
              const selection = window.getSelection();
              selection.removeAllRanges();
              selection.addRange(range);
              e.target.textContent = 'Selected';
            }
            setTimeout(() => (e.target.textContent = 'Copy'), 1500);
          },
        }, 'Copy'),
      ),
      h('pre', {}, code),
    )),
    h('p.muted', {}, 'Start Codex from a computer that can reach HomeyVibe. Then ask it to inspect your devices and propose a setup.'),
  ];
}
