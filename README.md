# HomeyVibe

**Made with AI, configured with AI, used by you.**
Simple and secure smart home. Host it on your Raspberry Pi.

HomeyVibe finds your devices by itself, lets an AI set up pages and automations for you, and then gets out of the way. You control your home from the web, as an installable app on your phone, or by asking the assistant.

<p align="center">
  <img src="docs/screenshots/3d-page-desktop.png" alt="HomeyVibe 3D floor plan with live devices" width="72%" />
  <img src="docs/screenshots/assistant-chat-phone.png" alt="HomeyVibe assistant on a phone" width="22%" />
</p>

## Why HomeyVibe

- **Made with AI.** HomeyVibe itself is built with AI coding agents, in the open.
- **Configured with AI.** Connect Claude or Codex over MCP, chat with the built-in assistant, or download a context file for any AI. It learns your devices and their capabilities, then creates pages and actions for you.
- **Used by you.** Every device and action works from the UI and from AI, on the web, as a PWA, and (soon) on the desktop.
- **Simple.** Everything is auto-detected. Full zigbee2mqtt support, more providers pluggable.
- **Secure.** Your home runs on your own hardware. Users and roles, per-device limits and value ranges (for people and for the AI's own user), and a planned end-to-end encrypted gateway for remote access.
- **Lightweight.** The server runs on a Raspberry Pi. The AI work happens on your phone or computer, or at the AI provider, never on the Pi.

## Features

- Auto-discovery of devices and their capabilities (zigbee2mqtt today, more providers to come)
- Live dashboard with controls generated from each device's capabilities
- Pages and actions (scenes and automations with triggers)
- 3D floor plans with configurable rooms, sensor displays, light effects, and one-click device presets
- Users and roles, plus limits such as "radiator only between 18 and 22 °C"
- Manual page, scene and automation editors, with AI configuration via MCP, the built-in assistant, or a context file
- Optional remote access through an [outbound Docker relay](docs/relay.md), with HTTPS from your phone to the Pi
- Planned: room scanning in the PWA to create the floor plan and an Electron desktop app

## Run it on a Raspberry Pi

You need a Raspberry Pi 3, 4 or 5 (64-bit Raspberry Pi OS recommended) with Docker installed.

```sh
mkdir homeyvibe && cd homeyvibe
curl -fsSLO https://raw.githubusercontent.com/nrodemund/homeyvibe/main/docker-compose.yml
docker compose up -d                      # if you already run an MQTT broker and zigbee2mqtt
docker compose --profile zigbee up -d     # or: also start Mosquitto and zigbee2mqtt
```

Open `http://<your-pi>` and create the first admin account. HomeyVibe updates itself: every change on the `main` branch is built into new images, and the Pi picks them up within an hour. See [docs/docker.md](docs/docker.md) for settings, updates, backups and pinning a version.

Already running Zigbee2MQTT with Mosquitto? Open the user menu → **Zigbee2MQTT** to see the broker and device discovery status. If the automatic search comes up empty, enter the MQTT address, credentials and base topic from your existing Zigbee2MQTT configuration. For a Docker install, use an address reachable from the HomeyVibe container, such as the Pi’s LAN IP or a shared Docker service name.

Use **Pages** and **Actions** in the user menu to build dashboards, scenes and automations manually, or choose **Set up with AI** for the same configuration tools.

Just want a look? Add `HOMEYVIBE_DEMO=1` and `MQTT_URL=` to a `.env` file next to `docker-compose.yml` to get simulated devices with example pages.

## Where the AI runs

The server is meant to run on small hardware such as a Raspberry Pi (Node 22, a few tens of MB of RAM). It only stores configuration, talks to zigbee2mqtt and controls devices. **All AI work happens on the device you configure from**, and the Pi doesn't need internet access for it:

- **Assistant in the app (✦).** Each phone or computer saves its own Claude API key in the browser and calls Claude directly. The server only runs the tools (`GET`/`POST /api/ai/tools`), with the same permissions and limits as everywhere else. The key never reaches the server.
- **Codex, Claude Code or another MCP app on your computer.** In **Set up with AI**, generate a personal access token and follow the setup for your computer. Codex connects to the Pi’s `/mcp` endpoint from your LAN or VPN. You can use Codex while signed in with your ChatGPT account.
- **A context file for ChatGPT or another AI.** Download it, ask for a HomeyVibe configuration, and import the returned JSON under **Set up with AI**.

Optionally, an admin can select **OpenAI** or **Claude** under **Set up with AI → Shared assistant** and add a project API key. The Pi calls the selected API over HTTPS for browsers without a local Claude key. Usage is billed to the API project.

## Develop

```sh
npm install
npm run demo -w @homeyvibe/server   # simulated devices, no hardware needed
npm run dev -w @homeyvibe/web       # http://localhost:5173
npm test
```

Sign in, then open the ✦ assistant and add a Claude API key on that device, or open **Set up with AI** in the user menu to connect Claude Code or Codex, or to download a context file for any AI.

With real hardware, start the server with `MQTT_URL=mqtt://your-broker:1883 npm run dev -w @homeyvibe/server` instead. See [apps/server](apps/server/README.md) and [apps/web](apps/web/README.md).

### Layout

```
apps/
  server/    Node.js backend (device providers, automation, API, MCP)
  web/       Vite frontend (web + PWA)
  desktop/   Electron shell (planned)
packages/
  shared/    Shared types and protocol definitions
docker/      Container configuration (Caddy)
docs/        Architecture and deployment notes
```

## Security

Please report vulnerabilities privately, see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
