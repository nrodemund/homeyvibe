import { z } from 'zod';
import { can, PERMISSIONS } from '../auth/roles.js';
import { HttpError } from '../http/errors.js';
import { LAYOUTS } from '../config/pages.js';
import { DAYS, OPERATORS } from '../config/actions.js';
import { describeDevice, FORMAT_GUIDE } from './context.js';
import { importConfig } from './importer.js';
import { scopedRegistry } from '../auth/access.js';

/** Shared guidance for any model using these tools (MCP instructions, in-app chat system prompt). */
export const TOOL_GUIDE = `HomeyVibe is a smart home server. You can look at the devices it found, control them, and configure dashboard pages and actions (scenes and automations).

Start with get_home_overview. Only use device ids and capability properties that it lists. Prefer apply_configuration to set up several pages and actions at once; it validates everything before saving anything and reports every problem in one error.

${FORMAT_GUIDE}`;

// ---- schemas ------------------------------------------------------------------------

const deviceItem = z.object({
  type: z.literal('device'),
  deviceId: z.string().describe('Device id from get_home_overview'),
  properties: z.array(z.string()).optional().describe('Capabilities to show; omit for all'),
});
const actionItem = z.object({ type: z.literal('action'), actionId: z.string() });

export const pageSchema = z.object({
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
export const floorplanSchema = z.object({
  rooms: z.array(z.object({
    id: z.string().optional().describe('Generated from name if omitted'),
    name: z.string(),
    floor: z.number().int().optional().describe('0 = ground floor'),
    height: z.number().optional().describe('Ceiling height in meters, default 2.5'),
    points: z.array(z.array(z.number()).length(2)).min(3).describe('Corners [x, z] in meters, seen from above, in order'),
  })),
  devices: z.array(z.object({
    deviceId: z.string(),
    roomId: z.string().nullable().optional(),
    position: z.array(z.number()).length(3).describe('[x, height, z] in meters'),
  })),
});

export const actionSchema = z.object({
  id: z.string().optional().describe('Existing id to update; omit to create (generated from name)'),
  name: z.string(),
  description: z.string().optional(),
  enabled: z.boolean().optional(),
  steps: z.array(stepSchema).min(1),
  triggers: z.array(triggerSchema).optional(),
});

// ---- tools ----------------------------------------------------------------------------

/**
 * The tools an AI gets for one signed-in user. Used by the MCP server and the in-app chat.
 * Each tool: { name, title, description, shape (zod raw shape), annotations, permission, run(args) }.
 * `call(tool, args)` checks the permission and returns { ok, text }.
 */
export function homeTools({ user: person, registry: fullRegistry, pages, actions, engine, floorplan = null, access = null, zigbee = null, by = `ai:${person.username}` }) {
  // The AI gets what both the person and the AI user may do (see auth/access.js).
  const scope = access ? access.aiFor(person) : null;
  const user = scope?.user ?? person;
  const registry = scope ? scopedRegistry(fullRegistry, scope.policy) : fullRegistry;
  const deps = { pages, actions, registry, floorplan };
  const visiblePlan = () => {
    const plan = floorplan.get();
    return { ...plan, devices: plan.devices.filter((d) => registry.get(d.deviceId)) };
  };
  const tools = [
    zigbee && {
      name: 'diagnose_zigbee2mqtt',
      title: 'Zigbee2MQTT connection',
      description: 'Explain why Zigbee devices may be missing and what to check in Settings → Zigbee2MQTT. Use when discovery fails.',
      shape: {},
      annotations: { readOnlyHint: true },
      permission: PERMISSIONS.CONFIG_WRITE,
      run: () => zigbee.diagnosis(),
    },
    {
      name: 'get_home_overview',
      title: 'Home overview',
      description: 'All devices with their capabilities and current state, plus the configured pages and actions.',
      shape: {},
      annotations: { readOnlyHint: true },
      permission: PERMISSIONS.DEVICES_READ,
      run: () => ({
        devices: registry.list().map(describeDevice),
        pages: pages.list(),
        actions: actions.list(),
        ...(floorplan ? { floorplan: visiblePlan() } : {}),
        you: {
          actingFor: user.displayName,
          role: user.role,
          permissions: user.permissions,
          ...(scope ? { limits: describeLimits(scope) } : {}),
        },
      }),
    },
    {
      name: 'list_devices',
      title: 'Find devices',
      description: 'Devices with capabilities and state, optionally filtered by a text match on name, vendor, model or id.',
      shape: { query: z.string().optional() },
      annotations: { readOnlyHint: true },
      permission: PERMISSIONS.DEVICES_READ,
      run: ({ query }) => {
        const q = query?.toLowerCase();
        return registry.list()
          .filter((d) => !q || [d.id, d.name, d.vendor, d.model, d.description].some((v) => v?.toLowerCase().includes(q)))
          .map(describeDevice);
      },
    },
    {
      name: 'control_device',
      title: 'Control a device',
      description: 'Set one or more capabilities on a device, e.g. { "state": "ON", "brightness": 120 }.',
      shape: { deviceId: z.string(), values: z.record(z.string(), z.any()) },
      permission: PERMISSIONS.DEVICES_CONTROL,
      run: async ({ deviceId, values }) => {
        await registry.command(deviceId, values);
        return `Sent ${JSON.stringify(values)} to ${registry.get(deviceId)?.name ?? deviceId}.`;
      },
    },
    {
      name: 'run_action',
      title: 'Run an action',
      description: 'Run a configured action (scene) now.',
      shape: { actionId: z.string() },
      permission: PERMISSIONS.DEVICES_CONTROL,
      run: async ({ actionId }) => {
        if (registry.check) engine.preflight(actionId, registry.check);
        const result = await engine.run(actionId, { by });
        if (!result.ok) throw new HttpError(400, `Action failed: ${result.error}`);
        return `Ran ${actionId}.`;
      },
    },
    {
      name: 'apply_configuration',
      title: 'Create or update pages and actions',
      description: 'Create or update several pages and actions at once, and optionally replace the floor plan. Items with an existing id are updated. Everything is validated first; nothing is saved if anything is wrong.',
      shape: { pages: z.array(pageSchema).optional(), actions: z.array(actionSchema).optional(), ...(floorplan ? { floorplan: floorplanSchema.optional() } : {}) },
      annotations: { idempotentHint: true },
      permission: PERMISSIONS.CONFIG_WRITE,
      run: (bundle) => importConfig({ bundle, ...deps }),
    },
    {
      name: 'save_page',
      title: 'Create or update a page',
      description: 'Create a dashboard page, or update one by id (the whole page is replaced).',
      shape: { page: pageSchema },
      annotations: { idempotentHint: true },
      permission: PERMISSIONS.CONFIG_WRITE,
      run: ({ page }) => importConfig({ bundle: { pages: [page] }, ...deps }),
    },
    {
      name: 'save_action',
      title: 'Create or update an action',
      description: 'Create an action (scene or automation), or update one by id (the whole action is replaced).',
      shape: { action: actionSchema },
      annotations: { idempotentHint: true },
      permission: PERMISSIONS.CONFIG_WRITE,
      run: ({ action }) => importConfig({ bundle: { actions: [action] }, ...deps }),
    },
    floorplan && {
      name: 'save_floorplan',
      title: 'Update the floor plan',
      description: 'Replace the floor plan used by 3D pages: rooms as polygons and where each device sits. Send the whole plan; read the current one from get_home_overview first.',
      shape: { floorplan: floorplanSchema },
      annotations: { idempotentHint: true },
      permission: PERMISSIONS.CONFIG_WRITE,
      run: ({ floorplan: plan }) => {
        const r = importConfig({ bundle: { floorplan: plan }, ...deps });
        return `Saved the floor plan: ${r.floorplan.rooms} rooms, ${r.floorplan.devices} placed devices.`;
      },
    },
    {
      name: 'delete_page',
      title: 'Delete a page',
      description: 'Delete a dashboard page.',
      shape: { pageId: z.string() },
      annotations: { destructiveHint: true },
      permission: PERMISSIONS.CONFIG_WRITE,
      run: ({ pageId }) => {
        pages.delete(pageId);
        return `Deleted page ${pageId}.`;
      },
    },
    {
      name: 'delete_action',
      title: 'Delete an action',
      description: 'Delete an action.',
      shape: { actionId: z.string() },
      annotations: { destructiveHint: true },
      permission: PERMISSIONS.CONFIG_WRITE,
      run: ({ actionId }) => {
        const usedBy = pages.list().filter((p) => p.sections.some((s) => s.items.some((i) => i.type === 'action' && i.actionId === actionId)));
        actions.delete(actionId);
        return usedBy.length
          ? `Deleted action ${actionId}. It is still referenced on pages: ${usedBy.map((p) => p.id).join(', ')}; update them with save_page.`
          : `Deleted action ${actionId}.`;
      },
    },
  ].filter(Boolean);

  async function call(tool, args) {
    try {
      if (tool.permission && !can(user, tool.permission)) {
        throw new HttpError(403, can(person, tool.permission)
          ? 'The HomeyVibe AI is not allowed to do this. An admin can change that under People → AI assistant.'
          : `${person.displayName} (${person.role}) is not allowed to do this`);
      }
      const result = await tool.run(args ?? {});
      return { ok: true, text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) };
    } catch (err) {
      return { ok: false, text: err.message };
    }
  }

  return { tools, call };
}

/** Plain-language summary of the AI's limits for the model. */
function describeLimits({ ai, policy }) {
  const notes = [];
  if (!ai.canControl) notes.push('You may not control devices or run actions.');
  if (!ai.canConfigure) notes.push('You may not change pages, actions or the floor plan.');
  notes.push('Devices you may not see are left out. Devices marked access "view" are read only. Capabilities with "allowed": [min, max] only accept values in that range; never try values outside it.');
  if (policy.unrestricted) notes.pop();
  return notes;
}
