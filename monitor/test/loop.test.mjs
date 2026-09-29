import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runLoop } from '../loop.mjs';

/** 虚拟时钟：sleep 直接推进时间，不真等 */
function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, sleep: async (ms) => { t += ms; }, advance: (ms) => { t += ms; }, at: () => t - start };
}
const MIN = 60_000;

test('按固定间隔对齐：段 30 分钟、间隔 5 分钟 → 0,5,…,25 共 6 轮（截止时刻那一轮留给下一段）', async () => {
  const c = clock();
  const times = [];
  const r = await runLoop({ segmentMs: 30 * MIN, intervalMs: 5 * MIN, now: c.now, sleep: c.sleep, tick: async () => { times.push(c.at() / MIN); } });
  assert.deepEqual(times, [0, 5, 10, 15, 20, 25]);
  assert.deepEqual(r, { ticks: 6, failures: 0, skipped: 0 });
});

test('单轮耗时算在间隔里（不是「跑完再等 5 分钟」）', async () => {
  const c = clock();
  const times = [];
  await runLoop({ segmentMs: 20 * MIN, intervalMs: 5 * MIN, now: c.now, sleep: c.sleep, tick: async () => { times.push(c.at() / MIN); c.advance(2 * MIN); } });
  assert.deepEqual(times, [0, 5, 10, 15]);
});

test('某一轮拖过了若干个间隔：跳过错过的轮次，不补跑', async () => {
  const c = clock();
  const times = [];
  const r = await runLoop({
    segmentMs: 40 * MIN, intervalMs: 5 * MIN, now: c.now, sleep: c.sleep,
    tick: async (k) => { times.push(c.at() / MIN); if (k === 1) c.advance(12 * MIN); }, // 第 1 轮 5→17，错过 10、15
  });
  assert.deepEqual(times, [0, 5, 20, 25, 30, 35]);
  assert.equal(r.skipped, 2);
});

test('某一轮抛错：记失败、继续下一轮，不提前结束', async () => {
  const c = clock();
  const logs = [];
  const r = await runLoop({
    segmentMs: 16 * MIN, intervalMs: 5 * MIN, now: c.now, sleep: c.sleep, log: (s) => logs.push(s),
    tick: async (k) => { if (k === 1) throw new Error('run.mjs 退出 1'); },
  });
  assert.deepEqual(r, { ticks: 4, failures: 1, skipped: 0 });
  assert.match(logs[0], /第 1 轮出错：run\.mjs 退出 1/);
});

test('段比间隔短：至少跑第 0 轮', async () => {
  const c = clock();
  const r = await runLoop({ segmentMs: 1 * MIN, intervalMs: 5 * MIN, now: c.now, sleep: c.sleep, tick: async () => {} });
  assert.equal(r.ticks, 1);
});

test('参数不合法直接抛', async () => {
  await assert.rejects(() => runLoop({ segmentMs: 0, intervalMs: 5, tick: async () => {} }));
  await assert.rejects(() => runLoop({ segmentMs: 5, intervalMs: 0, tick: async () => {} }));
});
