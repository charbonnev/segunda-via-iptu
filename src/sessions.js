import { randomBytes } from 'node:crypto';
import { AppError } from './errors.js';

export const COOKIE_NAME = 'iptu_session';
export function sessionId(req) {
  return req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith(`${COOKIE_NAME}=`))?.slice(COOKIE_NAME.length + 1);
}

export class SessionStore {
  constructor({ ttlMs = 15 * 60 * 1000, max = 4 } = {}) {
    this.ttlMs = ttlMs;
    this.max = max;
    this.entries = new Map();
  }
  async add(portal) {
    if (this.entries.size >= this.max) {
      await portal.close();
      throw new AppError(429, 'LIMITE_SESSOES', 'Limite de sessões locais atingido. Encerre uma sessão ou aguarde a expiração.');
    }
    const entry = { id: randomBytes(32).toString('base64url'), portal };
    this.entries.set(entry.id, entry);
    this.touch(entry);
    return entry;
  }
  get(id) {
    const entry = this.entries.get(id);
    if (!entry) return;
    if (entry.expiresAt <= Date.now() || !entry.portal.isOpen()) {
      void this.remove(id);
      return;
    }
    return entry;
  }
  pause(entry) { clearTimeout(entry.timer); }
  touch(entry) {
    if (!this.entries.has(entry.id)) return;
    clearTimeout(entry.timer);
    entry.expiresAt = Date.now() + this.ttlMs;
    entry.timer = setTimeout(() => { void this.remove(entry.id); }, this.ttlMs);
    entry.timer.unref();
  }
  async remove(id) {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    clearTimeout(entry.timer);
    await entry.portal.close().catch(() => {});
  }
  async closeAll() { await Promise.all([...this.entries.keys()].map(id => this.remove(id))); }
}
