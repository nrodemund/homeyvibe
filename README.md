# HomeyVibe

A smart home platform whose core idea is **being easy**: everything is auto-detected, and configuration happens through an LLM.

## Vision

- **Auto-detect everything.** Find devices and their capabilities automatically. Full zigbee2mqtt support, with more providers pluggable.
- **Configure with AI.** Use direct connectors (Codex, Claude) or upload a context file. The AI finds devices, learns their capabilities, creates UI pages and creates actions.
- **Control by UI or AI.** Every device and action is reachable both ways.
- **Multiple page designs**, including 3D views of your floor plan built with three.js.
- **Room scanning** in the PWA to create a floor layout.
- **Users and roles**, with per-device limits and value ranges for people and for the AI's own user.
- **Gateways.** A server applet bridges cloud to mobile with end-to-end encryption.
- **Runs everywhere.** Web, PWA, and Electron desktop.

## Layout

```
apps/
  server/    Node.js backend (device providers, automation, API)
  web/       Vite frontend (web + PWA)
  desktop/   Electron shell (planned)
packages/
  shared/    Shared types and protocol definitions
docs/        Architecture notes
```

## Getting started

```sh
npm install
npm run demo -w @homeyvibe/server   # simulated devices, no hardware needed
npm run dev -w @homeyvibe/web       # http://localhost:5173
```

Sign in, then open the ✦ assistant and add a Claude API key on that device, or open **Set up with AI** in the user menu to connect Claude Code or Codex, or to download a context file for any AI.

With real hardware, start the server with `MQTT_URL=mqtt://your-broker:1883 npm run dev -w @homeyvibe/server` instead. See [apps/server](apps/server/README.md) and [apps/web](apps/web/README.md).

## Running on a Raspberry Pi

The server is meant to run on small hardware such as a Raspberry Pi (Node 22, a few tens of MB of RAM). It only stores configuration, talks to zigbee2mqtt and controls devices. **All AI work happens on the device you configure from**, and the Pi doesn't need internet access for it:

- **Assistant in the app (✦).** Each phone or computer saves its own Claude API key in the browser and calls Claude directly. The server only runs the tools (`GET`/`POST /api/ai/tools`), with the same permissions and limits as everywhere else. The key never reaches the server.
- **Claude Code, Codex or another MCP app on your computer.** These connect to the Pi's `/mcp` endpoint with a personal access token.
- **A context file for any AI.** Download it, ask the AI, and paste the answer back.

Optionally, an admin can store a shared key on the server instead. The server then calls Claude for devices that have no key of their own.

## License

To be decided. All rights reserved until a license is chosen.
