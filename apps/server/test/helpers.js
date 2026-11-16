import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';

export const bridgeDevices = readFileSync(new URL('./fixtures/bridge-devices.json', import.meta.url));

/** Minimal stand-in for an mqtt.js client. */
export class FakeMqttClient extends EventEmitter {
  connected = true;
  subscriptions = [];
  published = [];
  subscribe(topics) {
    this.subscriptions.push(...[].concat(topics));
  }
  publish(topic, payload, cb) {
    this.published.push({ topic, payload });
    cb?.();
  }
  receive(topic, payload) {
    const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload));
    this.emit('message', topic, buf);
  }
}
