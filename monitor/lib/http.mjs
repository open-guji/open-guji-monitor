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

/** 响应的一句话描述，写进报告 */
export function describe(r) {
  return r.status === 0 ? `连不上（${r.error}）` : `HTTP ${r.status}，${r.ms}ms`;
}
