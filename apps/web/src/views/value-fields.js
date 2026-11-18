import { h } from '../ui.js';
import { labelFor } from '../controls.js';
import { field } from './auth.js';

/** Select a value while retaining saved settings for currently unavailable options. */
export function selectField(label, options, value, update, { placeholder, ...props } = {}) {
  const select = h('select', { ...props, onchange: (e) => update(e.target.value) });
  if (placeholder) select.add(new Option(placeholder, ''));
  for (const [id, text] of options) select.add(new Option(text, id));
  if (value && !options.some(([id]) => id === value)) select.add(new Option(`Unavailable (${value})`, value));
  select.value = value ?? '';
  return field(label, select);
}

/** Typed input for a device capability, including boolean and numeric enum values. */
export function valueField(cap, property, value, update, label = cap ? labelFor(cap) : property) {
  const options = cap?.type === 'binary' ? [cap.valueOff, cap.valueOn] : cap?.values;
  if (options?.length) {
    return selectField(label, options.map((option, i) => [JSON.stringify(option),
      cap?.type === 'binary' ? (i ? 'On' : 'Off') : String(option)]),
    value === undefined ? '' : JSON.stringify(value), (next) => update(next ? JSON.parse(next) : undefined),
    { placeholder: 'Choose a value', required: true });
  }
  if (cap?.type === 'numeric') {
    return field(label, h('input', { type: 'number', step: 'any', value: value ?? '', required: true,
      min: cap.min ?? undefined, max: cap.max ?? undefined,
      oninput: (e) => update(e.target.value === '' ? undefined : e.target.valueAsNumber) }));
  }
  const text = cap?.type === 'text';
  return field(text ? label : `${label} (JSON)`, h('input', {
    value: value === undefined ? '' : text ? value : JSON.stringify(value), required: !text,
    oninput: (e) => {
      try {
        update(text ? e.target.value : JSON.parse(e.target.value));
        e.target.setCustomValidity('');
      } catch {
        update(undefined);
        e.target.setCustomValidity('Enter a valid JSON value.');
      }
    },
  }));
}
