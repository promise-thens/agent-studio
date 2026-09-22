import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const FAKE_KEY = 'gacp07-fake-key-not-a-real-credential'
const EXPECTED_HASH = '9cd26b579840f0f5c9148a8059ad651904c08b41b7f2ef0b4ec04b9ba898844e'

/** 子进程不继承宿主环境、代理、真实凭据或用户配置路径。 */
export function isolatedEnvironment(root) {
  return {
    HOME: join(root, 'home'),
    GROK_HOME: join(root, 'grok-home'),
    TMPDIR: join(root, 'tmp'),
    XDG_CONFIG_HOME: join(root, 'home', '.config'),
    XDG_CACHE_HOME: join(root, 'home', '.cache'),
    PATH: '/usr/bin:/bin',
    LANG: 'en_US.UTF-8',
    TERM: 'dumb',
    GACP07_FAKE_KEY: FAKE_KEY
  }
}

/** 只开放隔离目录和系统库读取、指定程序执行、唯一 Mock 端口；不依赖 Grok 自觉遵守。 */
export function isolationProfile(root, executable, port) {
  const quote = JSON.stringify
  return `(version 1)
(allow default)
(deny file-read-data
  (require-not (require-any
    (literal "/")
    (subpath ${quote(root)})
    (subpath "/System") (subpath "/usr") (subpath "/bin")
    (subpath "/Library/Apple") (subpath "/private/var/db")
    (subpath "/dev") (literal ${quote(executable)}))))
(deny file-write* (require-not (require-any (subpath ${quote(root)}) (subpath "/dev"))))
(deny process-exec (require-not (literal ${quote(executable)})))
(deny network*)
(allow network-outbound (remote ip "localhost:${port}"))
(deny mach-lookup)
`
}

/** 超时只终止观察，不重发请求、不通过 cancel 或新 prompt 模拟当前轮补充。 */
function deadline(promise, label, milliseconds = 12000) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timeout: ${label}`)), milliseconds)
    })
  ]).finally(() => clearTimeout(timer))
}

/** 根据真实请求中的固定任务说明区分后台标题、摘要，不能拿后台请求冒充同轮模型步骤。 */
export function modelRequestKind(body) {
  const first = body.messages?.[0]?.content
  const last = body.messages?.at(-1)?.content
  if (typeof first === 'string' && first.startsWith('You are tasked with generating the session title.')) return 'title'
  if (typeof last === 'string' && last.startsWith('<system-reminder>Write an ultra-short dashboard line')) return 'recap'
  return 'agent'
}

/** Mock 仅返回文本，永不返回工具调用；后台请求自动完成，正式模型响应显式释放。 */
export async function localProvider(evidence) {
  const pending = []
  const waiters = []
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404).end()
      return
    }
    let raw = ''
    for await (const chunk of request) {
      raw += chunk
      if (raw.length > 2_000_000) {
        response.writeHead(413).end()
        return
      }
    }
    const body = JSON.parse(raw)
    const requestKind = modelRequestKind(body)
    evidence.push({ kind: 'model-request', requestKind, body })
    if (requestKind !== 'agent') {
      reply({ response, body })
      return
    }
    pending.push({ response, body })
    waiters.shift()?.()
  })
  /** 同一静态文本同时支持 Grok 的流式与非流式请求，不决定 Runtime 的轮次状态。 */
  function reply(item) {
      const { response, body } = item
      const content = 'GACP07_LOCAL_RESPONSE'
      if (body.stream) {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        for (const [delta, finishReason] of [
          [{ role: 'assistant', content }, null],
          [{}, 'stop']
        ]) {
          response.write(
            `data: ${JSON.stringify({
              id: 'gacp07-local-completion',
              object: 'chat.completion.chunk',
              created: 1,
              model: 'gacp07-local',
              choices: [{ index: 0, delta, finish_reason: finishReason }]
            })}\n\n`
          )
        }
        response.end('data: [DONE]\n\n')
      } else {
        response.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            id: 'gacp07-local-completion',
            object: 'chat.completion',
            model: 'gacp07-local',
            choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
          })
        )
      }
  }
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  return {
    port: server.address().port,
    async waitForRequest() {
      if (!pending.length) {
        await deadline(new Promise((resolveWait) => waiters.push(resolveWait)), 'model request')
      }
      return pending[0].body
    },
    release() {
      const item = pending.shift()
      if (!item) throw new Error('No held model response')
      reply(item)
    },
    close() {
      server.closeAllConnections()
      return new Promise((resolveClose) => server.close(resolveClose))
    }
  }
}

/** 直接记录真实二进制的 JSON-RPC；拒绝所有客户端工具、文件和权限请求。 */
function acpConnection(child, evidence) {
  let nextId = 1
  const pending = new Map()
  const lines = createInterface({ input: child.stdout })
  lines.on('line', (line) => {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      evidence.push({ kind: 'non-json-stdout', text: line.slice(0, 1000) })
      return
    }
    evidence.push({ kind: 'acp-in', message })
    if (message.method && message.id !== undefined) {
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32601, message: 'GACP07: client side effects forbidden' }
        })}\n`
      )
    } else if (message.id !== undefined) {
      pending.get(message.id)?.(message)
      pending.delete(message.id)
    }
  })
  child.stderr.on('data', (chunk) => {
    evidence.push({ kind: 'stderr', text: chunk.toString().slice(0, 8000) })
  })
  child.on('exit', (code, signal) => evidence.push({ kind: 'exit', code, signal }))
  return {
    request(method, params) {
      const id = nextId++
      const message = { jsonrpc: '2.0', id, method, params }
      evidence.push({ kind: 'acp-out', message })
      const result = deadline(new Promise((done) => pending.set(id, done)), method)
      // 观察首个 prompt 时暂不 await，提前挂拒绝处理以避免未处理拒绝。
      result.catch(() => undefined)
      child.stdin.write(`${JSON.stringify(message)}\n`)
      return result
    }
  }
}

/** 负向对照只访问本次创建的假文件与另一回环端口，不尝试读取真实用户文件或访问外网。 */
async function verifyIsolation(root, env, port, evidence) {
  const outside = await mkdtemp('/private/tmp/gacp07-negative-')
  const node = await realpath(process.execPath)
  try {
    await writeFile(join(outside, 'fake-config'), 'FAKE-ONLY', { mode: 0o600 })
    const script = `
      const fs = require('node:fs');
      const net = require('node:net');
      const {spawnSync} = require('node:child_process');
      let blockedRead = false, blockedWrite = false;
      try { fs.readFileSync(${JSON.stringify(join(outside, 'fake-config'))}); } catch (e) { blockedRead = e.code === 'EPERM' || e.code === 'EACCES'; }
      try { fs.writeFileSync(${JSON.stringify(join(outside, 'fake-write'))}, 'fake'); } catch (e) { blockedWrite = e.code === 'EPERM' || e.code === 'EACCES'; }
      const exec = spawnSync('/usr/bin/true', [], {encoding:'utf8'});
      const result = {blockedRead, blockedWrite, blockedExec: Boolean(exec.error) || exec.status !== 0};
      const denied = net.connect({host:'127.0.0.1',port:${port === 65535 ? port - 1 : port + 1}});
      denied.on('connect', () => process.exit(2));
      denied.on('error', e => {
        result.blockedNetwork = e.code === 'EPERM' || e.code === 'EACCES';
        const allowed = net.connect({host:'127.0.0.1',port:${port}});
        allowed.on('connect', () => { allowed.destroy(); console.log(JSON.stringify(result)); process.exit(Object.values(result).every(Boolean) ? 0 : 3); });
        allowed.on('error', () => process.exit(4));
      });
    `
    const check = spawnSync(
      '/usr/bin/sandbox-exec',
      ['-p', isolationProfile(root, node, port), node, '-e', script],
      { env, cwd: root, encoding: 'utf8', timeout: 10000 }
    )
    evidence.push({
      kind: 'isolation-check',
      status: check.status,
      signal: check.signal,
      stdout: check.stdout,
      stderr: check.stderr
    })
    if (check.status !== 0) throw new Error('Isolation negative controls failed; Grok not started')
  } finally {
    await rm(outside, { recursive: true, force: true })
  }
}

/** 版本冻结的真实 Grok 探针；只在通过 OS 隔离负向对照后启动，任何失败均关闭生产能力门。 */
export async function observeGrokInterjection({ binary, scenario = 'schema', output }) {
  if (process.platform !== 'darwin') throw new Error('Only macOS sandbox-exec is supported')
  const evidence = []
  const report = { schemaVersion: 1, scenario, productionGate: 'blocked', evidence }
  const root = await mkdtemp('/private/tmp/gacp07-isolated-')
  let provider
  let child
  try {
    const contents = await readFile(binary)
    report.binarySha256 = createHash('sha256').update(contents).digest('hex')
    if (report.binarySha256 !== EXPECTED_HASH) throw new Error('Unreviewed Grok binary hash')
    const executable = join(root, 'grok')
    await copyFile(binary, executable)
    await chmod(executable, 0o700)
    const env = isolatedEnvironment(root)
    for (const path of [env.HOME, env.GROK_HOME, env.TMPDIR, join(root, 'work')]) {
      await mkdir(path, { mode: 0o700 })
    }
    provider = await localProvider(evidence)
    await verifyIsolation(root, env, provider.port, evidence)
    const profile = isolationProfile(root, executable, provider.port)
    const version = spawnSync('/usr/bin/sandbox-exec', ['-p', profile, executable, '--version'], {
      env,
      cwd: join(root, 'work'),
      encoding: 'utf8',
      timeout: 10000
    })
    evidence.push({ kind: 'version', status: version.status, stdout: version.stdout, stderr: version.stderr })
    if (version.status !== 0) throw new Error('Isolated Grok cannot start')
    await writeFile(
      join(env.GROK_HOME, 'config.toml'),
      `follow_up_behavior = "steer"\n[model.gacp07-local]\nmodel = "gacp07-local"\nname = "gacp07-local"\nbase_url = "http://127.0.0.1:${provider.port}/v1"\nenv_key = "GACP07_FAKE_KEY"\napi_backend = "chat_completions"\n[memory]\nenabled = false\n`,
      { mode: 0o600 }
    )
    child = spawn(
      '/usr/bin/sandbox-exec',
      ['-p', profile, executable, '--no-auto-update', 'agent', '--no-leader', '-m', 'gacp07-local', 'stdio'],
      { env, cwd: join(root, 'work'), stdio: ['pipe', 'pipe', 'pipe'] }
    )
    const acp = acpConnection(child, evidence)
    const initialized = await acp.request('initialize', {
      protocolVersion: 1,
      clientInfo: { name: 'gacp07-isolated-observer', version: '1' },
      clientCapabilities: {}
    })
    if (initialized.error) throw new Error('initialize rejected')
    const session = await acp.request('session/new', { cwd: join(root, 'work'), mcpServers: [] })
    if (session.error) throw new Error('session/new rejected')
    const sessionId = session.result.sessionId
    if (scenario === 'schema') {
      for (const method of ['x.ai/interject', '_x.ai/interject']) {
        for (const params of [{}, { sessionId }, { sessionId, content: [] }]) {
          await acp.request(method, params)
        }
      }
      await acp.request('x.ai/gacp07-method-does-not-exist', { sessionId })
    } else {
      const marker = `GACP07_INTERJECTION_${randomUUID()}`
      report.marker = marker
      let promptSettled = false
      const turn = acp.request('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: 'GACP07_LOCAL_INITIAL. Reply with plain text only. Never use tools.' }]
      })
      turn.then(() => { promptSettled = true }, () => { promptSettled = true })
      await provider.waitForRequest()
      if (scenario === 'terminal') {
        provider.release()
        await turn
      }
      report.promptSettledBeforeInterject = promptSettled
      report.interjectResponse = await acp.request('_x.ai/interject', { sessionId, text: marker })
      report.promptSettledAtAcknowledgement = promptSettled
      if (scenario !== 'terminal') provider.release()
      if (!report.interjectResponse.error) {
        const next = await provider.waitForRequest()
        report.nextRequestContainsMarker = JSON.stringify(next).includes(marker)
        report.promptSettledBeforeNextRequest = promptSettled
        provider.release()
      }
      report.originalTurnResponse = await turn
    }
    report.observationCompleted = true
  } catch (error) {
    report.blocker = error.message
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((done) => child.once('exit', done))
      child.kill('SIGKILL')
      await deadline(exited, 'child teardown', 3000)
    }
    await provider?.close()
    await rm(root, { recursive: true, force: true })
    // 产物只含隔离探针的通信；再清除临时路径与假 Key，禁止保存请求认证头。
    const sanitized = JSON.stringify(report, (key, value) => key === 'hostname' ? '<hostname>' : value, 2)
      .replaceAll(root, '<isolated>')
      .replaceAll(FAKE_KEY, '<fake-key>')
    if (output) {
      await mkdir(resolve(output, '..'), { recursive: true })
      await writeFile(output, `${sanitized}\n`, { mode: 0o600 })
    }
    Object.assign(report, JSON.parse(sanitized))
  }
  return report
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const option = (name) => args[args.indexOf(name) + 1]
  const binary = args.includes('--binary') ? option('--binary') : undefined
  if (!binary) throw new Error('--binary must name the reviewed Grok 1.0.34 executable')
  const report = await observeGrokInterjection({
    binary,
    scenario: args.includes('--scenario') ? option('--scenario') : 'schema',
    output: args.includes('--output') ? option('--output') : undefined
  })
  console.log(JSON.stringify(report, null, 2))
  process.exitCode = report.blocker ? 1 : 0
}
