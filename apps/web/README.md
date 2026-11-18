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

Admins can use **Zigbee2MQTT** in the user menu to connect a broker and check discovery. **Pages** edits dashboard layouts, sections and controls. Use the arrows to reorder tabs and **Set as start page** to choose what opens at the dashboard root. **Actions** edits scenes and routines with device settings, delays and time or state triggers.

Under **Set up with AI**, connect Codex over MCP, download a context file for ChatGPT, or select OpenAI or Claude for the optional shared assistant.

## 3D pages

Pages with layout `3d` render the home's floor plan with three.js (loaded only when such a page opens). Admins can choose **Edit layout**, then select a room or device directly on the plan or from **Select object**.

- **Rooms** can have custom floor and wall colors, wall height, thickness and opacity, and colored outlines. **Doors and windows** cuts openings into a numbered wall. Set the offset, width and height in meters and use sill height to position a window above the floor.
- **Devices** can be dragged or moved to a different height. The **Display** group offers a live value, gradient, badge, bar, dial, plot, trend arrow, thermometer, threshold, status, icon, or automatic summary. The choices follow the model's capabilities. Plots and trend arrows use up to 24 hours of numeric readings in server memory, collected while HomeyVibe is running.
- **Click behavior** can open the full card, send a preset command to that device, run a saved action, show a message in HomeyVibe, or do nothing. When a marker has a custom click, use the **i** button to open its full controls. Commands and actions use your normal permissions and limits.
- **Room lighting** lets lights illuminate the room when on, following the device's brightness. Set the effect's strength and color under the light's layout settings.

## Run

```sh
# terminal 1: server with simulated devices
npm run demo -w @homeyvibe/server
# terminal 2: web app on http://localhost:5173 (proxies /api to :8080)
npm run dev -w @homeyvibe/web
```

`npm test` covers the capability-to-control mapping and the floor plan geometry and placement. The service worker (`public/sw.js`) is only registered in production builds and caches the app shell, never `/api`.
