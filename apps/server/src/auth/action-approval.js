import { createHash, randomBytes } from 'node:crypto';
import {
  generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { HttpError } from '../http/errors.js';

const hash = (value) => createHash('sha256').update(value).digest('base64url');
const TTL = 120_000;

/** One-use, session-bound approvals and per-origin WebAuthn verification. */
export class ActionApproval {
  #pending = new Map();

  constructor({ store, auth }) {
    this.store = store;
    this.auth = auth;
  }

  keys(user) {
    return this.store.read('passkeys', []).filter((key) => key.userId === user.id)
      .map(({ id, rpId, createdAt }) => ({ id, rpId, createdAt }));
  }

  #origin(req) {
    let origin;
    try { origin = new URL(req.headers.origin); } catch { throw new HttpError(400, 'Use the HomeyVibe app to verify'); }
    if (origin.origin !== req.headers.origin || (origin.protocol !== 'https:' && origin.hostname !== 'localhost')) {
      throw new HttpError(400, 'Open HomeyVibe over HTTPS to use a passkey');
    }
    return { origin: origin.origin, rpId: origin.hostname };
  }

  #begin(token, user, options) {
    for (const [nonce, entry] of this.#pending) if (entry.expires <= Date.now()) this.#pending.delete(nonce);
    if (this.#pending.size >= 256) this.#pending.delete(this.#pending.keys().next().value);
    const nonce = randomBytes(24).toString('base64url');
    this.#pending.set(nonce, { ...options, session: hash(token), userId: user.id, expires: Date.now() + TTL });
    return nonce;
  }

  #consume(nonce, token, user, kind) {
    const record = this.#pending.get(nonce);
    if (!record || record.expires <= Date.now() || record.session !== hash(token) ||
      record.userId !== user.id || record.kind !== kind) throw new HttpError(403, 'Approval expired or is invalid. Try again.');
    this.#pending.delete(nonce);
    return record;
  }

  async beginRegistration(req, token, user, password) {
    const { rpId, origin } = this.#origin(req);
    await this.auth.verifyAccountPassword(user.username, password);
    const keys = this.keys(user).filter((key) => key.rpId === rpId);
    if (keys.length >= 10) throw new HttpError(409, 'Remove an existing passkey first');
    const options = await generateRegistrationOptions({
      rpName: 'HomeyVibe', rpID: rpId, userName: user.username, userID: Buffer.from(user.id),
      attestationType: 'none', authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
      excludeCredentials: keys.map(({ id }) => ({ id })),
    });
    return { options, nonce: this.#begin(token, user, { kind: 'registration', rpId, origin, challenge: options.challenge }) };
  }

  async register(token, user, { nonce, response }) {
    const record = this.#consume(nonce, token, user, 'registration');
    let result;
    try {
      result = await verifyRegistrationResponse({ response, expectedChallenge: record.challenge,
        expectedOrigin: record.origin, expectedRPID: record.rpId, requireUserVerification: true });
    } catch { throw new HttpError(403, 'Passkey registration could not be verified'); }
    if (!result.verified) throw new HttpError(403, 'Passkey registration could not be verified');
    const { id, publicKey, counter, transports } = result.registrationInfo.credential;
    const keys = this.store.read('passkeys', []);
    if (keys.some((key) => key.id === id)) throw new HttpError(409, 'Passkey already registered');
    keys.push({ id, publicKey: Buffer.from(publicKey).toString('base64url'), counter, transports,
      userId: user.id, rpId: record.rpId, createdAt: Date.now() });
    this.store.write('passkeys', keys);
    return this.keys(user);
  }

  async remove(user, id, password) {
    await this.auth.verifyAccountPassword(user.username, password);
    this.store.write('passkeys', this.store.read('passkeys', []).filter((key) => key.userId !== user.id || key.id !== id));
    return this.keys(user);
  }

  async beginAction(req, token, user, action) {
    const security = action.security ?? 'none';
    let options;
    let origin;
    let rpId;
    if (security === 'passkey') {
      ({ origin, rpId } = this.#origin(req));
      const keys = this.keys(user).filter((key) => key.rpId === rpId);
      if (!keys.length) throw new HttpError(409, 'Add a passkey for this address under Passkeys');
      options = await generateAuthenticationOptions({
        rpID: rpId, userVerification: 'required', allowCredentials: keys.map(({ id }) => ({ id })),
      });
    }
    return { security, options, nonce: security === 'none' ? null : this.#begin(token, user, {
      kind: 'action', snapshot: hash(JSON.stringify(action)), origin, rpId, challenge: options?.challenge,
    }) };
  }

  async approve(token, user, action, { nonce, response } = {}) {
    if (!['confirm', 'passkey'].includes(action.security)) return false;
    const record = this.#consume(nonce, token, user, 'action');
    if (record.snapshot !== hash(JSON.stringify(action))) throw new HttpError(409, 'The action changed. Try again.');
    if (action.security === 'confirm') return true;
    const key = this.store.read('passkeys', []).find((k) => k.id === response?.id && k.userId === user.id && k.rpId === record.rpId);
    if (!key) throw new HttpError(403, 'Passkey not found');
    let result;
    try {
      result = await verifyAuthenticationResponse({ response, expectedChallenge: record.challenge,
        expectedRPID: record.rpId, expectedOrigin: record.origin, requireUserVerification: true,
        credential: { ...key, publicKey: Buffer.from(key.publicKey, 'base64url') },
      });
    } catch { throw new HttpError(403, 'Passkey verification failed'); }
    if (!result.verified) throw new HttpError(403, 'Passkey verification failed');
    const keys = this.store.read('passkeys', []);
    const current = keys.find((k) => k.id === key.id && k.userId === user.id);
    if (!current) throw new HttpError(403, 'Passkey was removed');
    const next = result.authenticationInfo.newCounter;
    if (next && next <= current.counter) throw new HttpError(403, 'Passkey verification was already used');
    current.counter = next;
    this.store.write('passkeys', keys);
    return true;
  }
}
