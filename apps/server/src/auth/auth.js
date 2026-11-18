import { createHash, randomBytes, randomUUID, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { HttpError } from '../http/errors.js';
import { isRole, permissionsFor } from './roles.js';

const scrypt = promisify(scryptCb);
const KEY_LEN = 64;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_FAILURES = 5;
const LOCK_MS = 30_000;
const USERNAME_RE = /^[a-z0-9._-]{2,32}$/;

/**
 * Users, password login and sessions, persisted through a JsonStore.
 * Session tokens are random and only their SHA-256 hash is stored.
 */
export class AuthService {
  #failures = new Map(); // username -> { count, until }

  constructor({ store, now = () => Date.now() }) {
    this.store = store;
    this.now = now;
  }

  // ---- users -----------------------------------------------------------------

  #users() {
    return this.store.read('users', []);
  }

  #saveUsers(users) {
    this.store.write('users', users);
  }

  needsSetup() {
    return this.#users().length === 0;
  }

  listUsers() {
    return this.#users().map(publicUser);
  }

  getUser(id) {
    const user = this.#users().find((u) => u.id === id);
    return user ? publicUser(user) : null;
  }

  async createUser({ username, password, role, displayName }) {
    username = normalizeUsername(username);
    if (!isRole(role)) throw new HttpError(400, `Unknown role ${role}`);
    validatePassword(password);
    const users = this.#users();
    if (users.some((u) => u.username === username)) throw new HttpError(409, 'Username already taken');
    const user = {
      id: randomUUID(),
      username,
      displayName: cleanDisplayName(displayName) ?? username,
      role,
      passwordHash: await hashPassword(password),
      createdAt: new Date(this.now()).toISOString(),
    };
    users.push(user);
    this.#saveUsers(users);
    return publicUser(user);
  }

  /** First admin. Only allowed while there are no users at all. */
  async setup(input) {
    if (!this.needsSetup()) throw new HttpError(409, 'Setup already done');
    return this.createUser({ ...input, role: 'admin' });
  }

  async updateUser(id, changes) {
    const users = this.#users();
    const user = users.find((u) => u.id === id);
    if (!user) throw new HttpError(404, 'Unknown user');
    if (changes.role !== undefined) {
      if (!isRole(changes.role)) throw new HttpError(400, `Unknown role ${changes.role}`);
      if (user.role === 'admin' && changes.role !== 'admin' && countAdmins(users) === 1) {
        throw new HttpError(409, 'Cannot demote the last admin');
      }
      user.role = changes.role;
    }
    if (changes.displayName !== undefined) user.displayName = cleanDisplayName(changes.displayName) ?? user.username;
    if (changes.password !== undefined) {
      validatePassword(changes.password);
      user.passwordHash = await hashPassword(changes.password);
      this.#revokeSessionsFor(id);
    }
    this.#saveUsers(users);
    return publicUser(user);
  }

  deleteUser(id) {
    const users = this.#users();
    const user = users.find((u) => u.id === id);
    if (!user) throw new HttpError(404, 'Unknown user');
    if (user.role === 'admin' && countAdmins(users) === 1) throw new HttpError(409, 'Cannot delete the last admin');
    this.#saveUsers(users.filter((u) => u.id !== id));
    this.#revokeSessionsFor(id);
  }

  // ---- login and sessions ------------------------------------------------------

  async login(username, password) {
    username = String(username ?? '').trim().toLowerCase();
    const lock = this.#failures.get(username);
    if (lock && lock.until > this.now()) throw new HttpError(429, 'Too many attempts, try again shortly');

    const user = this.#users().find((u) => u.username === username);
    // Always run scrypt so response time does not reveal whether the user exists.
    const ok = await verifyPassword(String(password ?? ''), user?.passwordHash ?? DUMMY_HASH);
    if (!user || !ok) {
      const count = (lock?.count ?? 0) + 1;
      this.#failures.set(username, { count, until: count >= MAX_FAILURES ? this.now() + LOCK_MS : 0 });
      throw new HttpError(401, 'Wrong username or password');
    }
    this.#failures.delete(username);
    return { token: this.#createSession(user.id), user: publicUser(user) };
  }

  #createSession(userId) {
    const token = randomBytes(32).toString('base64url');
    const sessions = this.#liveSessions();
    sessions.push({ hash: sha256(token), userId, expiresAt: this.now() + SESSION_TTL_MS });
    this.store.write('sessions', sessions);
    return token;
  }

  #liveSessions() {
    return this.store.read('sessions', []).filter((s) => s.expiresAt > this.now());
  }

  /** Resolve a session token to a user, or null. */
  authenticate(token) {
    if (!token) return null;
    const hash = sha256(token);
    const session = this.#liveSessions().find((s) => s.hash === hash);
    if (!session) return null;
    const user = this.#users().find((u) => u.id === session.userId);
    return user ? publicUser(user) : null;
  }

  logout(token) {
    if (!token) return;
    const hash = sha256(token);
    this.store.write('sessions', this.#liveSessions().filter((s) => s.hash !== hash));
  }

  #revokeSessionsFor(userId) {
    this.store.write('sessions', this.#liveSessions().filter((s) => s.userId !== userId));
  }
}

function publicUser(u) {
  return {
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    role: u.role,
    permissions: permissionsFor(u.role),
    createdAt: u.createdAt,
  };
}

function countAdmins(users) {
  return users.filter((u) => u.role === 'admin').length;
}

function normalizeUsername(username) {
  const value = String(username ?? '').trim().toLowerCase();
  if (!USERNAME_RE.test(value)) {
    throw new HttpError(400, 'Username must be 2-32 characters: letters, numbers, dot, dash or underscore');
  }
  return value;
}

function cleanDisplayName(name) {
  const value = String(name ?? '').trim().slice(0, 64);
  return value || null;
}

function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 8) {
    throw new HttpError(400, 'Password must be at least 8 characters');
  }
  if (password.length > 256) throw new HttpError(400, 'Password is too long');
}

async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, KEY_LEN);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

async function verifyPassword(password, stored) {
  const [scheme, saltB64, keyB64] = stored.split('$');
  if (scheme !== 'scrypt') return false;
  const expected = Buffer.from(keyB64, 'base64');
  const actual = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length);
  return timingSafeEqual(actual, expected);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

// Used when the username does not exist, so a failed lookup costs the same as a wrong password.
const DUMMY_HASH = `scrypt$${randomBytes(16).toString('base64')}$${randomBytes(KEY_LEN).toString('base64')}`;
