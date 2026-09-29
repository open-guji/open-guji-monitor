/**
 * 告警推送到 IM webhook（overview#287 M2）。
 *
 * 只用一个可选 secret：HEALTH_NOTIFY_WEBHOOK；缺了就静默跳过，issue 告警不受影响。
 * 格式由环境变量 HEALTH_NOTIFY_FORMAT 指定：generic（默认）| feishu | dingtalk | slack | pushplus，
 * 口径与私有仓 ops/health-notify.sh 一致（pushplus 时 HEALTH_NOTIFY_WEBHOOK 填 token 本身或含 token= 的 URL，发往固定端点）。
 *
 * 本仓是公开的，日志和报告里不许出现 webhook 地址或 token：
 *   - 任何要写进日志的文字先过 redact()，它把 webhook 整串、URL 的各段、token 都换成 ***；
 *   - 报错只写异常类型和错误码，不写异常 message（node 的 fetch 报错常带 URL）；
 *   - 返回值里的 detail 是可以直接打印的。
 * 推送失败绝不抛异常、不改退出码：探测和 issue 告警是主链路，推送只是「推到人眼前」的一跳。
 */

export const FORMATS = ['generic', 'feishu', 'dingtalk', 'slack', 'pushplus'];
const PUSHPLUS_ENDPOINT = 'https://www.pushplus.plus/send';

/** 从 webhook 配置里取出 pushplus token（token 本身，或 URL 里的 token= 参数） */
export function pushplusToken(webhook) {
  const m = /[?&]token=([^&]+)/.exec(webhook);
  return m ? m[1] : webhook.replace(/\s+/g, '');
}

/** 所有不该出现在日志里的片段：整串、URL 的主机／路径段／查询值、token */
export function secretFragments(webhook, format) {
  const w = String(webhook || '').trim();
  if (!w) return [];
  const out = new Set([w]);
  try {
    const u = new URL(w);
    out.add(u.href);
    out.add(u.host);
    if (u.pathname.length > 1) out.add(u.pathname);
    for (const seg of u.pathname.split('/')) if (seg.length >= 6) out.add(seg);
    for (const [, v] of u.searchParams) if (v.length >= 6) out.add(v);
  } catch { /* 不是 URL（pushplus 直接填 token） */ }
  if (format === 'pushplus') out.add(pushplusToken(w));
  return [...out].filter((s) => s.length >= 6).sort((a, b) => b.length - a.length);
}

export function redact(text, webhook, format = 'generic') {
  let s = String(text ?? '');
  for (const f of secretFragments(webhook, format)) s = s.split(f).join('***');
  return s;
}

export function buildPayload(format, title, text, token = '') {
  switch (format) {
    case 'feishu': return { msg_type: 'text', content: { text } };
    case 'dingtalk': return { msgtype: 'text', text: { content: text } };
    case 'pushplus': return { token, title, content: text, template: 'txt' };
    default: return { text }; // generic、slack
  }
}

/** 响应算不算成功：HTTP 2xx，且各家的业务码没报错（generic 发到飞书／钉钉会 200 + 非 0 业务码，说明格式配错） */
export function judge(format, status, body) {
  if (!(status >= 200 && status < 300)) return { ok: false, why: `HTTP ${status}，格式 ${format} 可能不匹配` };
  const int = (key) => { const m = new RegExp(`"${key}"\\s*:\\s*(-?\\d+)`).exec(body); return m ? Number(m[1]) : null; };
  if (format === 'feishu') return int('code') === 0 ? { ok: true } : { ok: false, why: `HTTP ${status} 但业务码 code=${int('code')}，webhook 可能不是飞书类型` };
  if (format === 'dingtalk') return int('errcode') === 0 ? { ok: true } : { ok: false, why: `HTTP ${status} 但业务码 errcode=${int('errcode')}，webhook 可能不是钉钉类型` };
  if (format === 'pushplus') return int('code') === 200 ? { ok: true } : { ok: false, why: `HTTP ${status} 但业务码 code=${int('code')}（905 等为失败，如未实名）` };
  for (const key of ['code', 'errcode', 'StatusCode']) {
    const v = int(key);
    if (v != null && v !== 0) return { ok: false, why: `HTTP ${status} 但响应含非 0 业务码 ${key}=${v}，格式 ${format} 可能与接收端不匹配` };
  }
  return { ok: true };
}

/**
 * 推一条。
 * @returns {Promise<{status:'skipped'|'sent'|'failed', detail:string}>} detail 已脱敏，可直接打印
 */
export async function pushNotify({ title, text, env = process.env, fetchImpl = globalThis.fetch, timeoutMs = 10000 }) {
  const webhook = String(env.HEALTH_NOTIFY_WEBHOOK || '').trim();
  if (!webhook) return { status: 'skipped', detail: 'HEALTH_NOTIFY_WEBHOOK 未配置，跳过推送（仅 issue 告警）' };
  const format = (env.HEALTH_NOTIFY_FORMAT || 'generic').trim() || 'generic';
  if (!FORMATS.includes(format)) {
    return { status: 'failed', detail: `HEALTH_NOTIFY_FORMAT 不认识（可选 ${FORMATS.join('／')}），未推送` };
  }
  const url = format === 'pushplus' ? PUSHPLUS_ENDPOINT : webhook;
  const payload = buildPayload(format, title, text, format === 'pushplus' ? pushplusToken(webhook) : '');
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'kaiyuanguji-monitor/1 (+github actions)' },
      body: JSON.stringify(payload),
      redirect: 'manual',
      signal: ac.signal,
    });
    const body = await res.text().catch(() => '');
    const j = judge(format, res.status, body);
    return j.ok
      ? { status: 'sent', detail: `已推送（HTTP ${res.status}，格式 ${format}）` }
      : { status: 'failed', detail: redact(`推送失败：${j.why}`, webhook, format) };
  } catch (e) {
    // 只写类型和错误码；e.message 常带 URL
    const reason = e?.name === 'AbortError' ? `超时 ${timeoutMs}ms` : `${e?.name || 'Error'}${e?.cause?.code ? ` ${e.cause.code}` : ''}`;
    return { status: 'failed', detail: redact(`推送失败：${reason}，webhook 可能不可达`, webhook, format) };
  } finally {
    clearTimeout(timer);
  }
}
