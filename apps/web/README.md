# HomeyVibe web app

Vite frontend, installable as a PWA. Shows every discovered device as a card with controls generated from its capabilities:

| Capability | Control |
|---|---|
| writable binary | toggle |
| writable numeric with a range | slider |
| writable enum, up to 4 values | button group |
| writable enum, more values | dropdown |
| read-only values | live readout with unit |
| `category: diagnostic` (battery, link quality) | under "Details" |

State streams live from `GET /api/events` (Server-Sent Events), so changes from wall switches, automations or other clients show up immediately.

## Run

```sh
# terminal 1: server with simulated devices
npm run demo -w @homeyvibe/server
# terminal 2: web app on http://localhost:5173 (proxies /api to :8080)
npm run dev -w @homeyvibe/web
```

`npm test` covers the capability-to-control mapping. The service worker (`public/sw.js`) is only registered in production builds and caches the app shell, never `/api`.
