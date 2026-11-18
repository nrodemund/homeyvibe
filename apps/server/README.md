# HomeyVibe server

Node.js backend. Providers discover devices and their capabilities and put them in a shared device registry, which the HTTP API exposes.

## Run

```sh
MQTT_URL=mqtt://your-broker:1883 npm run dev
npm run demo   # simulated devices, no broker needed
npm test
```

| Variable | Default | |
|---|---|---|
| `PORT` | `8080` | HTTP port |
| `MQTT_URL` | `auto` | Broker Zigbee2MQTT publishes to. Set an explicit broker URL, or leave the value empty to disable MQTT. |
| `MQTT_USERNAME` / `MQTT_PASSWORD` | | Broker credentials |
| `Z2M_BASE_TOPIC` | empty | Exact Zigbee2MQTT base topic. A blank value detects a single-level topic. |
| `HOMEYVIBE_DATA_DIR` | `apps/server/data` | Where users and sessions are stored |
| `HOMEYVIBE_DEMO` | | `1` loads simulated devices |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` | | Optional project keys for the shared assistant |

## zigbee2mqtt provider

Admins can change the connection and check discovery status in **Zigbee2MQTT** in the user menu. Saved fields override environment defaults. The provider subscribes to:

- `<base>/bridge/devices` (retained): every device and its `exposes`, turned into capabilities
- `<base>/bridge/state`: bridge online/offline state
- `<base>/<friendly_name>`: live state
- `<base>/<friendly_name>/availability`: online or offline (needs availability enabled in zigbee2mqtt)

Renames and removals in Zigbee2MQTT are picked up automatically. Device IDs are stable (`z2m:<ieee_address>`). Retained state initializes device controls after discovery or reconnect. State triggers run on live reports.

Each capability has `property`, `name`, `type` (`binary`, `numeric`, `enum`, `text`, `composite`, `list`), `group` (e.g. `light`, `switch_left`), `readable` / `writable` / `gettable`, plus type details such as `unit`, `min`, `max`, `values`, `valueOn` / `valueOff`.

## Users and roles

On first start there are no users. The web app shows a setup screen that creates the first **admin**. Admins add everyone else under **People**.

| Role | Can |
|---|---|
| Admin | everything, including people and configuration |
| Member | see and control devices |
| Guest | see devices only |

Passwords are hashed with scrypt. Sessions are random tokens (only their SHA-256 is stored), valid for 30 days, sent as an `HttpOnly; SameSite=Lax` cookie for the web app or as `Authorization: Bearer <token>` for scripts and AI clients. Changing a password signs that person out everywhere. Five wrong passwords lock a username for 30 seconds. Cookie-based writes must be JSON and come from the same origin.

Behind a reverse proxy, keep the `Host` header (or set `X-Forwarded-Host`) and `X-Forwarded-Proto: https` so cookies get the `Secure` flag.

## Limits and the HomeyVibe AI user

Admins can limit what a person (not an admin) or the AI may do, under **People**:

- per device: **Control**, **View only** or **Hidden**, plus a default for new devices
- value ranges on writable numbers, e.g. a radiator's target temperature only between 18 and 22 °C

The AI has its own entry ("HomeyVibe AI") with two extra switches: *can control devices* and *can change pages, actions and the floor plan*. Whenever the AI acts (the in-app chat, MCP, the context file) it gets only what both the person using it and the AI user may do. Limits are checked on every path: device commands, running actions (every step is checked first, so nothing runs half way), actions the AI writes, and floor plan edits (the AI cannot remove devices it cannot see). Hidden devices are left out of `/api/devices`, the event stream and the AI's view. Automations triggered by state or time are not limited.

`GET /api/access`, `PUT /api/access/ai` and `PUT /api/access/users/:id` (users:manage) read and change them; see `src/auth/access.js`.

## Pages and actions

**Pages** are dashboard tabs. Each has a title, optional icon, a layout (`grid`, `list` or `3d`) and sections. A section holds items: a device (optionally limited to some `properties`) or an action button.

```json
{ "title": "Living room", "icon": "🛋️", "sections": [
  { "title": "Scenes", "items": [{ "type": "action", "actionId": "movie-night" }] },
  { "title": "Lights", "items": [{ "type": "device", "deviceId": "z2m:0x…", "properties": ["state", "brightness"] }] }
] }
```

**Actions** are named lists of steps, run from a button, by the AI, or by triggers:

- steps: `set` (`deviceId`, `values`), `delay` (`seconds`), `run` (another `actionId`, up to 5 levels deep)
- triggers: `state` (`deviceId`, `property`, `op` of `eq|ne|gt|lt|gte|lte|changed`, `value`) and `time` (`at: "07:30"`, optional `days: ["mon", …]`, server local time)

```json
{ "name": "Fan when humid", "steps": [{ "type": "set", "deviceId": "z2m:0x…", "values": { "state": "ON" } }],
  "triggers": [{ "type": "state", "deviceId": "z2m:0x…", "property": "humidity", "op": "gt", "value": 70 }] }
```

Ids are generated from the title or name (`living-room`) unless given. Validation returns every problem in one 400 response, which helps AI clients fix everything in one go. A triggered action won't re-trigger within 2 seconds, so it can't loop on its own state changes.

Pages may have `startPage: true`. Setting it clears the selection on the previous start page. `PUT /api/pages/order` takes `{ ids: ["page-a", "page-b"] }`, containing all page IDs in the desired order. Existing `order` values determine initial ordering.

## Floor plan (3D pages)

Pages with layout `3d` show one shared floor plan with live devices in it. `GET /api/floorplan` (devices:read) returns it and `PUT /api/floorplan` (config:write) replaces it; changes stream as the `floorplan` event.

```json
{ "rooms": [{ "name": "Living room", "floor": 0, "height": 2.5, "points": [[0, 0], [5, 0], [5, 4], [0, 4]] }],
  "devices": [{ "deviceId": "z2m:0x…", "roomId": "living-room", "position": [2.5, 2.2, 2] }] }
```

Coordinates are meters seen from above (`points` are `[x, z]` corners in order; `position` is `[x, height, z]`). Room ids come from names. A 3D page shows the devices listed in its sections, or every placed device when it lists none. The AI can edit the plan with the `save_floorplan` tool or a `floorplan` key in an import bundle, and room scanning will write it too.

- Room `style` accepts `floorColor`, `wallColor`, and `edgeColor` as hex colors, `wallHeight` and `wallThickness` in meters, `wallOpacity` from 0 to 1, and `edges` as a boolean.
- Room `openings` entries have `type` (`door` or `window`), `edge` (zero-based index of the wall's first corner), `offset`, `width`, `bottom` and `height`. Lengths are measured in meters. `bottom` is zero for a door and defaults to 0.8 for a window.
- A placement's `display` has a `mode` and optional `property`, `min`, `max`, `threshold`, `lowColor` and `highColor`. Modes are `auto`, `value`, `color`, `badge`, `bar`, `gauge`, `chart`, `trend`, `thermometer`, `threshold`, `status` and `icon`.
- `click` modes are `details` (the default), `command` with capability `values`, `action` with `actionId`, `message` with text, and `none`. The client uses the regular device or action endpoint. `light` supports `enabled`, `color` and `strength` (0–2).
- `GET /api/devices/:id/history?property=temperature` returns `{ points: [[timestampMs, value], …] }` for a visible, readable numeric capability. The server keeps the latest sample per five-minute interval for up to 24 hours in memory.

## AI configuration

The **Set up with AI** dialog offers MCP, the built-in assistant and a context file.

### Client-side assistant (recommended, e.g. for a Raspberry Pi)

The web app's assistant calls Claude from the browser with a key kept on that device. The server only describes and runs the tools:

- `GET /api/ai/tools` returns `{ model, system, tools }` (JSON Schema inputs) for the signed-in person
- `POST /api/ai/tools/:name` runs one tool. The body is the tool input and the reply is `{ ok, text }`. It applies the same validation, permissions and limits as MCP.

Any client (the desktop app, a script) can drive its own model the same way.

### MCP server (Claude, Codex, any MCP client)

`POST /mcp` is a stateless [Model Context Protocol](https://modelcontextprotocol.io) endpoint (Streamable HTTP). Create a personal access token in the web app; the AI acts with that person's role.

```sh
claude mcp add --transport http homeyvibe http://your-server:8080/mcp --header "Authorization: Bearer hv_…"
```

```toml
# ~/.codex/config.toml (and export HOMEYVIBE_TOKEN=hv_…)
[mcp_servers.homeyvibe]
url = "http://your-server:8080/mcp"
bearer_token_env_var = "HOMEYVIBE_TOKEN"
```

Apps that only speak stdio (e.g. Claude Desktop) can use `npx -y mcp-remote http://your-server:8080/mcp --header "Authorization: Bearer hv_…"` (add `--allow-http` for a non-localhost plain-HTTP URL).

| Tool | Needs | |
|---|---|---|
| `get_home_overview` | read | devices with capabilities and state, pages, actions |
| `list_devices` | read | search by name, vendor, model or id |
| `diagnose_zigbee2mqtt` | config | explain the current discovery status with generic troubleshooting guidance |
| `control_device` | control | set capability values |
| `run_action` | control | run an action now |
| `apply_configuration` | config | create or update many pages and actions at once, all-or-nothing |
| `save_page`, `save_action` | config | create or replace one |
| `delete_page`, `delete_action` | config | |

The prompt `set_up_my_home` asks the AI to propose pages and actions and apply them after you confirm. The server instructions describe the page and action formats.

### Context file (any AI)

`GET /api/ai/context` downloads a Markdown file describing every device, the current pages and actions, and the formats. Give it to any AI, then paste its JSON answer into the import box (`POST /api/ai/import`, admins). Imports are checked against real devices, capabilities and value ranges, and nothing is saved unless everything is valid.

### Server-side assistant (optional)

Browsers without a local Claude key can use a shared OpenAI (`gpt-5-mini` by default) or Claude (`claude-opus-5-5` by default) project key. An admin chooses the provider and model under **Set up with AI → Shared assistant**. The server can also read `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` from its environment. Browsers receive only the provider, model and key status. The tools keep the same permissions and limits as MCP. Usage is billed to the provider’s API project.

- `POST /api/ai/chat` with `{ message, conversationId? }` streams Server-Sent Events: `start`, `text` (`delta`), `tool` / `tool_result`, `done`, `error`.
- Turning things on and off happens straight away. The assistant describes deletions and bulk configuration changes first and waits for a yes.
- Conversations are kept in memory for 6 hours (10 per person).
- Claude requests use server-side refusal fallbacks (`fallbacks: "default"`) and prompt caching for the tool definitions and instructions.

### Access tokens

`GET/POST /api/auth/tokens`, `DELETE /api/auth/tokens/:id`. Tokens start with `hv_`, are shown once, stored hashed, and are removed when their user is deleted.

## API

Everything except health and sign-in needs a session.

| Method | Path | Who |
|---|---|---|
| GET | `/api/health` | anyone |
| GET | `/api/auth/status` | anyone: `{ needsSetup, user }` |
| POST | `/api/auth/setup` | anyone, only while there are no users: `{ username, password, displayName? }` |
| POST | `/api/auth/login` | anyone: `{ username, password }`, returns `{ token, user }` and sets the cookie |
| POST | `/api/auth/logout` | anyone |
| GET | `/api/auth/me` | signed in |
| GET | `/api/roles` | signed in |
| GET | `/api/devices`, `/api/devices/:id` | guest and up |
| GET | `/api/devices/:id/history?property=…` | any user who can see the device |
| GET, PUT, DELETE | `/api/integrations/zigbee2mqtt` | admin. Read status, replace settings (`mode`, `url`, `username`, `password`, `baseTopic`) or restore defaults. Password is write-only. |
| POST | `/api/integrations/zigbee2mqtt/retry` | admin. Reconnect and rediscover using active settings. |
| GET | `/api/events` | guest and up: Server-Sent Events, `snapshot` on connect, then `device`, `removed`, `state` (`{ id, changes }`), `pages`, `actions`, `run` |
| POST | `/api/devices/:id/set` | member and up: `{ "brightness": 120, "state": "ON" }`, validated against capabilities, returns 202 |
| GET, POST | `/api/users` | admin |
| PATCH | `/api/users/:id` | admin, or yourself for `displayName` / `password` |
| DELETE | `/api/users/:id` | admin (not yourself, never the last admin) |
| GET | `/api/pages`, `/api/pages/:id`, `/api/actions`, `/api/actions/:id` | guest and up |
| POST, PATCH, DELETE | `/api/pages[/:id]`, `/api/actions[/:id]` | admin (`config:write`) |
| PUT | `/api/pages/order` | admin (`config:write`), replaces page ordering |
| POST | `/api/actions/:id/run` | member and up, returns `{ ok, error?, by, startedAt, finishedAt }` |
| GET, PATCH | `/api/ai/settings` | signed-in users can read status. Admins may update `{ provider?, apiKey?, model? }`. |

