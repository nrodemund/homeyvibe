import { CHART_RANGES } from '../../../../packages/shared/src/floorplan.js';
import { api } from '../api.js';
import { labelFor, formatValue } from '../controls.js';
import { displayCapabilities } from '../floorplan-visuals.js';
import { h, toast } from '../ui.js';
import { selectField } from './value-fields.js';

const durations = { '2h': 7_200_000, '24h': 86_400_000, '30d': 2_592_000_000 };

/** Show readings or paginated activity for a device, independently of its normal click behavior. */
export function openDeviceHistory(device, canEdit, initial = {}) {
  const readings = displayCapabilities(device, 'chart');
  const body = h('div.settings-fields');
  const status = h('p.muted', { role: 'status' });
  const dialog = h('dialog.panel.wide', { 'aria-label': `${device.name} history` },
    h('header', {}, h('h2', {}, device.name), h('button.icon-button', {
      type: 'button', 'aria-label': 'Close', onclick: () => dialog.close(),
    }, '✕')),
    h('div.row', {},
      h('button', { type: 'button', onclick: () => showActivity() }, 'Activity'),
      readings.length ? h('button', { type: 'button', onclick: showChart }, 'Chart') : null),
    body, status);
  dialog.addEventListener('close', () => { clearInterval(refresh); dialog.remove(); });
  let property = initial.property ?? readings[0]?.property;
  let range = initial.range ?? '24h';
  let generation = 0;
  let mode;
  let refresh;

  function showChart() {
    mode = 'chart';
    const chart = h('div');
    body.replaceChildren(
      selectField('Reading', readings.map((cap) => [cap.property, labelFor(cap)]), property, (next) => {
        property = next;
        showChart();
      }),
      selectField('Time range', Object.entries(CHART_RANGES), range, (next) => {
        range = next;
        showChart();
      }), chart);
    async function load() {
      const ticket = ++generation;
      try {
        const { points, manual, persistent } = await api.deviceHistory(device.id, property, range);
        if (!dialog.open || ticket !== generation) return;
        const cap = readings.find((item) => item.property === property);
        chart.replaceChildren(...[
          points.length ? drawChart(points, cap, range, initial) : h('p.muted', {}, 'Waiting for readings.'),
          canEdit ? h('label.row', {}, h('input', { type: 'checkbox', checked: manual, onchange: async (e) => {
            try { await api.trackHistory(device.id, property, e.target.checked); await load(); }
            catch (err) { toast(err.message); }
          } }), 'Keep long-term history') : null,
        ].filter(Boolean));
        status.textContent = persistent ? 'History is saved automatically.' : 'Recent readings are held in memory.';
      } catch (err) {
        if (ticket === generation) status.textContent = err.message;
      }
    }
    clearInterval(refresh);
    refresh = setInterval(load, 20_000);
    load();
  }

  async function showActivity(before) {
    mode = 'activity';
    clearInterval(refresh);
    const ticket = ++generation;
    try {
      const { events } = await api.deviceActivity(device.id, before);
      if (!dialog.open || ticket !== generation || mode !== 'activity') return;
      body.replaceChildren(...(events.length ? [
        timeline(events),
        h('div.activity-scroll', {}, h('table.activity-table', {},
          h('thead', {}, h('tr', {}, ['Time', 'Event', 'Value'].map((heading) => h('th', { scope: 'col' }, heading)))),
          h('tbody', {}, events.map((e) => h('tr', {},
            h('td', {}, new Date(e.time).toLocaleString()),
            h('td', {}, e.kind === 'command' ? 'Command sent' : labelFor({ property: e.property })),
            h('td', {}, eventValue(device, e))))))),
        h('div.row', {},
          before ? h('button', { type: 'button', onclick: () => showActivity() }, 'Latest') : null,
          events.length === 100 ? h('button', { type: 'button', onclick: () => showActivity(events.at(-1).id) }, 'Older') : null,
          h('button', { type: 'button', onclick: () => showActivity(before) }, 'Refresh')),
      ] : [h('p.muted', {}, 'No device activity recorded yet.'), h('button', { type: 'button', onclick: () => showActivity() }, 'Refresh')]));
      status.textContent = '';
    } catch (err) {
      if (ticket === generation) status.textContent = err.message;
    }
  }

  document.body.append(dialog);
  dialog.showModal();
  if (initial.property && readings.length) showChart();
  else showActivity();
}

function eventValue(device, e) {
  if (e.kind === 'command') {
    return e.value ? Object.entries(e.value).map(([key, value]) => {
      const cap = device.capabilities.find((c) => c.property === key) ?? { property: key };
      return `${labelFor(cap)} ${formatValue(cap, value)}`;
    }).join(' · ') : '–';
  }
  return formatValue(device.capabilities.find((c) => c.property === e.property) ?? {}, e.value);
}

function timeline(events) {
  const start = events.at(-1).time;
  const duration = Math.max(1, events[0].time - start);
  return h('div.activity-plot', { role: 'img', 'aria-label': 'Device activity timeline' },
    h('span', {}, new Date(start).toLocaleDateString()),
    h('div.activity-track', {}, events.map((e) => {
      const marker = h(`i.${e.kind}`, { title: new Date(e.time).toLocaleString() });
      marker.style.left = `${100 * (e.time - start) / duration}%`;
      return marker;
    })),
    h('span', {}, new Date(events[0].time).toLocaleDateString()));
}

function drawChart(points, cap, range, settings) {
  const canvas = h('canvas.history-chart', { width: 900, height: 315, role: 'img',
    'aria-label': `${labelFor(cap)} over ${CHART_RANGES[range]}` });
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  const values = points.map(([, value]) => value);
  const min = settings.min ?? Math.min(...values);
  const max = settings.max ?? Math.max(...values);
  const end = Date.now();
  const start = durations[range] ? end - durations[range] : points[0][0];
  const x = (at) => 80 + 800 * (at - start) / Math.max(1, end - start);
  const y = (value) => 275 - 250 * (max > min ? Math.max(0, Math.min(1, (value - min) / (max - min))) : 0.5);
  ctx.font = '16px system-ui';
  ctx.fillStyle = '#8992a8';
  ctx.fillText(formatValue(cap, max), 4, 27);
  ctx.fillText(formatValue(cap, min), 4, 275);
  ctx.fillText(new Date(start).toLocaleString(), 80, 300);
  ctx.textAlign = 'right';
  ctx.fillText(new Date(end).toLocaleString(), 880, 300);
  ctx.beginPath();
  ctx.moveTo(80, 25);
  ctx.lineTo(80, 275);
  ctx.lineTo(880, 275);
  ctx.strokeStyle = '#8992a8';
  ctx.stroke();
  ctx.beginPath();
  points.forEach(([at, value], index) => index ? ctx.lineTo(x(at), y(value)) : ctx.moveTo(x(at), y(value)));
  ctx.strokeStyle = '#738dff';
  ctx.lineWidth = 3;
  ctx.stroke();
  const [at, value] = points.at(-1);
  ctx.beginPath();
  ctx.arc(x(at), y(value), 5, 0, 2 * Math.PI);
  ctx.fillStyle = '#738dff';
  ctx.fill();
  return h('div', {}, canvas, h('p.muted', {}, `Latest: ${formatValue(cap, value)}`));
}
