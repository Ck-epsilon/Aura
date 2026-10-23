// 持久页缓存：按 URL 存规范化前的原始响应 + ETag/Last-Modified。
// 与搜索结果缓存不同，它跨进程复用；私网页与公开页分开存，避免越权复用。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DEFAULT_TTL_MS = 6 * 60 * 60_000;
const MAX_ENTRIES = 500;

export class PageCache {
  constructor({ dir, ttlMs = DEFAULT_TTL_MS, maxEntries = MAX_ENTRIES, enabled = true } = {}) {
    this.dir = dir;
    this.ttlMs = Math.max(0, Number(ttlMs) || 0);
    this.maxEntries = Math.max(1, Number(maxEntries) || MAX_ENTRIES);
    this.enabled = enabled && Boolean(dir);
    if (this.enabled) {
      try { fs.mkdirSync(this.#pagesDir(), { recursive: true }); } catch { this.enabled = false; }
    }
  }

  #pagesDir() {
    return path.join(this.dir, 'pages');
  }

  #key(url, allowPrivate) {
    return crypto.createHash('sha256').update(`${allowPrivate ? 'private' : 'public'}\n${url}`).digest('hex').slice(0, 40);
  }

  #file(url, allowPrivate) {
    return path.join(this.#pagesDir(), `${this.#key(url, allowPrivate)}.json`);
  }

  /**
   * 返回 { page, etag, lastModified, savedAt, fresh }；未命中返回 null。
   */
  get(url, { allowPrivate = false, now = Date.now() } = {}) {
    if (!this.enabled) return null;
    try {
      const entry = JSON.parse(fs.readFileSync(this.#file(url, allowPrivate), 'utf8'));
      if (!entry || entry.url !== url || entry.private !== Boolean(allowPrivate)) return null;
      return {
        page: entry.page,
        etag: entry.etag || null,
        lastModified: entry.lastModified || null,
        savedAt: entry.savedAt,
        fresh: this.ttlMs > 0 && now - entry.savedAt < this.ttlMs,
      };
    } catch {
      return null;
    }
  }

  set(url, page, { allowPrivate = false } = {}) {
    if (!this.enabled) return;
    const entry = {
      url,
      private: Boolean(allowPrivate),
      savedAt: Date.now(),
      etag: page.etag || null,
      lastModified: page.lastModified || null,
      page: {
        url: page.url,
        finalUrl: page.finalUrl,
        status: page.status,
        contentType: page.contentType,
        text: page.text,
        bytes: page.bytes,
      },
    };
    try {
      const file = this.#file(url, allowPrivate);
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(entry), 'utf8');
      fs.renameSync(tmp, file);
      this.#prune();
    } catch {
      // 缓存是 best-effort，不阻塞检索
    }
  }

  touch(url, { allowPrivate = false } = {}) {
    if (!this.enabled) return;
    try {
      const entry = JSON.parse(fs.readFileSync(this.#file(url, allowPrivate), 'utf8'));
      entry.savedAt = Date.now();
      const file = this.#file(url, allowPrivate);
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(entry), 'utf8');
      fs.renameSync(tmp, file);
    } catch {
      // ignore
    }
  }

  #prune() {
    try {
      const files = fs.readdirSync(this.#pagesDir()).filter((name) => name.endsWith('.json'));
      if (files.length <= this.maxEntries) return;
      const rows = files.map((name) => {
        const full = path.join(this.#pagesDir(), name);
        return { full, at: fs.statSync(full).mtimeMs };
      }).sort((a, b) => a.at - b.at);
      for (const row of rows.slice(0, files.length - this.maxEntries)) {
        try { fs.rmSync(row.full, { force: true }); } catch { /* ignore */ }
      }
    } catch {
      // ignore
    }
  }

  clear() {
    try { fs.rmSync(this.#pagesDir(), { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
