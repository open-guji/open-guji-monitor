/**
 * 正式站与测试站的对比采样（任务书 §六）。CUT2（2026-09-28）后 www 已是全栈（kyg-ssr-spike），
 * 原先的「旧·静态 vs 新·全栈（ssr-test）」对比不再成立，改成「正式站 www vs 测试站 staging」，
 * 两边同一套页面（/item/<id> 服务端直出），正式站告警，测试站只记录不开单。
 *
 * 可用 MON_COMPARE_TARGETS（JSON，同下面的形状）整体覆盖；MON_COMPARE_NEW 只换测试站地址。
 */

// 10 个条目：热门 4 个（锚点／perf 场景里已有，perf-ids 契约盯着不烂）＋冷门 6 个（e2e 空状态候选池，几乎没人访问，CDN 多半没缓存）
export const COMPARE_IDS = [
  { id: 'd59f20aowb9c', note: '史記（作品，热）' },
  { id: 'hixhd2h9bk4b', note: '孔子（人物，热）' },
  { id: 'd59f2htm01du', note: '直齋書錄解題（整理本，热）' },
  { id: 'd59f1iopaku8', note: 'perf 场景作品（热）' },
  { id: 'd59f2rxf35ds', note: '詩集（裸题作品，冷）' },
  { id: 'd59f2s1eob9c', note: '音（裸题作品，冷）' },
  { id: 'hixhd2h9bcme', note: '蔣良驥（冷门人物）' },
  { id: 'hixhd2h9bdpx', note: '王愈擴（冷门人物）' },
  { id: 'hixhd2h9bfoq', note: '王偕（冷门人物）' },
  { id: 'hixhd2h9bg06', note: '翟鳳翥（冷门人物）' },
];

// 全文页：整理本卷四（e2e/ui/collated.spec.ts 同一个）
const FULLTEXT = '/book-index?id=d59f2htm01du&tab=collated&juan=juan%2F004.json';

// 浏览器指标：首页＋3 个条目页（热、人物、冷各一）
const VITAL_IDS = ['d59f20aowb9c', 'hixhd2h9bk4b', 'd59f2rxf35ds'];

export function loadTargets(env = process.env) {
  if (env.MON_COMPARE_TARGETS) return JSON.parse(env.MON_COMPARE_TARGETS);
  const prodBase = env.MON_WWW || 'https://www.kaiyuanguji.com';
  const stagingBase = env.MON_COMPARE_NEW || env.MON_STAGING || 'https://staging.kaiyuanguji.com';
  const pages = { home: '/', 'item:ssr': '/item/{id}', fulltext: FULLTEXT };
  const vitals = ['/', ...VITAL_IDS.map((id) => `/item/${id}`)];
  return [
    { name: 'prod', label: '正式站（www）', base: prodBase, alert: true, pages, vitals },
    { name: 'staging', label: '测试站（staging）', base: stagingBase, alert: false, pages, vitals },
  ];
}
