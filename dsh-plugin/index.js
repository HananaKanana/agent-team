// ateam 的 DeepSeek Harness 插件：让 ateam 在 DSH 里新开一个 worker 会话并发出开场提示词。
//
// 这个接口能开出有完全权限的 agent 会话，所以收得很紧：
// - 只接受本机请求，并且必须带密钥。密钥在插件启动时生成，写进只有本人能读的
//   ~/.dsh/ateam-launch.key（权限 600），ateam 从这个文件读取
// - 不接受任意文字：只能发 ateam 的开场提示词（角色和名字只允许字母、数字、- 和 _），
//   或者一句固定的连通测试
// - 工作目录必须是正在运行 ateam 服务的项目目录（有 .ateam/port）
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync, chmodSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

export const name = 'ateam-launcher'
export const inject = ['webServer', 'sessionController', 'workspaceRegistry']

const ROUTE = '/api/ateam-launch'
const VERSION = 2
const TOKEN = /^[A-Za-z0-9_-]{1,40}$/
const PING_TEXT = '这是 ateam 启动测试。只回复「OK」，不要执行任何命令，然后结束。'

function keyFile() {
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'ateam-launch.key')
}

// 已有密钥就沿用（ateam 可能已经读过），否则新建
function loadKey() {
  const file = keyFile()
  try {
    const key = readFileSync(file, 'utf8').trim()
    if (key.length >= 32) {
      chmodSync(file, 0o600)
      return key
    }
  } catch {}
  const key = randomBytes(32).toString('hex')
  writeFileSync(file, `${key}\n`, { mode: 0o600 })
  return key
}

function sameKey(given, key) {
  const a = Buffer.from(String(given ?? ''))
  const b = Buffer.from(key)
  return a.length === b.length && timingSafeEqual(a, b)
}

function isLoopback(req) {
  const addr = req.socket?.remoteAddress ?? ''
  const host = String(req.headers.host ?? '').replace(/:\d+$/, '').toLowerCase()
  const local = addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
  return local && (host === '127.0.0.1' || host === 'localhost')
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

async function readBody(req, limit = 10_000) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('request body too large')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  return text.trim() ? JSON.parse(text) : {}
}

function ateamProject(cwd) {
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) return null
  const dir = resolve(cwd)
  try {
    if (!statSync(dir).isDirectory() || !existsSync(join(dir, '.ateam', 'port'))) return null
  } catch {
    return null
  }
  return dir
}

function canonical(path) {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

function workspaceFor(ctx, cwd) {
  const want = canonical(cwd)
  return ctx.workspaceRegistry.list().find((w) => typeof w.path === 'string' && canonical(w.path) === want)
}

function promptText(body) {
  if (body.ping === true) return PING_TEXT
  if (!TOKEN.test(String(body.role ?? ''))) return null
  if (body.name !== undefined && !TOKEN.test(String(body.name))) return null
  return `使用 ateam-worker skill，角色 ${body.role}${body.name ? `，名字 ${body.name}` : ''}`
}

export function apply(ctx) {
  const key = loadKey()
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE,
    handler: async (req, res) => {
      try {
        if (!isLoopback(req)) return send(res, 403, { ok: false, message: 'loopback only' })
        if (!sameKey(req.headers['x-ateam-key'], key)) return send(res, 401, { ok: false, message: 'missing or wrong key' })
        if (req.method === 'GET') return send(res, 200, { ok: true, ready: true, version: VERSION })
        if (req.method !== 'POST') return send(res, 405, { ok: false, message: 'POST only' })
        const body = await readBody(req)
        const cwd = ateamProject(body.cwd)
        if (!cwd) return send(res, 400, { ok: false, message: 'cwd must be an absolute path to a directory with a running ateam service (.ateam/port)' })
        const text = promptText(body)
        if (!text) return send(res, 400, { ok: false, message: 'role and name may only contain letters, digits, - and _' })
        // 有对应工作区就挂到工作区下，界面左侧才会把它列在项目名下面；只给目录的会话不归属任何工作区
        const workspace = workspaceFor(ctx, cwd)
        const { sessionId } = await ctx.sessionController.create(workspace ? { workspaceId: workspace.id } : { cwd })
        await ctx.sessionController.prompt(
          { sessionId, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text }] },
          AbortSignal.timeout(30_000),
        )
        send(res, 200, { ok: true, sessionId, workspaceId: workspace?.id ?? null, text })
      } catch (err) {
        ctx.logger?.warn?.(`ateam-launcher: ${err?.message ?? err}`)
        send(res, 500, { ok: false, message: String(err?.message ?? err).slice(0, 500) })
      }
    },
  }), 'ateam-launcher: route')
}
