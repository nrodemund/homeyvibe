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

## Configuration

Admins can use **Zigbee2MQTT** in the user menu to connect a broker and check discovery. **Pages** edits dashboard layouts, sections and controls. **Actions** edits scenes and routines with device settings, delays and time or state triggers.

Under **Set up with AI**, connect Codex over MCP, download a context file for ChatGPT, or select OpenAI or Claude for the optional shared assistant.

## 3D pages

Pages with layout `3d` render the home's floor plan with three.js (loaded only when such a page opens). Lights glow with their brightness, every device has a live label, and tapping one opens its controls. Admins can choose **Edit layout** to draw rooms by dragging on the floor, rename or delete rooms, drag devices into place, set their height, and place devices that are not in the plan yet. Devices without a position are guessed from room names in the device name or its page section.

## Run

```sh
# terminal 1: server with simulated devices
npm run demo -w @homeyvibe/server
# terminal 2: web app on http://localhost:5173 (proxies /api to :8080)
npm run dev -w @homeyvibe/web
```

`npm test` covers the capability-to-control mapping and the floor plan geometry and placement. The service worker (`public/sw.js`) is only registered in production builds and caches the app shell, never `/api`.
