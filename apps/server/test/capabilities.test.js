import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseExposes, validateValue } from '../src/providers/zigbee2mqtt/capabilities.js';
import { bridgeDevices } from './helpers.js';

const devices = JSON.parse(bridgeDevices);
const lamp = devices[1];
const sw = devices[3];

test('flattens light features and keeps top-level exposes', () => {
  const caps = parseExposes(lamp.definition.exposes);
  assert.deepEqual(caps.map((c) => c.property), ['state', 'brightness', 'color_temp', 'color', 'effect', 'linkquality']);
  const state = caps.find((c) => c.property === 'state');
  assert.equal(state.group, 'light');
  assert.equal(state.valueOn, 'ON');
  assert.equal(state.valueToggle, 'TOGGLE');
  assert.ok(state.readable && state.writable && state.gettable);
});

test('maps access bits, units, ranges, presets and composites', () => {
  const caps = parseExposes(lamp.definition.exposes);
  const by = Object.fromEntries(caps.map((c) => [c.property, c]));
  assert.equal(by.effect.readable, false);
  assert.equal(by.effect.writable, true);
  assert.equal(by.linkquality.writable, false);
  assert.equal(by.linkquality.category, 'diagnostic');
  assert.equal(by.color_temp.unit, 'mired');
  assert.equal(by.color_temp.min, 150);
  assert.deepEqual(by.color_temp.presets, [{ name: 'coolest', value: 150 }]);
  assert.deepEqual(by.color.features.map((f) => f.property), ['x', 'y']);
});

test('multi-endpoint switches get distinct groups', () => {
  const caps = parseExposes(sw.definition.exposes);
  assert.deepEqual(caps.map((c) => [c.property, c.group]), [['state_left', 'switch_left'], ['state_right', 'switch_right']]);
});

test('validateValue checks writability, ranges and allowed values', () => {
  const by = Object.fromEntries(parseExposes(lamp.definition.exposes).map((c) => [c.property, c]));
  assert.equal(validateValue(by.state, 'ON'), null);
  assert.equal(validateValue(by.state, 'TOGGLE'), null);
  assert.match(validateValue(by.state, true), /must be one of/);
  assert.equal(validateValue(by.brightness, 128), null);
  assert.match(validateValue(by.brightness, 300), /<= 254/);
  assert.match(validateValue(by.brightness, '1'), /number/);
  assert.match(validateValue(by.effect, 'nope'), /must be one of/);
  assert.match(validateValue(by.linkquality, 1), /read-only/);
  assert.equal(validateValue(by.color, { x: 0.3, y: 0.3 }), null);
});

test('handles empty or missing exposes', () => {
  assert.deepEqual(parseExposes(undefined), []);
  assert.deepEqual(parseExposes([{ type: 'numeric' }]), []);
});
