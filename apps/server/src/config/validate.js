// Hand-rolled validation for pages and actions. Errors are collected so an AI client
// gets every problem in one response instead of fixing them one at a time.

import { HttpError } from '../http/errors.js';

export class Validator {
  errors = [];

  check(condition, message) {
    if (!condition) this.errors.push(message);
    return condition;
  }

  string(value, path, { max = 200, optional = false } = {}) {
    if (optional && (value === undefined || value === null)) return true;
    return this.check(typeof value === 'string' && value.trim().length > 0 && value.length <= max,
      `${path} must be a non-empty string of at most ${max} characters`);
  }

  oneOf(value, allowed, path) {
    return this.check(allowed.includes(value), `${path} must be one of ${allowed.join(', ')}`);
  }

  array(value, path, { max = 100 } = {}) {
    return this.check(Array.isArray(value) && value.length <= max, `${path} must be an array of at most ${max} items`);
  }

  throwIfInvalid() {
    if (this.errors.length) throw new HttpError(400, this.errors.join('; '));
  }
}

export const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** "Living room" -> "living-room" */
export function slugify(text) {
  return String(text ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'item';
}
