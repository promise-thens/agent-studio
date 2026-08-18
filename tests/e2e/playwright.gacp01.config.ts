import { defineConfig } from '@playwright/test'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/** 真机观察独立运行，默认 pnpm test 不会启动 Electron 或消耗真实模型。 */
export default defineConfig({
  testDir: '.',
  testMatch: 'gacp-01-real-grok-observation.spec.ts',
  timeout: 15 * 60_000,
  expect: { timeout: 180_000 },
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  outputDir: join(tmpdir(), 'agent-studio-gacp01-observe-playwright-results')
})
