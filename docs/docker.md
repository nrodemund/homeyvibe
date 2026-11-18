# Running HomeyVibe with Docker

HomeyVibe ships as two small images, built for `linux/amd64`, `linux/arm64` (Raspberry Pi 3/4/5 on 64-bit OS) and `linux/arm/v7` (32-bit Raspberry Pi OS):

| Image | What it is |
|---|---|
| `ghcr.io/nrodemund/homeyvibe` | Node.js server: device providers, API, MCP endpoint. Stores everything in `/data`. |
| `ghcr.io/nrodemund/homeyvibe-web` | Caddy serving the web app/PWA, forwarding `/api` and `/mcp` to the server. |

Only the HomeyVibe web container is published on the network (port 80 by default). AI configuration can run from your phone or computer. With a shared AI key, the Pi sends API requests to the selected provider. Models run remotely.

## Install

```sh
curl -fsSL https://get.docker.com | sh          # if Docker is not installed yet
sudo usermod -aG docker $USER && newgrp docker

mkdir ~/homeyvibe && cd ~/homeyvibe
curl -fsSLO https://raw.githubusercontent.com/nrodemund/homeyvibe/main/docker-compose.yml
curl -fsSL -o .env https://raw.githubusercontent.com/nrodemund/homeyvibe/main/docker/.env.example
nano .env                                        # optional, for deployment settings
docker compose up -d
```

Open `http://<your-pi>` (or `http://<your-pi>:<HOMEYVIBE_PORT>`) and create the first admin.

### With zigbee2mqtt included

If you do not run MQTT and zigbee2mqtt yet, the `zigbee` profile starts both next to HomeyVibe:

```sh
ls -l /dev/serial/by-id/                         # find your Zigbee adapter
echo "ZIGBEE_ADAPTER=/dev/serial/by-id/usb-..." >> .env
docker compose --profile zigbee up -d
```

zigbee2mqtt's own UI is on port 8081. On its very first start it may ask you to confirm the adapter there. HomeyVibe picks up every paired device automatically. The bundled Mosquitto broker is only reachable from the containers; uncomment its `ports` in `docker-compose.yml` if other devices on your network need it.

### Existing MQTT broker

Start without the `zigbee` profile so HomeyVibe can use your existing Mosquitto instance. The default search tries the bundled Docker service name `mosquitto`, the Docker host address `host.docker.internal` and loopback for a native install. It selects a broker when it receives a Zigbee2MQTT device catalog.

If it comes up empty, open the user menu → **Zigbee2MQTT**. Use **Enter a broker address** and copy the MQTT server, username, password and base topic from Zigbee2MQTT’s MQTT configuration. HomeyVibe reconnects as soon as you save. The status shows connection, authentication, topic permissions and the number of paired devices in the catalog.

- **Mosquitto on the Pi itself:** Use the Pi’s LAN IP with Mosquitto’s port, typically `mqtt://192.168.1.20:1883`. The Compose file also maps `host.docker.internal` to the Docker host. Mosquitto needs a listener reachable from the HomeyVibe container. A listener bound to `127.0.0.1` is only reachable on the Pi itself.
- **Mosquitto in a separate Compose project:** Use the broker’s published address, or connect HomeyVibe’s server and Mosquitto to the same Docker network and use the broker’s service name.
- **Mosquitto on another machine:** Use its hostname or IP and MQTT port. Use `mqtts://` for TLS, with a certificate the HomeyVibe server trusts.
- **Custom Zigbee2MQTT topics:** Enter the exact `mqtt.base_topic` when it contains slashes, multiple bridges exist, or the MQTT account lacks wildcard subscription permissions. With a blank field, HomeyVibe detects a single-level topic.

You can also set `MQTT_URL`, `MQTT_USERNAME`, `MQTT_PASSWORD` and `Z2M_BASE_TOPIC` in `.env`. Saved settings take precedence. Use **Restore deployment defaults** to switch back to the environment.

## Settings (`.env`)

| Variable | Default | |
|---|---|---|
| `HOMEYVIBE_PORT` | `80` | Port the web app is published on |
| `HOMEYVIBE_TAG` | `latest` | Image tag to run: `latest` (main branch), `stable` (latest release), or a version such as `1.2` |
| `MQTT_URL` | `auto` | Search common local broker addresses. Use a URL for an explicit broker, or leave the value empty to disable MQTT. |
| `MQTT_USERNAME` / `MQTT_PASSWORD` | | Broker credentials |
| `Z2M_BASE_TOPIC` | empty | Exact Zigbee2MQTT base topic. A blank value detects a single-level topic. |
| `HOMEYVIBE_DEMO` | `0` | `1` adds simulated devices and example pages |
| `UPDATE_INTERVAL` | `3600` | Seconds between update checks |
| `ZIGBEE_ADAPTER` | `/dev/ttyUSB0` | Zigbee adapter, `zigbee` profile only |
| `TZ` | `Etc/UTC` | Time zone, used for scheduled actions |

After changing `.env`, run `docker compose up -d` again.

## Automatic updates from git

Updates follow the git repository without the Pi ever building anything:

1. Every push to `main` triggers the [Docker images workflow](../.github/workflows/docker.yml), which builds both images for all three architectures and pushes them to GitHub Container Registry as `latest`. Release tags (`v1.2.3`) also publish `1.2.3`, `1.2` and `stable`.
2. The `updater` service in `docker-compose.yml` runs `docker compose pull` every `UPDATE_INTERVAL` seconds and recreates only the containers whose image changed. Your data lives in Docker volumes and is kept.

To follow releases instead of every commit, set `HOMEYVIBE_TAG=stable`. To update only by hand, remove the `updater` service and run `docker compose pull && docker compose up -d` when you like.

The updater needs access to the Docker socket to restart containers. It only ever touches the `server` and `web` services of this compose project; Mosquitto and zigbee2mqtt are left alone so a firmware or major version change never surprises you. Update those with `docker compose --profile zigbee pull && docker compose --profile zigbee up -d`.

> **Note.** We moved away from Watchtower on purpose: the original project is no longer maintained and does not work with Docker 29. The updater is a ten-line shell loop using the official `docker` CLI image, defined inline in `docker-compose.yml`.

## Backups

All HomeyVibe data (users, pages, actions, floor plan, AI settings and broker settings) is in the `homeyvibe_homeyvibe-data` volume:

```sh
docker run --rm -v homeyvibe_homeyvibe-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/homeyvibe-$(date +%F).tgz -C /data .
```

## Remote access and HTTPS

HomeyVibe is meant to stay on your home network. Do not forward port 80 on your router. Until the end-to-end encrypted gateway lands, use a VPN such as WireGuard or Tailscale to reach it from outside. If you put it behind your own reverse proxy with HTTPS, forward the `Host` header unchanged (or set `X-Forwarded-Host`), since the server checks that requests come from the same origin.

## Build the images yourself

```sh
git clone https://github.com/nrodemund/homeyvibe && cd homeyvibe
docker build --target server -t ghcr.io/nrodemund/homeyvibe:latest .
docker build --target web -t ghcr.io/nrodemund/homeyvibe-web:latest .
docker compose up -d --pull never
```

Remove the `updater` service when you run self-built images, or it replaces them with the published ones.
