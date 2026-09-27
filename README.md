# open-guji-monitor

开源古籍网站 [kaiyuanguji.com](https://www.kaiyuanguji.com) 的公开监控：定时探测、告警、新旧架构性能对比。

- 监控代码只在本仓维护。网站仓 `open-guji/kaiyuanguji-web`（私有）的 `monitor.yml` 每小时 checkout 本仓，
  用 `--suite private` 跑要 token 的那一半（前端错误数、反馈量、数据新鲜度、部署停更），告警开在私有仓。
- 本仓**不放任何 secret**，只探测公开站点；日志与告警 issue 都公开。
- 放公开仓是因为公开仓的 Actions 分钟数免费（任务书 §八，2026-09-27 用户定）。

| 在哪跑 | 跑什么 | 多久一次 |
|---|---|---|
| 本仓 `.github/workflows/monitor.yml` | A 主动探测（首页、搜索 L1/L2、数据桶、条目页、边缘函数、测试站、证书）＋ 新旧对比 HTTP 采样 | 15 分钟 |
| 本仓 | C 契约冒烟（`e2e/contract`）＋ 新旧对比浏览器指标 ＋ 24h 对比报告 | 6 小时 |
| 私有仓 kaiyuanguji-web | A1 部署停更 ＋ B 数据监测 | 1 小时 |

告警：本仓 issue，标签 `monitor`。连续 2 次失败才开，恢复后自动关。
想收邮件，就 Watch 本仓（Custom → Issues）。

每项测什么、阈值、误报怎么调、对比报告怎么读：[monitor/README.md](monitor/README.md)。

## 常用

```bash
cd monitor && npm test                                   # 单测＋故障注入（本地假服务器，不打线上）
node monitor/run.mjs --suite probe --dry-run             # 真打线上，只出报告
node monitor/compare-report.mjs --hours 48 --samples … --vitals …   # 对比报告
```

手动出 48 小时对比报告：Actions → Monitor → Run workflow，`suite=compare`、`hours=48`，结果在 Summary 和 artifact 里。

## e2e 从哪来

`e2e/contract/`、`e2e/fixtures/`、`e2e/package*.json` 复制自 kaiyuanguji-web 的 `e2e/`（只读用例，本来就只打公开站点）。
`e2e/playwright.config.ts` 精简成只有 contract 项目。改过两处：
- `site-build.spec.ts`「线上前端不比本 commit 要求的旧」和 `perf-ids.spec.ts`「perf 场景 ID」
  各要读网站仓的 `nextjs/package.json`、`perf/*.ts`，本仓没有，所以文件不在时跳过（这两条由网站仓自己的 CI 负责）。

网站仓的 e2e 改了之后，照上面的做法再同步一次。
