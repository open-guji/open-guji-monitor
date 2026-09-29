/**
 * 故障注入（任务书 §四·1）：A 类每一项都注入一种故障，证明
 *   第 1 轮不开单 → 第 2 轮开单（带 monitor 标签、正文带实测值）→ 恢复后自动关单并写恢复时间。
 * GitHub API 也是假的（test/fake.mjs），不刷正式 issue。
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.mjs';
import { PROBE_CHECKS, PRIVATE_PROBE_CHECKS } from '../checks/probe.mjs';
import { DATA_CHECKS } from '../checks/data.mjs';
import { emptyState } from '../lib/state.mjs';
import { makeGithub } from '../lib/alert.mjs';
import http from 'node:http';
import { buildContext, runChecks, processAlerts, pushAlerts } from '../run.mjs';
import { startFake, FAKE_UI } from './fake.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
let fake;

function cfgFor(base) {
  return {
    ...loadConfig(),
    www: `${base}/www`, data: `${base}/data`, api: `${base}/api`, staging: `${base}/stg`,
    githubApi: `${base}/gh`, githubToken: 'x', errorViewToken: 'tok',
    tlsHosts: ['www.example', 'data.example'],
    timeoutMs: 5000, searchMaxMs: 1000,
  };
}

// 两半合起来测：公开的 A 与私有的 A1 部署停更同一套状态机
const ALL_A = [...PROBE_CHECKS, ...PRIVATE_PROBE_CHECKS];

async function round(state, now, checks = ALL_A) {
  const cfg = cfgFor(fake.base);
  const ctx = buildContext({ cfg, now, repoRoot: ROOT, state, tlsConnect: fake.tlsConnect });
  ctx.pkgChangedAt = now - 100 * 3600 * 1000;
  ctx.required ??= FAKE_UI; // 公开仓里没有 nextjs/package.json，用假站点的版本当「main 的要求」 // main 改版本已 100 小时：部署停更超出所有宽限
  const results = await runChecks(checks, ctx);
  const gh = makeGithub({ api: cfg.githubApi, repo: 'o/r', token: 'x', label: 'monitor-test' });
  const out = await processAlerts({ results, state, now, gh, runUrl: 'local' });
  return { results, ...out };
}

before(async () => { fake = await startFake(); });
after(async () => { await fake.close(); });
beforeEach(() => { fake.reset(); fake.gh.issues.clear(); });

test('基线：全绿，不开任何单', async () => {
  const r = await round(emptyState(), Date.now());
  const bad = r.results.filter((x) => x.status === 'fail' || x.status === 'warn');
  assert.deepEqual(bad.map((x) => x.id), [], JSON.stringify(bad, null, 1));
  assert.equal(fake.gh.issues.size, 0);
});

const CASES = [
  ['A1-home', '首页 502', (f) => { f.homeStatus = 502; }],
  ['A1-deploy-lag', '测试站停在旧 UI 版本', (f) => { f.stagingUi = '0.1.0'; }],
  ['A2-search-l1', '搜索超时 > 阈值', (f) => { f.searchDelayMs = 1500; }],
  ['A2-search-l1', 'works 丢 filterable（前端查询 400）', (f) => { f.worksFilterStatus = 400; }],
  ['A2-search-l2', 'L2 缺 entity 索引', (f) => { f.l2Missing = 'entity'; }],
  ['A3-data-bucket', 'h1 根清单不是 JSON', (f) => { f.manifestRootBody = '<html>oops'; }],
  ['A3-data-bucket', 'CDN 未刷新：version.json 落后 latest.json', (f) => { f.versionCommit = 'fff000fff000fff000fff000fff000fff000fff0'; }],
  ['A3-data-bucket', '锚点变成墓碑', (f) => { f.entryTombstone = true; }],
  ['A4-item-pages', '测试站条目页缺书名', (f) => { f.itemTitle = 'Loading…'; }],
  ['A5-edge', '公开反馈泄露手机号', (f) => { f.feedbackItems = [{ id: 'fb_2_b', content: '电话 13912345678', createdAt: new Date().toISOString() }]; }],
  ['A5-edge', '/api/auth/me 未登录却 200', (f) => { f.authMeStatus = 200; }],
  ['A6-staging', '测试站 robots 被放开', (f) => { f.robots = 'User-agent: *\nAllow: /\n'; }],
  ['A7-tls', '证书只剩 5 天', (f) => { f.tlsDays = 5; }],
];

for (const [id, what, inject] of CASES) {
  test(`故障注入 ${id}：${what} → 第 2 轮开单 → 恢复关单`, async () => {
    const t0 = Date.now();
    let state = emptyState();
    inject(fake.faults);

    let r = await round(state, t0);
    assert.equal(r.results.find((x) => x.id === id).status, 'fail', `${id} 注入后应失败`);
    assert.equal(fake.gh.issues.size, 0, '第 1 轮不开单');
    state = r.state;

    r = await round(state, t0 + 15 * 60000);
    state = r.state;
    const opened = [...fake.gh.issues.values()].filter((i) => i.body.includes(`monitor-check:${id}`));
    assert.equal(opened.length, 1, '第 2 轮开且只开一张单');
    assert.deepEqual(opened[0].labels, ['monitor-test']);
    assert.match(opened[0].title, new RegExp(id));
    assert.match(opened[0].body, /❌/);
    // 没被注入的项不许顺带开单（隔离性）
    assert.equal(fake.gh.issues.size, 1, `只该开 ${id} 一张，实际：${[...fake.gh.issues.values()].map((i) => i.title)}`);

    r = await round(state, t0 + 30 * 60000);
    state = r.state;
    assert.equal(opened[0].comments.length, 0, '同样的失败 6 小时内不评论');

    fake.reset();
    r = await round(state, t0 + 45 * 60000);
    assert.equal(opened[0].state, 'closed', '恢复后自动关');
    assert.equal(opened[0].state_reason, 'completed');
    assert.match(opened[0].comments.at(-1), /已恢复.*故障持续约 45 分钟/);
  });
}

test('A5 生产未配 OAuth（503 temporarily_unavailable）只记 warn，不开单', async () => {
  fake.faults.oauthStatus = 503;
  let s = emptyState();
  for (let i = 0; i < 3; i += 1) s = (await round(s, Date.now() + i * 900000)).state;
  assert.equal(fake.gh.issues.size, 0);
});

test('A2 命中数塌缩到基线 90% 以下 → 失败；塌缩值不进基线', async () => {
  let s = emptyState();
  const t0 = Date.now();
  for (let i = 0; i < 3; i += 1) s = (await round(s, t0 + i * 900000)).state;
  fake.faults.searchHits = 100; // 基线 500
  const r = await round(s, t0 + 4 * 900000);
  const a2 = r.results.find((x) => x.id === 'A2-search-l1');
  assert.equal(a2.status, 'fail');
  assert.ok(a2.parts.some((p) => p.label === '命中数 vs 基线' && p.status === 'fail'));
  assert.ok(!r.state.baselines['searchHits:史記'].includes(100));
});

test('B1 错误数突增：> max(20, 均值×5) 报，缺 token 时 skip', async () => {
  const t0 = Date.now();
  let r = await round(emptyState(), t0, DATA_CHECKS);
  assert.equal(r.results.find((x) => x.id === 'B1-errors').status, 'skip', '生产 503 未配置 → skip');

  fake.faults.errorSummary = { count: 30, count24h: 53, top: [{ kind: 'fetch', message: 'x', count: 30 }] };
  r = await round(emptyState(), t0, DATA_CHECKS);
  // 前 23 小时均值 = 1，max(20, 5) = 20，30 > 20
  assert.equal(r.results.find((x) => x.id === 'B1-errors').status, 'fail');

  fake.faults.errorSummary = { count: 30, count24h: 30 + 23 * 10, top: [] };
  r = await round(emptyState(), t0, DATA_CHECKS);
  // 均值 10，阈值 50，30 不报
  assert.equal(r.results.find((x) => x.id === 'B1-errors').status, 'ok');
});

test('B2 反馈刷屏：公开列表 1 小时内 > 20 条报', async () => {
  const now = Date.now();
  fake.faults.feedbackItems = Array.from({ length: 25 }, (_, i) => ({ id: `fb_${i}`, content: 'spam', createdAt: new Date(now - i * 60000).toISOString() }));
  const r = await round(emptyState(), now, DATA_CHECKS);
  assert.equal(r.results.find((x) => x.id === 'B2-feedback-rate').status, 'fail');
});

test('B3 数据新鲜度：最早未上线提交 > 36h 报，≤ 36h 不报', async () => {
  const now = Date.now();
  const at = (h) => ({ commit: { committer: { date: new Date(now - h * 3600000).toISOString() } } });
  fake.faults.compare = { ahead_by: 2, commits: [at(40), at(1)] };
  let r = await round(emptyState(), now, DATA_CHECKS);
  assert.equal(r.results.find((x) => x.id === 'B3-freshness').status, 'fail');
  fake.faults.compare = { ahead_by: 1, commits: [at(20)] };
  r = await round(emptyState(), now, DATA_CHECKS);
  assert.equal(r.results.find((x) => x.id === 'B3-freshness').status, 'ok');
});

// ── IM 推送（overview#287）：开单推一次、内容变化推一次、持续失败不重复推、恢复推一次 ──
test('推送：开单推一次、内容变化推一次、持续失败与 6 小时提醒不重复推、恢复推一次；推送失败不影响开单', async () => {
  const pushed = [];
  let hookStatus = 200;
  const hook = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => { pushed.push(JSON.parse(b).text); res.writeHead(hookStatus); res.end('{}'); });
  });
  await new Promise((r) => hook.listen(0, '127.0.0.1', r));
  const env = { HEALTH_NOTIFY_WEBHOOK: `http://127.0.0.1:${hook.address().port}/hook/AbCdEf123456SECRETKEY` };
  const step = async (state, now) => {
    const r = await round(state, now);
    const pr = await pushAlerts({ notify: r.notify, runUrl: 'run-url', now, env });
    return { ...r, pr };
  };
  try {
    const t0 = Date.now();
    fake.faults.authMeStatus = 200; // A5 的一个子项失败
    let r = await step(emptyState(), t0);
    assert.equal(r.pr, null, '第 1 轮失败还没开单，不推');
    assert.equal(pushed.length, 0);

    r = await step(r.state, t0 + 5 * 60000);
    assert.equal(r.pr.status, 'sent', '第 2 轮开单，推一次');
    assert.equal(pushed.length, 1);
    assert.match(pushed[0], /🔴 A5-edge/);
    assert.match(pushed[0], /run-url/);

    r = await step(r.state, t0 + 10 * 60000);
    assert.equal(pushed.length, 1, '持续同样失败：不重复推');

    r = await step(r.state, t0 + 7 * 3600000);
    assert.equal(pushed.length, 1, '6 小时提醒只在 issue 里评论，不推');

    // 同一项换了失败的子项（签名变了）才算「内容变化」；数值抖动不算
    fake.faults.feedbackItems = [{ id: 'fb_2_b', content: '电话 13912345678', createdAt: new Date().toISOString() }];
    hookStatus = 500; // 推送坏了：失败不抛，issue 评论照常
    r = await step(r.state, t0 + 7 * 3600000 + 5 * 60000);
    assert.equal(pushed.length, 2, '失败内容有变化：推一次');
    assert.match(pushed[1], /有变化/);
    assert.equal(r.pr.status, 'failed');
    assert.ok(!r.pr.detail.includes('AbCdEf123456SECRETKEY'));

    hookStatus = 200;
    fake.reset();
    r = await step(r.state, t0 + 8 * 3600000);
    assert.equal(pushed.length, 3, '恢复：推一次');
    assert.match(pushed[2], /✅ A5-edge.*已恢复/);

    r = await step(r.state, t0 + 8 * 3600000 + 5 * 60000);
    assert.equal(pushed.length, 3, '恢复后全绿：不推');
  } finally {
    hook.close();
  }
});
