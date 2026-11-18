# HomeyVibe: guide for coding agents

Read this before changing anything. It describes what HomeyVibe is, how the code is laid out, and the rules every change must follow. The README is for users; this file is for you.

## What HomeyVibe is

A simple, secure, self-hosted smart home. Tagline: *Made with AI, configured with AI, used by you.*

- **Simple first.** Everything is auto-detected: devices, their capabilities, and the controls for them. Users should never have to write config by hand or configure per-device anything.
- **Configured with AI.** An LLM finds devices, learns their capabilities, and creates pages (dashboards) and actions (scenes and automations). Three ways in: MCP for Claude Code / Codex / any MCP client, the built-in assistant in the app, or a downloadable context file for any AI.
- **Used by you.** Everything works from the UI and from AI: web, installable PWA, and (planned) Electron desktop.
- **Runs on a Raspberry Pi.** The server ships as Docker images (amd64, arm64, arm/v7) and auto-updates from `main`. **AI work runs on the client** (the browser, the user's own Claude Code/Codex), never on the Pi.
- **Open source, MIT.** The repo is public. Write code, comments and commits as if strangers will read them.

Status: device discovery (zigbee2mqtt), live dashboard and PWA, users/roles, per-device limits, pages and actions with triggers, AI config (MCP, client-side assistant, context file, optional server-side chat), 3D floor plan pages (three.js) and Docker release are done.
Roadmap, in order: **room scanning in the PWA** (writes the shared floor plan) → **end-to-end encrypted cloud gateway** (server applet relaying cloud ↔ mobile) → **Electron desktop app** → more providers.

## Stack

- npm workspaces monorepo, Node ≥ 20 (Docker uses Node 22), ES modules everywhere (`"type": "module"`), **plain JavaScript with JSDoc**, no TypeScript, no build step on the server.
- `apps/server`: Node.js on bare `node:http` (no Express), `mqtt`, `zod` (tool schemas), `@modelcontextprotocol/sdk`, `@anthropic-ai/sdk`. Tests with `node:test`.
- `apps/web`: Vite 5, **vanilla JS, no framework**, `three` for 3D pages (lazy-loaded), service worker in `public/sw.js`. Tests with `node:test` on pure modules.
- `apps/desktop`: Electron, placeholder only.
- `packages/shared`: shared code, nearly empty so far.
- Persistence: JSON files in `HOMEYVIBE_DATA_DIR` via `JsonStore` (atomic writes, mode 600). Device history uses Node's built-in SQLite in the same directory.

## Layout

```
apps/server/src/
  index.js                 wiring: env vars, stores, providers, HTTP server
  devices/registry.js      DeviceRegistry: provider-neutral, in-memory, emits events
  providers/zigbee2mqtt/   discovery from <base>/bridge/devices, exposes -> capabilities
  providers/demo/          simulated devices (HOMEYVIBE_DEMO=1)
  auth/                    roles.js (permissions), auth.js (users, sessions, hv_ tokens), access.js (limits, AI user)
  config/                  pages.js, actions.js (ActionStore + ActionEngine with triggers), floorplan.js, validate.js
  ai/                      tools.js (the one tool set), mcp.js, context.js (context file), importer.js, chat.js
  http/api.js              route table, SSE event stream, auth checks; errors.js (HttpError)
  store/json-store.js
apps/server/test/          *.test.js plus helpers.js (FakeMqttClient, startApi) and fixtures/
apps/web/src/
  main.js, api.js (fetch wrapper), ui.js (h() DOM helper, toast)
  controls.js              capability -> control mapping (pure, tested)
  floorplan.js             floor plan geometry and placement (pure, tested)
  ai/client-chat.js        browser-side Claude loop calling /api/ai/tools
  views/                   dashboard, home3d (three.js), chat, ai, users, limits, auth
docker/, Dockerfile, docker-compose.yml, .github/workflows/docker.yml
docs/                      architecture.md, docker.md, screenshots/
```

Detailed API, data formats and env vars: `apps/server/README.md`, `apps/web/README.md`, `docs/docker.md`. Keep those up to date when you change behavior.

## Core concepts

- **Device**: `{ id, provider, name, model, vendor, description, capabilities: [], state: {}, available, meta }`. Ids are stable and provider-prefixed (`z2m:<ieee_address>`, `demo:…`).
- **Capability**: flat description of one property: `property`, `name`, `type` (`binary|numeric|enum|text|composite|list`), `group`, `readable/writable/gettable`, plus `unit`, `min`, `max`, `values`, `valueOn/valueOff`, `category`. The UI and the AI derive everything from capabilities, so never special-case a device model in UI code.
- **Provider**: an object `{ id, command(device, values) }` registered with `registry.registerProvider()`. It discovers devices with `registry.upsert()`, reports state with `registry.updateState()`, availability with `setAvailable()`, and removes stale devices with `prune()`. `command` validates values against capabilities and throws `HttpError(400, …)` listing every problem. Use the zigbee2mqtt and demo providers as templates; a new provider must not need any change outside its folder plus one line of wiring in `index.js`.
- **Pages**: dashboard tabs with `layout` `grid|list|3d` and sections of device or action items.
- **Actions**: steps (`set`, `delay`, `run`) plus triggers (`state`, `time`). Run by buttons, AI or triggers through `ActionEngine`.
- **Floor plan**: one shared plan (`/api/floorplan`): rooms as `[x, z]` polygons in meters, devices at `[x, height, z]`. 3D pages render it; room scanning must write into this same format.
- **Roles and permissions**: `admin`, `member`, `guest`; permissions `devices:read`, `devices:control`, `config:write`, `users:manage` (`auth/roles.js`). Check with `can(user, PERMISSIONS.X)` or the route's `permission` option.
- **Limits**: per person and for the AI user (`auth/access.js`): per-device `control|view|hidden` and value ranges. When the AI acts for a person it gets the **intersection** of the person's and the AI user's rights. Use `scopedRegistry(registry, policy)` so hidden devices never leak.
- **AI tools**: defined once in `ai/tools.js` (`homeTools`). MCP (`POST /mcp`), the client-side assistant (`GET/POST /api/ai/tools`), the server-side chat and the context file all use them. Add or change a tool there, not per channel.
- **Live updates**: `GET /api/events` is Server-Sent Events (`snapshot`, `device`, `removed`, `state`, `pages`, `actions`, `run`, `floorplan`). The web app updates from this stream instead of polling.

## Run and test

```sh
npm install
npm run demo -w @homeyvibe/server   # :8080, simulated devices, no hardware
npm run dev -w @homeyvibe/web       # :5173, proxies /api and /mcp to :8080
npm test                            # all workspaces, node:test
npm run build -w @homeyvibe/web
```

With hardware: `MQTT_URL=mqtt://broker:1883 npm run dev -w @homeyvibe/server`. Data goes to `apps/server/data` unless `HOMEYVIBE_DATA_DIR` is set. Docker: `docker build --target server .` and `--target web`.

Server tests spin up the real HTTP handler with `startApi(registry)` from `test/helpers.js` (in-memory store, ready-made admin/member/guest tokens) and fake MQTT with `FakeMqttClient`. Use these instead of mocking internals.

## Rules

Do:

- Keep the server light enough for a Raspberry Pi: no model inference, no heavy native modules, no background CPU work. Anything LLM-related or compute-heavy (room scanning, image processing) runs on the client and sends the result to the server.
- Auto-detect instead of asking the user. If a choice is needed, offer a sensible default.
- Validate every input on the server and return **all** problems in one 400 response (`config/validate.js` style). AI clients rely on this to fix everything in one go.
- Enforce permissions and limits on every path that reads or changes a device or config: REST, SSE, MCP, AI tools, imports, action steps and the floor plan. Add a test for each new path that checks a guest/member/limited AI is refused.
- Make bulk changes all-or-nothing (see `apply_configuration` and the importer).
- Add tests with every feature (`apps/*/test/*.test.js`) and run `npm test` before committing. Put web logic that can be tested into pure modules (like `controls.js`, `floorplan.js`) and keep DOM code thin.
- Keep dependencies minimal. Ask before adding a framework or a dependency that can be avoided with a few lines of code.
- Update the relevant README/docs table when you add an endpoint, env var, event or tool.
- Follow the existing style: 2-space indent, single quotes, semicolons, ~120 columns, small classes and factory functions, JSDoc on exported functions, private fields (`#x`) for internals. Write user-facing text in plain, friendly English.
- Commit messages: short imperative sentence describing the user-visible change ("Add 3D pages with an editable floor plan"). One feature per branch and PR.

Don't:

- Don't add TypeScript, a frontend framework, Express, a separate database service, or a bundler on the server.
- Don't call an LLM from the server by default. The optional server-side chat (`ai/chat.js`) is the only exception and must stay optional.
- Don't send or store a user's AI API key on the server unless an admin explicitly chose the shared-key option. Client keys stay in the browser.
- Don't hardcode device models, vendors or zigbee2mqtt specifics outside `providers/zigbee2mqtt/`.
- Don't let the service worker cache `/api` or `/mcp`.
- Don't log or return secrets: passwords, session tokens, `hv_` tokens (stored hashed), API keys (only a key hint is returned).
- Don't weaken the same-origin and JSON checks on cookie-authenticated writes, or the login lockout.
- Don't open ports or add services in `docker-compose.yml` that expose the home network; HomeyVibe is meant to stay on the LAN (remote access will come through the E2E gateway).
- Don't break auto-update: images must keep building for amd64, arm64 and arm/v7 from `main`, and data must stay in `/data`. Migrate stored JSON formats in code when you change them; never require users to wipe data.
- Don't commit `apps/server/data/`, `.env` files or credentials.

## Planned features: design notes

- **Room scanning (PWA)**: runs entirely on the phone (camera, WebXR/AR or photos, on-device processing or the user's own AI key). Output is the floor plan format above, saved with `PUT /api/floorplan` (or merged room by room). The 3D view and placement logic in `apps/web/src/floorplan.js` should keep working unchanged.
- **E2E gateway**: a small relay ("server applet") so phones can reach the home server from outside without port forwarding. The relay only sees ciphertext; keys are paired between the home server and each client. The home server stays the source of truth.
- **Electron**: a thin shell around the web app; it can also host a local MCP bridge or AI client so the Pi stays light.
- **More providers**: same provider interface; auto-discovery, no per-device config.
