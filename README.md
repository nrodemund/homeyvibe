# HomeyVibe

A smart home platform whose core idea is **being easy**: everything is auto-detected, and configuration happens through an LLM.

## Vision

- **Auto-detect everything.** Find devices and their capabilities automatically. Full zigbee2mqtt support, with more providers pluggable.
- **Configure with AI.** Use direct connectors (Codex, Claude) or upload a context file. The AI finds devices, learns their capabilities, creates UI pages and creates actions.
- **Control by UI or AI.** Every device and action is reachable both ways.
- **Multiple page designs**, including 3D views built with three.js.
- **Room scanning** in the PWA to create a floor layout.
- **Users and roles.**
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

Sign in, then open **Set up with AI** in the user menu to connect Claude or Codex, to download a context file for any AI, or to add a Claude API key for the built-in assistant (the ✦ button).

With real hardware, start the server with `MQTT_URL=mqtt://your-broker:1883 npm run dev -w @homeyvibe/server` instead. See [apps/server](apps/server/README.md) and [apps/web](apps/web/README.md).

## License

To be decided. All rights reserved until a license is chosen.
