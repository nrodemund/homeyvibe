import { createServer } from 'node:http';
import mqtt from 'mqtt';
import { DeviceRegistry } from './devices/registry.js';
import { createZigbee2mqttProvider } from './providers/zigbee2mqtt/index.js';
import { createApiHandler } from './http/api.js';

const port = Number(process.env.PORT ?? 8080);
const mqttUrl = process.env.MQTT_URL ?? 'mqtt://localhost:1883';
const z2mBaseTopic = process.env.Z2M_BASE_TOPIC ?? 'zigbee2mqtt';

const registry = new DeviceRegistry();

const client = mqtt.connect(mqttUrl, {
  username: process.env.MQTT_USERNAME,
  password: process.env.MQTT_PASSWORD,
  reconnectPeriod: 5000,
});
client.on('connect', () => console.log(`MQTT connected: ${mqttUrl}`));
client.on('error', (err) => console.warn(`MQTT error: ${err.message}`));

createZigbee2mqttProvider({ client, registry, baseTopic: z2mBaseTopic, log: console.log });

createServer(createApiHandler({ registry })).listen(port, () =>
  console.log(`HomeyVibe server on :${port}`),
);
