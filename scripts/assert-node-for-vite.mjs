import crypto from 'node:crypto'

/**
 * Vite 7 用 node:crypto.hash 算依赖锁。Node 18 / 过旧的 20.x 没有这个函数，
 * 会在 electron-vite 起 dev server 时抛 TypeError: crypto.hash is not a function。
 * 用默认导入再检查，避免旧 Node 对 named export `hash` 直接抛 SyntaxError。
 */
if (typeof crypto.hash !== 'function') {
  console.error(
    `当前 Node ${process.version}（${process.execPath}）没有 crypto.hash，Vite 7 无法启动。\n` +
      '需要 Node 20.19+ 或 22.12+。本仓库建议：\n' +
      '  nvm use\n' +
      '  pnpm dev\n' +
      '若终端没加载 nvm（常见于 Cursor / VS Code）：\n' +
      '  export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use && pnpm dev'
  )
  process.exit(1)
}
