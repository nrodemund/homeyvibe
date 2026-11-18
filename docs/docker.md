# Running HomeyVibe with Docker

HomeyVibe ships as two small images, built for `linux/amd64`, `linux/arm64` (Raspberry Pi 3/4/5 on 64-bit OS) and `linux/arm/v7` (32-bit Raspberry Pi OS):

| Image | What it is |
|---|---|
| `ghcr.io/nrodemund/homeyvibe` | Node.js server: device providers, API, MCP endpoint. Stores everything in `/data`. |
| `ghcr.io/nrodemund/homeyvibe-web` | Caddy serving the web app/PWA, forwarding `/api` and `/mcp` to the server. |

Only the web container is published on the network (port 80 by default). The AI configuration runs on your phone or computer (Claude, Codex, the built-in assistant via the Claude API), so the Pi only serves HomeyVibe and never runs a model.

## Install

```sh
curl -fsSL https://get.docker.com | sh          # if Docker is not installed yet
sudo usermod -aG docker $USER && newgrp docker

mkdir ~/homeyvibe && cd ~/homeyvibe
curl -fsSLO https://raw.githubusercontent.com/nrodemund/homeyvibe/main/docker-compose.yml
curl -fsSL -o .env https://raw.githubusercontent.com/nrodemund/homeyvibe/main/docker/.env.example
nano .env                                        # optional, defaults work for most setups
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

Set `MQTT_URL` (and `MQTT_USERNAME` / `MQTT_PASSWORD` if needed) in `.env` and start without the profile.

## Settings (`.env`)

| Variable | Default | |
|---|---|---|
| `HOMEYVIBE_PORT` | `80` | Port the web app is published on |
| `HOMEYVIBE_TAG` | `latest` | Image tag to run: `latest` (main branch), `stable` (latest release), or a version such as `1.2` |
| `MQTT_URL` | `mqtt://mosquitto:1883` | Broker zigbee2mqtt publishes to. Set it to empty to run without MQTT. |
| `MQTT_USERNAME` / `MQTT_PASSWORD` | | Broker credentials |
| `Z2M_BASE_TOPIC` | `zigbee2mqtt` | zigbee2mqtt `base_topic` |
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

All HomeyVibe data (users, pages, actions, floor plan, AI settings) is in the `homeyvibe_homeyvibe-data` volume:

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
