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
| GET | `/api/events` | guest and up: Server-Sent Events, `snapshot` on connect, then `device`, `removed`, `state` (`{ id, changes }`) |
| POST | `/api/devices/:id/set` | member and up: `{ "brightness": 120, "state": "ON" }`, validated against capabilities, returns 202 |
| GET, POST | `/api/users` | admin |
| PATCH | `/api/users/:id` | admin, or yourself for `displayName` / `password` |
| DELETE | `/api/users/:id` | admin (not yourself, never the last admin) |

