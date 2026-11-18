import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { can, PERMISSIONS } from '../auth/roles.js';
import { HttpError } from '../http/errors.js';
import { LAYOUTS } from '../config/pages.js';
import { DAYS, OPERATORS } from '../config/actions.js';
import { describeDevice, FORMAT_GUIDE } from './context.js';
import { importConfig } from './importer.js';

const INSTRUCTIONS = `HomeyVibe is a smart home server. You can look at the devices it found, control them, and configure dashboard pages and actions (scenes and automations).

Start with get_home_overview. Only use device ids and capability properties that it lists. Prefer apply_configuration to set up several pages and actions at once; it validates everything before saving anything and reports every problem in one error.

${FORMAT_GUIDE}`;

// ---- schemas ------------------------------------------------------------------------

const deviceItem = z.object({
  type: z.literal('device'),
  deviceId: z.string().describe('Device id from get_home_overview'),
  properties: z.array(z.string()).optional().describe('Capabilities to show; omit for all'),
});
const actionItem = z.object({ type: z.literal('action'), actionId: z.string() });

const pageSchema = z.object({
  id: z.string().optional().describe('Existing id to update; omit to create (generated from title)'),
  title: z.string(),
  icon: z.string().optional().describe('A single emoji'),
  layout: z.enum(LAYOUTS).optional(),
  order: z.number().int().optional(),
  sections: z.array(z.object({
    title: z.string().optional(),
    items: z.array(z.union([deviceItem, actionItem])),
  })),
});

const stepSchema = z.union([
  z.object({ type: z.literal('set'), deviceId: z.string(), values: z.record(z.string(), z.any()).describe('{ property: value }') }),
  z.object({ type: z.literal('delay'), seconds: z.number().positive().max(3600) }),
  z.object({ type: z.literal('run'), actionId: z.string() }),
]);
const triggerSchema = z.union([
  z.object({
    type: z.literal('state'),
    deviceId: z.string(),
    property: z.string(),
    op: z.enum(OPERATORS).optional().describe('Default eq'),
    value: z.any().optional(),
  }),
  z.object({
    type: z.literal('time'),
    at: z.string().describe('HH:MM, 24h, server local time'),
    days: z.array(z.enum(DAYS)).optional(),
  }),
]);
const actionSchema = z.object({
  id: z.string().optional().describe('Existing id to update; omit to create (generated from name)'),
  name: z.string(),
  description: z.string().optional(),
  enabled: z.boolean().optional(),
  steps: z.array(stepSchema).min(1),
  triggers: z.array(triggerSchema).optional(),
});

// ---- server -------------------------------------------------------------------------

/**
 * Build an MCP server bound to one signed-in user; every tool checks that user's permissions.
 */
export function createMcpServer({ user, registry, pages, actions, engine }) {
  const server = new McpServer({ name: 'homeyvibe', version: '0.1.0' }, { instructions: INSTRUCTIONS });

  const tool = (name, config, permission, handler) =>
    server.registerTool(name, config, async (args) => {
      try {
        if (permission && !can(user, permission)) {
          throw new HttpError(403, `${user.displayName} (${user.role}) is not allowed to do this`);
        }
        const result = await handler(args ?? {});
        return { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: err.message }] };
      }
    });

  tool('get_home_overview', {
    title: 'Home overview',
    description: 'All devices with their capabilities and current state, plus the configured pages and actions.',
    annotations: { readOnlyHint: true },
  }, PERMISSIONS.DEVICES_READ, () => ({
    devices: registry.list().map(describeDevice),
    pages: pages.list(),
    actions: actions.list(),
    you: { name: user.displayName, role: user.role, permissions: user.permissions },
  }));

  tool('list_devices', {
    title: 'Find devices',
    description: 'Devices with capabilities and state, optionally filtered by a text match on name, vendor, model or id.',
    inputSchema: { query: z.string().optional() },
    annotations: { readOnlyHint: true },
  }, PERMISSIONS.DEVICES_READ, ({ query }) => {
    const q = query?.toLowerCase();
    return registry.list()
      .filter((d) => !q || [d.id, d.name, d.vendor, d.model, d.description].some((v) => v?.toLowerCase().includes(q)))
      .map(describeDevice);
  });

  tool('control_device', {
    title: 'Control a device',
    description: 'Set one or more capabilities on a device, e.g. { "state": "ON", "brightness": 120 }.',
    inputSchema: { deviceId: z.string(), values: z.record(z.string(), z.any()) },
  }, PERMISSIONS.DEVICES_CONTROL, async ({ deviceId, values }) => {
    await registry.command(deviceId, values);
    return `Sent ${JSON.stringify(values)} to ${registry.get(deviceId)?.name ?? deviceId}.`;
  });

  tool('run_action', {
    title: 'Run an action',
    description: 'Run a configured action (scene) now.',
    inputSchema: { actionId: z.string() },
  }, PERMISSIONS.DEVICES_CONTROL, async ({ actionId }) => {
    const result = await engine.run(actionId, { by: `ai:${user.username}` });
    if (!result.ok) throw new HttpError(400, `Action failed: ${result.error}`);
    return `Ran ${actionId}.`;
  });

  tool('apply_configuration', {
    title: 'Create or update pages and actions',
    description: 'Create or update several pages and actions at once. Items with an existing id are updated. Everything is validated first; nothing is saved if anything is wrong.',
    inputSchema: { pages: z.array(pageSchema).optional(), actions: z.array(actionSchema).optional() },
    annotations: { idempotentHint: true },
  }, PERMISSIONS.CONFIG_WRITE, (bundle) => importConfig({ bundle, pages, actions, registry }));

  tool('save_page', {
    title: 'Create or update a page',
    description: 'Create a dashboard page, or update one by id (the whole page is replaced).',
    inputSchema: { page: pageSchema },
    annotations: { idempotentHint: true },
  }, PERMISSIONS.CONFIG_WRITE, ({ page }) => importConfig({ bundle: { pages: [page] }, pages, actions, registry }));

  tool('save_action', {
    title: 'Create or update an action',
    description: 'Create an action (scene or automation), or update one by id (the whole action is replaced).',
    inputSchema: { action: actionSchema },
    annotations: { idempotentHint: true },
  }, PERMISSIONS.CONFIG_WRITE, ({ action }) => importConfig({ bundle: { actions: [action] }, pages, actions, registry }));

  tool('delete_page', {
    title: 'Delete a page',
    inputSchema: { pageId: z.string() },
    annotations: { destructiveHint: true },
  }, PERMISSIONS.CONFIG_WRITE, ({ pageId }) => {
    pages.delete(pageId);
    return `Deleted page ${pageId}.`;
  });

  tool('delete_action', {
    title: 'Delete an action',
    inputSchema: { actionId: z.string() },
    annotations: { destructiveHint: true },
  }, PERMISSIONS.CONFIG_WRITE, ({ actionId }) => {
    const usedBy = pages.list().filter((p) => p.sections.some((s) => s.items.some((i) => i.type === 'action' && i.actionId === actionId)));
    actions.delete(actionId);
    return usedBy.length
      ? `Deleted action ${actionId}. It is still referenced on pages: ${usedBy.map((p) => p.id).join(', ')}; update them with save_page.`
      : `Deleted action ${actionId}.`;
  });

  server.registerPrompt('set_up_my_home', {
    title: 'Set up my home',
    description: 'Look at every device and propose pages and actions, then apply them after confirmation.',
  }, () => ({
    messages: [{
      role: 'user',
      content: {
        type: 'text',
        text: 'Look at my HomeyVibe home with get_home_overview. Propose a set of pages (one per room where names suggest rooms, otherwise by device kind) and a few useful actions. Show me the plan in plain words, and after I confirm, save it with apply_configuration.',
      },
    }],
  }));

  return server;
}

/**
 * Handle one MCP HTTP request (stateless Streamable HTTP: a fresh server per request).
 */
export async function handleMcpRequest({ req, res, body, user, deps }) {
  const server = createMcpServer({ user, ...deps });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => {
    transport.close();
    server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}
