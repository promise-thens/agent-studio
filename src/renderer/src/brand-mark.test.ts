import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const rendererDir = dirname(fileURLToPath(import.meta.url))
const appSource = readFileSync(join(rendererDir, 'App.vue'), 'utf8')
const onboardingSource = readFileSync(
  join(rendererDir, 'components/ProviderOnboarding.vue'),
  'utf8'
)
const brandMarkSource = readFileSync(join(rendererDir, 'components/BrandMark.vue'), 'utf8')
const brandMarkSvg = readFileSync(join(rendererDir, 'assets/brand-mark.svg'), 'utf8')
const wordmarkSvg = readFileSync(join(rendererDir, 'assets/brand-wordmark.svg'), 'utf8')

describe('Agent Studio 三元结品牌标', () => {
  it('标题栏和引导页使用 BrandMark，不再用通用机器人图标', () => {
    expect(appSource).toContain('<BrandMark')
    expect(appSource).not.toContain('PhRobot')
    expect(onboardingSource).toContain('<BrandMark')
    expect(onboardingSource).not.toContain('PhRobot')
  })

  it('图形标与字标都是矢量 currentColor/产品名，而不是位图字母', () => {
    expect(brandMarkSource).toContain('fill-rule="evenodd"')
    expect(brandMarkSource).toContain('currentColor')
    expect(brandMarkSvg).toContain('viewBox="0 0 64 64"')
    expect(wordmarkSvg).toContain('Agent Studio')
    expect(wordmarkSvg).not.toMatch(/Agnet|Aegnt|Agnet Studio/)
  })
})
