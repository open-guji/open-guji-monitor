/**
 * 带超时、计时、不抛异常的 fetch。连不上／超时一律 status=0，error 写原因，
 * 让检查项只需看 status，不用各自 try/catch。
 */
export async function request(url, { method = 'GET', headers = {}, body, timeoutMs = 20000, redirect = 'manual' } = {}) {
  const t0 = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: { 'user-agent': 'kaiyuanguji-monitor/1 (+github actions)', ...headers },
      body,
      redirect,
      signal: ac.signal,
    });
    const text = await res.text();
    return { url, status: res.status, ms: Date.now() - t0, text, headers: res.headers, error: null };
  } catch (e) {
    const reason = e?.name === 'AbortError' ? `超时 ${timeoutMs}ms` : (e?.cause?.code || e?.message || String(e));
    return { url, status: 0, ms: Date.now() - t0, text: '', headers: new Headers(), error: reason };
  } finally {
    clearTimeout(timer);
  }
}

/** 解析 JSON，失败返回 undefined（不抛） */
export function parseJson(text) {
  try { return JSON.parse(text); } catch { return undefined; }
}

/** 给 URL 挂一个时间戳绕开 CDN 边缘缓存（同 e2e/fixtures/version.ts 的 dataUrl） */
export function bust(url) {
  return `${url}${url.includes('?') ? '&' : '?'}_=${Date.now()}`;
}

/**
 * 条目页 /item/<id> 用的绕缓存参数。不能用 bust()：网站（overview#280 S1）对条目页带「白名单之外的参数」的
 * 整页请求一律 308 到干净地址，`?_=` 会被跳走、A4 就红了（2026-09-29 实测）。
 * 白名单里的 `page` 是详情组件自己的分页参数，不影响 SSR 内容，每次取不同的值即可绕开 CDN 缓存、打到源站。
 * 网站那边若改了白名单，A4 会报 308，看 nextjs/src/lib/item-query.ts。
 */
export function bustItem(url) {
  return `${url}${url.includes('?') ? '&' : '?'}page=${Date.now()}`;
}

/**
 * 非 200 响应里 EdgeOne 排障用的头：`EO-LOG-UUID=… Eo-Cache-Status=… Date=…`，没有的头不写。
 * 用户拿 UUID 到 EdgeOne 控制台的日志里按 UUID 查这一次请求（overview#484）。
 */
export function edgeHeaders(r) {
  const h = r?.headers;
  if (!h || typeof h.get !== 'function') return '';
  return ['EO-LOG-UUID', 'Eo-Cache-Status', 'Date'].map((k) => [k, h.get(k)]).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(' ');
}

/** 响应的一句话描述，写进报告；非 200 时附 EdgeOne 的日志 UUID、缓存状态与时间 */
export function describe(r) {
  if (r.status === 0) return `连不上（${r.error}）`;
  const base = `HTTP ${r.status}，${r.ms}ms`;
  const hdr = r.status === 200 ? '' : edgeHeaders(r);
  return hdr ? `${base} [${hdr}]` : base;
}
