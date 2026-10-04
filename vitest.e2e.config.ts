import { defineConfig } from 'vitest/config'

// 端到端测试：用 Playwright 驱动构建好的界面，外部服务都换成本地模拟服务器。
// 运行：npm run build && npm run e2e:stages
export default defineConfig({
  test: {
    include: ['e2e/**/*.test.ts'],
    testTimeout: 180000,
    hookTimeout: 120000,
    fileParallelism: false,
  },
})
