import { defineConfig } from '@playwright/test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 生命周期 E2E 独立串行运行，避免多个 Electron 实例争用桌面和受控 fixture。 */
export default defineConfig({
  testDir: '.',
  testMatch: 'task-executor-background-lifecycle.spec.ts',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  outputDir: join(tmpdir(), 'agent-studio-lifecycle-playwright-results')
})
