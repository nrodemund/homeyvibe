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

## zigbee2mqtt provider

Nothing to configure per device. The provider subscribes to:

- `<base>/bridge/devices` (retained): every device and its `exposes`, turned into capabilities
- `<base>/<friendly_name>`: live state
- `<base>/<friendly_name>/availability`: online or offline (needs availability enabled in zigbee2mqtt)

Renames and removals in zigbee2mqtt are picked up automatically. Device ids are stable (`z2m:<ieee_address>`).

Each capability has `property`, `name`, `type` (`binary`, `numeric`, `enum`, `text`, `composite`, `list`), `group` (e.g. `light`, `switch_left`), `readable` / `writable` / `gettable`, plus type details such as `unit`, `min`, `max`, `values`, `valueOn` / `valueOff`.

## API

| Method | Path | |
|---|---|---|
| GET | `/api/health` | Status and device count |
| GET | `/api/devices` | All devices with capabilities and state |
| GET | `/api/devices/:id` | One device |
| GET | `/api/events` | Server-Sent Events: `snapshot` (all devices) on connect, then `device`, `removed`, `state` (`{ id, changes }`) |
| POST | `/api/devices/:id/set` | Body `{ "brightness": 120, "state": "ON" }`. Validated against capabilities, then sent to the device. Returns 202. |
