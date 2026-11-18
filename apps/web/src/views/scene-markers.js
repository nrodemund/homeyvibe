import { h } from '../ui.js';
import { labelFor } from '../controls.js';
import { deviceSummary, ICONS } from '../floorplan.js';
import { chartPoints, markerReading } from '../floorplan-visuals.js';

export const LOW_COLOR = '#559aed';
export const HIGH_COLOR = '#f57850';

/** Update the label and its accessible reading using the chosen visual presentation. */
export function renderMarker(button, device, kind, display, points) {
  const mode = display.mode;
  const reading = markerReading(device, display);
  const { cap, fraction, active } = reading;
  const text = mode === 'auto' ? deviceSummary(device) : reading.text;
  const caption = h('span.device-label-text', {}, h('strong', {}, device.name));
  const low = display.lowColor ?? LOW_COLOR;
  const high = display.highColor ?? HIGH_COLOR;
  const indicator = active === null ? 'var(--muted)' : active ? high : low;
  const label = cap ? labelFor(cap) : '';
  button.classList.toggle('offline', device.available === false);
  button.dataset.mode = mode;
  button.replaceChildren(h('span.device-label-icon', { 'aria-hidden': 'true' }, ICONS[kind]));
  if (mode !== 'icon') button.append(caption);
  button.setAttribute('aria-label', [device.name, device.available === false && 'Offline', label, mode === 'icon' ? '' : text]
    .filter(Boolean).join(', '));
  if (mode === 'icon' || mode === 'color') return reading;

  let extra;
  if (mode === 'badge' || mode === 'threshold' || mode === 'status') {
    const hue = mode === 'badge' && fraction !== null ? `color-mix(in srgb, ${low} ${(1 - fraction) * 100}%, ${high})` : indicator;
    extra = styled('span.scene-reading-badge', '--marker-color', hue, text);
  } else if (['bar', 'gauge', 'thermometer'].includes(mode)) {
    extra = h('span.scene-reading-meter', {},
      styled(`span.scene-meter.${mode}`, '--reading', `${(fraction ?? 0) * 100}%`),
      h('span', {}, text));
  } else if (mode === 'chart') {
    extra = h('span.scene-reading-plot', {}, h('span', {}, text), linePlot(points, display));
  } else if (mode === 'trend') {
    const previous = points.at(-2)?.[1];
    const delta = reading.value - previous;
    const direction = !Number.isFinite(delta) ? 'No trend yet' : delta === 0 ? 'Steady' : delta > 0 ? 'Rising' : 'Falling';
    const arrow = !Number.isFinite(delta) ? '·' : delta === 0 ? '→' : delta > 0 ? '↗' : '↘';
    extra = h('span.scene-reading-meter', {}, h('strong', { title: direction }, arrow), text);
    button.setAttribute('aria-label', `${button.getAttribute('aria-label')}, ${direction}`);
  } else if (text) {
    extra = h('span', {}, text);
  }
  if (extra) caption.append(extra);
  return reading;
}

function styled(tag, property, value, text) {
  const el = h(tag, { 'aria-hidden': 'true' }, text);
  el.style.setProperty(property, value);
  return el;
}

function linePlot(points, display) {
  if (!points.length) return h('span.scene-no-readings', {}, 'Waiting for readings');
  const canvas = h('canvas.scene-plot', { width: 192, height: 54, 'aria-label': 'Reading history for the last 24 hours', role: 'img' });
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  const coords = chartPoints(points, display, Date.now(), 186, 46).map(([x, y]) => [x + 3, y + 4]);
  ctx.beginPath();
  ctx.moveTo(0, 50);
  ctx.lineTo(192, 50);
  ctx.strokeStyle = '#74809580';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.beginPath();
  coords.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.strokeStyle = '#4da6ed';
  ctx.lineWidth = 3;
  ctx.lineJoin = 'round';
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(...coords.at(-1), 3, 0, Math.PI * 2);
  ctx.fillStyle = '#4da6ed';
  ctx.fill();
  return canvas;
}
