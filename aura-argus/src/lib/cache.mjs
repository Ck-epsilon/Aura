// 两级缓存：内存 + 磁盘 JSON。磁盘不可写就静默降级为纯内存。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export class Cache {
  constructor({ dir = null, ttlMs = 600_000, maxEntries = 300, enabled = true } = {}) {
    this.dir = dir;
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.enabled = enabled && dir !== null;
    this.memory = new Map();
    this.diskOk = false;
    if (this.enabled) this.#load();
  }

  static key(parts) {
    return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32);
  }

  get(key) {
    if (!this.enabled) return undefined;
    const hit = this.memory.get(key);
    if (!hit) return undefined;
    if (hit.expires < Date.now()) {
      this.memory.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key, value, ttlMs = this.ttlMs) {
    if (!this.enabled) return;
    this.memory.set(key, { expires: Date.now() + ttlMs, value });
    if (this.memory.size > this.maxEntries) {
      const oldest = [...this.memory.entries()].sort((a, b) => a[1].expires - b[1].expires)[0];
      if (oldest) this.memory.delete(oldest[0]);
    }
    this.#save();
  }

  clear() {
    this.memory.clear();
    if (this.enabled) this.#save();
  }

  #file() {
    return path.join(this.dir, 'cache.json');
  }

  #load() {
    try {
      const raw = fs.readFileSync(this.#file(), 'utf8');
      const parsed = JSON.parse(raw);
      const now = Date.now();
      for (const [key, entry] of Object.entries(parsed.entries || {})) {
        if (entry && entry.expires > now) this.memory.set(key, entry);
      }
      this.diskOk = true;
    } catch {
      this.diskOk = false;
    }
  }

  #save() {
    if (!this.enabled) return;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const payload = { version: 1, savedAt: new Date().toISOString(), entries: Object.fromEntries(this.memory) };
      const tmp = this.#file() + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8');
      fs.renameSync(tmp, this.#file());
      this.diskOk = true;
    } catch {
      this.diskOk = false;
    }
  }
}
