import { describe, expect, it } from 'vitest'
import { collectStudioMenuAccelerators, createStudioMenuTemplate } from './application-menu'

describe('应用菜单缩放项', () => {
  it('macOS 保留 appMenu，放大同时绑 = 和 Plus', () => {
    const template = createStudioMenuTemplate('darwin')
    expect(template[0]?.role).toBe('appMenu')
    const accelerators = collectStudioMenuAccelerators(template)
    expect(accelerators).toContain('CommandOrControl+=')
    expect(accelerators).toContain('CommandOrControl+Plus')
    expect(accelerators).toContain('CommandOrControl+-')
    expect(accelerators).toContain('CommandOrControl+0')
  })

  it('非 macOS 不插 appMenu，缩放加速键仍在', () => {
    const template = createStudioMenuTemplate('win32')
    expect(template.some((item) => item.role === 'appMenu')).toBe(false)
    expect(collectStudioMenuAccelerators(template)).toContain('CommandOrControl+=')
  })
})
