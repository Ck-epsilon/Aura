// 同主机并发上限：批量/多实体检索时避免对同一官方站瞬时打满，降低 429/503 概率。
const queues = new Map();

function hostOf(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

/**
 * @template T
 * @param {string} url
 * @param {() => Promise<T>} fn
 * @param {{max?: number, signal?: AbortSignal|null}} [options]
 * @returns {Promise<T>}
 */
export async function withHostSlot(url, fn, { max = 4, signal = null } = {}) {
  const host = hostOf(url);
  if (!host) return fn();
  const limit = Math.max(1, Number(max) || 4);
  let queue = queues.get(host);
  if (!queue) {
    queue = { active: 0, waiters: [] };
    queues.set(host, queue);
  }

  if (queue.active >= limit) {
    await new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal, onAbort: null };
      if (signal) {
        waiter.onAbort = () => {
          const index = queue.waiters.indexOf(waiter);
          if (index >= 0) queue.waiters.splice(index, 1);
          reject(signal.reason instanceof Error ? signal.reason : new Error('request aborted'));
        };
        if (signal.aborted) { waiter.onAbort(); return; }
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      queue.waiters.push(waiter);
    });
  } else {
    queue.active += 1;
  }

  try {
    return await fn();
  } finally {
    const next = queue.waiters.shift();
    if (next) {
      // 直接把释放出来的槽位交给下一个等待者，不先减再加，避免新调用插队超限。
      next.signal?.removeEventListener('abort', next.onAbort);
      next.resolve();
    } else {
      queue.active -= 1;
      if (queue.active === 0) queues.delete(host);
    }
  }
}

export function hostQueueStats() {
  return [...queues.entries()].map(([host, queue]) => ({ host, active: queue.active, waiting: queue.waiters.length }));
}
