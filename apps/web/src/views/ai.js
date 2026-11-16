import { api, request } from '../api.js';
import { h, onSubmit, toast } from '../ui.js';
import { field } from './auth.js';

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
      h('h3', {}, '1. Connect Claude or Codex'),
      h('p.muted', {}, 'Create a token, then paste the command or config into your AI tool. The AI acts with your permissions.'),
      tokenForm(),
      reveal,
      tokenList,
    ),

    h('section.ai-block', {},
      h('h3', {}, '2. Or use a context file'),
      h('p.muted', {}, 'Download a description of your home, give it to any AI (ChatGPT, Claude, Gemini…), and ask it for pages and actions.'),
      h('div.row', {},
        h('a.button', { href: '/api/ai/context', download: 'homeyvibe-context.md' }, 'Download context file'),
      ),
      canConfigure ? importForm() : null,
    ),

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

  function assistantBlock(status) {
    const state = h('p.muted', { role: 'status' });
    const describe = (s) => {
      state.textContent = s.configured
        ? `Connected${s.keyHint ? ` with key ${s.keyHint}` : ' through the server environment'} · model ${s.model}`
        : 'Not set up. Add a Claude API key to use the chat button in the corner.';
    };
    describe(status);
    const form = h('form.inline-form', {},
      field('Claude API key', h('input', { name: 'apiKey', type: 'password', placeholder: 'sk-ant-…', autocomplete: 'off', required: true })),
      h('button.primary', { type: 'submit' }, status.configured ? 'Replace key' : 'Save key'),
      h('p.form-error', { role: 'alert' }),
    );
    onSubmit(form, async ({ apiKey }) => {
      describe(await api.updateAiSettings({ apiKey }));
      form.reset();
    });
    const remove = status.source === 'settings'
      ? h('button.icon-button', { type: 'button', onclick: async () => {
        describe(await api.updateAiSettings({ apiKey: null }));
        remove.remove();
      } }, 'Remove saved key')
      : null;
    return h('section.ai-block', {},
      h('h3', {}, '3. Built-in assistant'),
      h('p.muted', {}, 'Chat with Claude right inside HomeyVibe. It uses the same tools and each person’s permissions. Usage is billed to this API key.'),
      state,
      form,
      remove,
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
    ['Codex (~/.codex/config.toml, then export HOMEYVIBE_TOKEN)', `[mcp_servers.homeyvibe]\nurl = "${mcpUrl}"\nbearer_token_env_var = "HOMEYVIBE_TOKEN"\n\n# shell:\nexport HOMEYVIBE_TOKEN=${token}`],
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
            await navigator.clipboard?.writeText(code).catch(() => {});
            e.target.textContent = 'Copied';
            setTimeout(() => (e.target.textContent = 'Copy'), 1500);
          },
        }, 'Copy'),
      ),
      h('pre', {}, code),
    )),
    h('p.muted', {}, 'Then ask your AI: “Set up my HomeyVibe home.”'),
  ];
}
