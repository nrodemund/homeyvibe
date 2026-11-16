import { EventEmitter } from 'node:events';
import { HttpError } from '../http/errors.js';
import { Validator, ID_RE, slugify } from './validate.js';

/**
 * Dashboard pages. A page is a titled list of sections; each section holds items
 * that point at devices (optionally limited to some capabilities) or actions.
 *
 * {
 *   id: 'living-room', title: 'Living room', icon: '🛋️', layout: 'grid', order: 0,
 *   sections: [
 *     { title: 'Lights', items: [
 *       { type: 'device', deviceId: 'z2m:0x…', properties: ['state', 'brightness'] },
 *       { type: 'action', actionId: 'movie-night' },
 *     ] },
 *   ],
 * }
 */
export const LAYOUTS = ['grid', 'list', '3d'];

export class PageStore extends EventEmitter {
  constructor({ store }) {
    super();
    this.store = store;
  }

  list() {
    return this.store.read('pages', []).sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
  }

  get(id) {
    return this.list().find((p) => p.id === id) ?? null;
  }

  create(input) {
    const pages = this.store.read('pages', []);
    const page = normalizePage({ ...input, id: input.id ?? uniqueId(slugify(input.title), pages) });
    if (pages.some((p) => p.id === page.id)) throw new HttpError(409, `Page ${page.id} already exists`);
    page.order ??= pages.length;
    pages.push(page);
    this.store.write('pages', pages);
    this.emit('changed');
    return page;
  }

  update(id, changes) {
    const pages = this.store.read('pages', []);
    const index = pages.findIndex((p) => p.id === id);
    if (index === -1) throw new HttpError(404, 'Unknown page');
    const page = normalizePage({ ...pages[index], ...changes, id });
    pages[index] = page;
    this.store.write('pages', pages);
    this.emit('changed');
    return page;
  }

  delete(id) {
    const pages = this.store.read('pages', []);
    if (!pages.some((p) => p.id === id)) throw new HttpError(404, 'Unknown page');
    this.store.write('pages', pages.filter((p) => p.id !== id));
    this.emit('changed');
  }
}

export function normalizePage(input) {
  const v = new Validator();
  v.check(ID_RE.test(input.id ?? ''), 'id must be lowercase letters, numbers and dashes');
  v.string(input.title, 'title', { max: 80 });
  v.string(input.icon, 'icon', { max: 16, optional: true });
  const layout = input.layout ?? 'grid';
  v.oneOf(layout, LAYOUTS, 'layout');
  const sections = input.sections ?? [];
  if (v.array(sections, 'sections', { max: 50 })) {
    sections.forEach((section, i) => {
      v.string(section?.title, `sections[${i}].title`, { max: 80, optional: true });
      if (!v.array(section?.items, `sections[${i}].items`, { max: 200 })) return;
      section.items.forEach((item, j) => {
        const path = `sections[${i}].items[${j}]`;
        if (!v.oneOf(item?.type, ['device', 'action'], `${path}.type`)) return;
        if (item.type === 'device') {
          v.string(item.deviceId, `${path}.deviceId`);
          if (item.properties !== undefined && v.array(item.properties, `${path}.properties`, { max: 50 })) {
            item.properties.forEach((p, k) => v.string(p, `${path}.properties[${k}]`, { max: 64 }));
          }
        } else {
          v.string(item.actionId, `${path}.actionId`);
        }
      });
    });
  }
  if (input.order !== undefined) v.check(Number.isInteger(input.order), 'order must be an integer');
  v.throwIfInvalid();

  return {
    id: input.id,
    title: input.title.trim(),
    icon: input.icon ?? null,
    layout,
    order: input.order,
    sections: sections.map((s) => ({
      title: s.title?.trim() ?? null,
      items: s.items.map((item) =>
        item.type === 'device'
          ? { type: 'device', deviceId: item.deviceId, ...(item.properties ? { properties: item.properties } : {}) }
          : { type: 'action', actionId: item.actionId }),
    })),
  };
}

function uniqueId(base, existing) {
  const taken = new Set(existing.map((e) => e.id));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
}

export { uniqueId };
