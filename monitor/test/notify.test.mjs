/** IM 推送（overview#287）：成功、失败不拖垮探测、未配置跳过、URL 脱敏。webhook 用本机假服务，不发外网。 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { pushNotify, redact, buildPayload, judge, pushplusToken } from '../lib/notify.mjs';
import { pushAlerts, NOTIFY_TEST_TEXT } from '../run.mjs';

let server; let base; let hits; let reply;
before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      hits.push({ url: req.url, body: JSON.parse(body || '{}') });
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(reply.body);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());
beforeEach(() => { hits = []; reply = { status: 200, body: '{}' }; });

// 假 secret，长度和形状像真的，测脱敏用
const SECRET_PATH = '/hook/send/AbCdEf123456SECRETKEY';
const env = (extra = {}) => ({ HEALTH_NOTIFY_WEBHOOK: `${base}${SECRET_PATH}?key=Zz9Yy8Xx7Ww6`, ...extra });

test('未配置 HEALTH_NOTIFY_WEBHOOK：静默跳过，不发请求', async () => {
  const r = await pushNotify({ title: 't', text: 'x', env: {} });
  assert.equal(r.status, 'skipped');
  assert.equal(hits.length, 0);
});

test('generic：POST {text}，成功', async () => {
  const r = await pushNotify({ title: 't', text: '你好', env: env() });
  assert.equal(r.status, 'sent');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].url, `${SECRET_PATH}?key=Zz9Yy8Xx7Ww6`);
  assert.deepEqual(hits[0].body, { text: '你好' });
});

test('各格式的 payload 与私有仓 ops/health-notify.sh 一致', () => {
  assert.deepEqual(buildPayload('feishu', 'T', 'x'), { msg_type: 'text', content: { text: 'x' } });
  assert.deepEqual(buildPayload('dingtalk', 'T', 'x'), { msgtype: 'text', text: { content: 'x' } });
  assert.deepEqual(buildPayload('slack', 'T', 'x'), { text: 'x' });
  assert.deepEqual(buildPayload('pushplus', 'T', 'x', 'tok'), { token: 'tok', title: 'T', content: 'x', template: 'txt' });
});

test('pushplus token：填 token 本身或含 token= 的 URL 都行', () => {
  assert.equal(pushplusToken(' abc123def456 \n'), 'abc123def456');
  assert.equal(pushplusToken('https://www.pushplus.plus/send?token=abc123def456&x=1'), 'abc123def456');
});

test('业务码判定：飞书／钉钉／PushPlus／generic 发错格式', () => {
  assert.equal(judge('feishu', 200, '{"code":0}').ok, true);
  assert.equal(judge('feishu', 200, '{"code":19002}').ok, false);
  assert.equal(judge('dingtalk', 200, '{"errcode": 0}').ok, true);
  assert.equal(judge('dingtalk', 200, '{"errcode":310000}').ok, false);
  assert.equal(judge('pushplus', 200, '{"code":200,"msg":"请求成功"}').ok, true);
  assert.equal(judge('pushplus', 200, '{"code":905}').ok, false);
  assert.equal(judge('generic', 200, '{"code":19002}').ok, false, 'generic 发到飞书：HTTP 200 + 非 0 业务码 = 格式配错');
  assert.equal(judge('generic', 200, 'ok').ok, true);
  assert.equal(judge('generic', 500, '').ok, false);
});

test('HTTP 500：返回 failed，不抛', async () => {
  reply = { status: 500, body: 'boom' };
  const r = await pushNotify({ title: 't', text: 'x', env: env() });
  assert.equal(r.status, 'failed');
});

test('连不上：返回 failed，不抛，detail 不含 URL', async () => {
  const dead = { HEALTH_NOTIFY_WEBHOOK: `http://127.0.0.1:1${SECRET_PATH}?key=Zz9Yy8Xx7Ww6` };
  const r = await pushNotify({ title: 't', text: 'x', env: dead, timeoutMs: 2000 });
  assert.equal(r.status, 'failed');
  for (const frag of ['127.0.0.1', SECRET_PATH, 'AbCdEf123456SECRETKEY', 'Zz9Yy8Xx7Ww6']) assert.ok(!r.detail.includes(frag), `detail 不许含 ${frag}：${r.detail}`);
});

test('超时：failed，且不拖住调用方', async () => {
  const slow = http.createServer(() => { /* 不回 */ });
  await new Promise((r) => slow.listen(0, '127.0.0.1', r));
  const t0 = Date.now();
  const r = await pushNotify({ title: 't', text: 'x', env: { HEALTH_NOTIFY_WEBHOOK: `http://127.0.0.1:${slow.address().port}/hook/AbCdEf123456` }, timeoutMs: 300 });
  slow.closeAllConnections?.();
  slow.close();
  assert.equal(r.status, 'failed');
  assert.match(r.detail, /超时/);
  assert.ok(Date.now() - t0 < 3000);
});

test('fetch 抛出带 URL 的异常：detail 里没有 URL 也没有 secret', async () => {
  const secret = `https://open.example.com${SECRET_PATH}?key=Zz9Yy8Xx7Ww6`;
  const boom = async () => { throw Object.assign(new TypeError(`fetch failed for ${secret}`), { cause: { code: 'ECONNRESET' } }); };
  const r = await pushNotify({ title: 't', text: 'x', env: { HEALTH_NOTIFY_WEBHOOK: secret }, fetchImpl: boom });
  assert.equal(r.status, 'failed');
  assert.match(r.detail, /ECONNRESET/);
  for (const frag of ['open.example.com', 'AbCdEf123456SECRETKEY', 'Zz9Yy8Xx7Ww6', 'https://']) assert.ok(!r.detail.includes(frag), `detail 不许含 ${frag}：${r.detail}`);
});

test('响应体回显了 webhook：不进 detail', async () => {
  reply = { status: 400, body: `{"error":"bad url ${base}${SECRET_PATH}"}` };
  const r = await pushNotify({ title: 't', text: 'x', env: env() });
  assert.equal(r.status, 'failed');
  assert.ok(!r.detail.includes('AbCdEf123456SECRETKEY'));
});

test('redact：整串、URL 各段、查询值、token 都换成 ***', () => {
  const w = `https://h.example.com${SECRET_PATH}?key=Zz9Yy8Xx7Ww6`;
  const s = redact(`err ${w} host h.example.com seg AbCdEf123456SECRETKEY q Zz9Yy8Xx7Ww6`, w);
  assert.equal(s, 'err *** host *** seg *** q ***');
  assert.equal(redact('token=tok-1234567890', 'tok-1234567890', 'pushplus'), 'token=***');
  assert.equal(redact('没配 webhook 时原样', ''), '没配 webhook 时原样');
});

test('HEALTH_NOTIFY_FORMAT 写错：failed，不发请求', async () => {
  const r = await pushNotify({ title: 't', text: 'x', env: env({ HEALTH_NOTIFY_FORMAT: 'wechat-work' }) });
  assert.equal(r.status, 'failed');
  assert.equal(hits.length, 0);
});

test('pushAlerts：没有告警动作就不碰网络；有就推一条，带 run 链接', async () => {
  assert.equal(await pushAlerts({ notify: [], runUrl: 'u', env: env() }), null);
  assert.equal(hits.length, 0);
  const r = await pushAlerts({ notify: ['🔴 A1-home 首页 连续 2 次失败，issue #7'], runUrl: 'https://github.com/o/r/actions/runs/1', env: env() });
  assert.equal(r.status, 'sent');
  assert.equal(hits.length, 1);
  assert.match(hits[0].body.text, /A1-home/);
  assert.match(hits[0].body.text, /actions\/runs\/1/);
});

test('测试文本固定，且 pushNotify 原样发出（不带探测内容）', async () => {
  assert.equal(NOTIFY_TEST_TEXT, '【监控测试】推送链路正常');
  await pushNotify({ title: NOTIFY_TEST_TEXT, text: NOTIFY_TEST_TEXT, env: env({ HEALTH_NOTIFY_FORMAT: 'pushplus', HEALTH_NOTIFY_WEBHOOK: 'tok-1234567890abcd' }), fetchImpl: async (url, init) => { hits.push({ url, body: JSON.parse(init.body) }); return new Response('{"code":200}', { status: 200 }); } });
  assert.deepEqual(hits[0].body, { token: 'tok-1234567890abcd', title: NOTIFY_TEST_TEXT, content: NOTIFY_TEST_TEXT, template: 'txt' });
  assert.equal(hits[0].url, 'https://www.pushplus.plus/send');
});
