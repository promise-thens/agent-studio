import { defineConfig } from '@playwright/test'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/** 权限 E2E 独立运行，默认 Vitest 不会启动 Electron 或占用桌面会话。 */
export default defineConfig({
  testDir: '.',
  testMatch: 'permission-broker.spec.ts',
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  outputDir: join(tmpdir(), 'agent-studio-controlled-acp-playwright-results')
})
