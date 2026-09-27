import { defineConfig } from '@playwright/test';

/**
 * 监控用的最小配置：只有 contract 项目（纯 HTTP，不开浏览器），打公开的正式站。
 * 用例从 kaiyuanguji-web 的 e2e/ 复制而来（见仓根 README「e2e 从哪来」）。
 */
export default defineConfig({
    testDir: '.',
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 1 : 0,
    workers: 4,
    reporter: process.env.CI
        ? [['list'], ['json', { outputFile: 'out/results.json' }]]
        : [['list']],
    timeout: 120_000,
    expect: { timeout: 15_000 },
    projects: [{ name: 'contract', testDir: './contract', use: {} }],
});
