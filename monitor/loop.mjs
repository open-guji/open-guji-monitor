#!/usr/bin/env node
/**
 * 探测自续循环（overview#280 M1）。
 *
 * 背景：GitHub 对 cron 降频——公开仓 31 小时只触发 10 次（设计约 125 次探测），实际探测间隔是几小时。
 * 做法：一个长时间运行的 job（一「段」）里自己按固定间隔调 `run.mjs`，到点由 workflow 用
 * workflow_dispatch 发起下一段（concurrency 保证前一段结束后下一段立刻接上），cron 只作兜底重启。
 *
 *   node monitor/loop.mjs --segment-minutes 335 --interval-minutes 5 -- --suite probe --state … --perf …
 *
 * `--` 之后的参数原样传给 run.mjs。每一轮是一个独立子进程：某一轮崩了、超时了不影响下一轮。
 * 轮次按「段开始 + k × 间隔」对齐；某一轮比间隔长，就跳过错过的轮次、不补跑（免得堆积成突发）。
 * 段的最后一轮是「计划时刻早于段截止」的最后一个（截止时刻那一轮留给下一段的第 0 轮）；截止后退出码 0，由 workflow 接着发起下一段。
 * 退出码：只在参数错误时非零。单轮失败（含 run.mjs 非零＝告警链路自己坏了）只记日志、计数，不让段提前结束。
 */
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * 循环调度（纯逻辑，时钟与睡眠可注入，便于测试）。
 * @param {{ segmentMs: number, intervalMs: number, tick: (k: number) => Promise<any>,
 *           now?: () => number, sleep?: (ms: number) => Promise<void>, log?: (s: string) => void }} o
 * @returns {Promise<{ ticks: number, failures: number, skipped: number }>}
 */
export async function runLoop({ segmentMs, intervalMs, tick, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = () => {} }) {
  if (!(segmentMs > 0) || !(intervalMs > 0)) throw new Error('segmentMs 与 intervalMs 必须为正');
  const start = now();
  const deadline = start + segmentMs;
  let k = 0;
  let ticks = 0;
  let failures = 0;
  let skipped = 0;
  for (;;) {
    const at = start + k * intervalMs;
    if (at >= deadline) break; // 截止时刻那一轮留给下一段（下一段紧接着从第 0 轮开始）
    const wait = at - now();
    if (wait > 0) await sleep(wait);
    try {
      await tick(k);
    } catch (e) {
      failures += 1;
      log(`第 ${k} 轮出错：${e?.message ?? e}`);
    }
    ticks += 1;
    // 下一轮：第一个「晚于现在」的对齐时刻；本轮拖过了若干个间隔就跳过它们
    const after = now();
    const nextK = Math.max(k + 1, Math.floor((after - start) / intervalMs) + 1);
    skipped += nextK - (k + 1);
    k = nextK;
  }
  return { ticks, failures, skipped };
}

/** 跑一轮 run.mjs：子进程，超时强杀；非零退出算这一轮失败 */
export function runOnce(args, { timeoutMs, log = console.log } = {}) {
  return new Promise((resolveP, rejectP) => {
    const child = spawn(process.execPath, [resolve(HERE, 'run.mjs'), ...args], { stdio: 'inherit' });
    const timer = setTimeout(() => {
      log(`::warning::单轮超过 ${Math.round(timeoutMs / 1000)}s，强制结束`);
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); rejectP(e); });
    child.on('exit', (code, sig) => {
      clearTimeout(timer);
      if (code === 0) resolveP();
      else rejectP(new Error(`run.mjs 退出 ${code ?? sig}`));
    });
  });
}

function parse(argv) {
  const i = argv.indexOf('--');
  const own = i === -1 ? argv : argv.slice(0, i);
  const rest = i === -1 ? [] : argv.slice(i + 1);
  const get = (name, dflt) => {
    const j = own.indexOf(name);
    return j === -1 ? dflt : Number(own[j + 1]);
  };
  return { segmentMin: get('--segment-minutes', 335), intervalMin: get('--interval-minutes', 5), tickTimeoutMin: get('--tick-timeout-minutes', 4), rest };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const o = parse(process.argv.slice(2));
  if (![o.segmentMin, o.intervalMin, o.tickTimeoutMin].every((x) => x > 0)) {
    console.error('参数错误：--segment-minutes／--interval-minutes／--tick-timeout-minutes 必须是正数');
    process.exit(2);
  }
  const t0 = Date.now();
  console.log(`探测循环开始：每 ${o.intervalMin} 分钟一轮，本段最长 ${o.segmentMin} 分钟；run.mjs ${o.rest.join(' ')}`);
  const r = await runLoop({
    segmentMs: o.segmentMin * 60_000,
    intervalMs: o.intervalMin * 60_000,
    tick: async (k) => {
      console.log(`::group::第 ${k} 轮 ${new Date().toISOString()}`);
      try {
        await runOnce(o.rest, { timeoutMs: o.tickTimeoutMin * 60_000 });
      } finally {
        console.log('::endgroup::');
      }
    },
    log: (s) => console.log(`::warning::${s}`),
  });
  console.log(`探测循环结束：${r.ticks} 轮，失败 ${r.failures}，跳过 ${r.skipped}，用时 ${Math.round((Date.now() - t0) / 60000)} 分钟`);
}
