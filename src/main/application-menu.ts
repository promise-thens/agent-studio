import type { WindowZoomAction } from '../shared/window-zoom'

export interface StudioMenuItem {
  role?: 'appMenu' | 'editMenu' | 'windowMenu' | 'reload' | 'toggleDevTools' | 'togglefullscreen'
  type?: 'separator'
  label?: string
  accelerator?: string
  visible?: boolean
  zoomAction?: WindowZoomAction
  submenu?: StudioMenuItem[]
}

/** 收集菜单树里的 accelerator，测试用，不依赖 Electron。 */
export function collectStudioMenuAccelerators(items: readonly StudioMenuItem[]): string[] {
  const accelerators: string[] = []
  for (const item of items) {
    if (item.accelerator) accelerators.push(item.accelerator)
    if (item.submenu) accelerators.push(...collectStudioMenuAccelerators(item.submenu))
  }
  return accelerators
}

/**
 * 应用菜单规格。缩放不用 Electron role，以便同时绑定 = 和 Plus，
 * 并与主进程 setZoomFactor 的 10% 步进保持一致。
 */
export function createStudioMenuTemplate(platform: NodeJS.Platform): StudioMenuItem[] {
  const viewMenu: StudioMenuItem = {
    label: '显示',
    submenu: [
      { role: 'reload' },
      { role: 'toggleDevTools' },
      { type: 'separator' },
      { label: '放大', accelerator: 'CommandOrControl+=', zoomAction: 'in' },
      {
        label: '放大',
        accelerator: 'CommandOrControl+Plus',
        zoomAction: 'in',
        visible: false
      },
      { label: '缩小', accelerator: 'CommandOrControl+-', zoomAction: 'out' },
      { label: '实际大小', accelerator: 'CommandOrControl+0', zoomAction: 'reset' },
      { type: 'separator' },
      { role: 'togglefullscreen' }
    ]
  }

  const items: StudioMenuItem[] = []
  if (platform === 'darwin') items.push({ role: 'appMenu' })
  items.push({ role: 'editMenu' }, viewMenu, { role: 'windowMenu' })
  return items
}
