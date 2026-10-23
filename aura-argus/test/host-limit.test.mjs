import test from 'node:test';
import assert from 'node:assert/strict';

import { withHostSlot } from '../src/lib/host-limit.mjs';

test('withHostSlot caps concurrent work per host', async () => {
  let active = 0;
  let peak = 0;
  const jobs = Array.from({ length: 9 }, (_, index) => withHostSlot('https://example.test/docs', async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active -= 1;
    return index;
  }, { max: 2 }));
  const results = await Promise.all(jobs);
  assert.equal(results.length, 9);
  assert.ok(peak <= 2, `peak concurrency was ${peak}`);
});

test('withHostSlot releases slots for different hosts independently', async () => {
  const order = [];
  const slow = withHostSlot('https://a.test/1', async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    order.push('a');
  }, { max: 1 });
  const fast = withHostSlot('https://b.test/1', async () => { order.push('b'); }, { max: 1 });
  await Promise.all([slow, fast]);
  assert.deepEqual(order, ['b', 'a']);
});

test('withHostSlot removes an aborted waiter', async () => {
  let release;
  const first = withHostSlot('https://c.test/1', () => new Promise((resolve) => { release = resolve; }), { max: 1 });
  const controller = new AbortController();
  const second = withHostSlot('https://c.test/2', async () => 'second', { max: 1, signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve, 5));
  controller.abort(new Error('cancelled'));
  await assert.rejects(second, /cancelled/);
  release('first');
  assert.equal(await first, 'first');
});
