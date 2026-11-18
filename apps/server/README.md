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
| `MQTT_URL` | `mqtt://localhost:1883` | Broker zigbee2mqtt publishes to |
| `MQTT_USERNAME` / `MQTT_PASSWORD` | | Broker credentials |
| `Z2M_BASE_TOPIC` | `zigbee2mqtt` | zigbee2mqtt `base_topic` |
| `HOMEYVIBE_DATA_DIR` | `apps/server/data` | Where users and sessions are stored |
| `HOMEYVIBE_DEMO` | | `1` loads simulated devices |

## zigbee2mqtt provider

Nothing to configure per device. The provider subscribes to:

- `<base>/bridge/devices` (retained): every device and its `exposes`, turned into capabilities
- `<base>/<friendly_name>`: live state
- `<base>/<friendly_name>/availability`: online or offline (needs availability enabled in zigbee2mqtt)

Renames and removals in zigbee2mqtt are picked up automatically. Device ids are stable (`z2m:<ieee_address>`).

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

## Pages and actions

**Pages** are dashboard tabs. Each has a title, optional icon, a layout (`grid`, `list`, or `3d` for later) and sections. A section holds items: a device (optionally limited to some `properties`) or an action button.

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

## AI configuration

Two ways to let an AI find devices, build pages and create actions. Both are under **Set up with AI** in the web app's user menu.

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
| `control_device` | control | set capability values |
| `run_action` | control | run an action now |
| `apply_configuration` | config | create or update many pages and actions at once, all-or-nothing |
| `save_page`, `save_action` | config | create or replace one |
| `delete_page`, `delete_action` | config | |

The prompt `set_up_my_home` asks the AI to propose pages and actions and apply them after you confirm. The server instructions describe the page and action formats.

### Context file (any AI)

`GET /api/ai/context` downloads a Markdown file describing every device, the current pages and actions, and the formats. Give it to any AI, then paste its JSON answer into the import box (`POST /api/ai/import`, admins). Imports are checked against real devices, capabilities and value ranges, and nothing is saved unless everything is valid.

### Built-in assistant

The chat button in the web app talks to Claude (`claude-opus-5-5` by default) with the same tools as the MCP server, limited by each person's role. An admin adds a Claude API key under **Set up with AI** (stored in the data directory, never sent back to browsers), or set `ANTHROPIC_API_KEY` for the server. Usage is billed to that key.

- `POST /api/ai/chat` with `{ message, conversationId? }` streams Server-Sent Events: `start`, `text` (`delta`), `tool` / `tool_result`, `done`, `error`.
- Turning things on and off happens straight away. The assistant describes deletions and bulk configuration changes first and waits for a yes.
- Conversations are kept in memory for 6 hours (10 per person).
- Requests use server-side refusal fallbacks (`fallbacks: "default"`) and prompt caching for the tool definitions and instructions.

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
| GET | `/api/events` | guest and up: Server-Sent Events, `snapshot` on connect, then `device`, `removed`, `state` (`{ id, changes }`), `pages`, `actions`, `run` |
| POST | `/api/devices/:id/set` | member and up: `{ "brightness": 120, "state": "ON" }`, validated against capabilities, returns 202 |
| GET, POST | `/api/users` | admin |
| PATCH | `/api/users/:id` | admin, or yourself for `displayName` / `password` |
| DELETE | `/api/users/:id` | admin (not yourself, never the last admin) |
| GET | `/api/pages`, `/api/pages/:id`, `/api/actions`, `/api/actions/:id` | guest and up |
| POST, PATCH, DELETE | `/api/pages[/:id]`, `/api/actions[/:id]` | admin (`config:write`) |
| POST | `/api/actions/:id/run` | member and up, returns `{ ok, error?, by, startedAt, finishedAt }` |

