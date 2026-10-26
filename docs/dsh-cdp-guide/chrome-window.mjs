#!/usr/bin/env node
/**
 * chrome-window.mjs — 真实改变 Chromium 浏览器窗口大小 / 状态。
 *
 * dsh-cdp 插件的 `cmd=resize` 只做视口模拟（Emulation.setDeviceMetricsOverride），
 * 不改窗口。真窗口要用 Browser.setWindowBounds，插件没暴露，所以单独提供这个脚本。
 *
 * 用法（用 DSH 自带 Node 跑）：
 *   NODE="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node"
 *   "$NODE" chrome-window.mjs get                  # 读当前窗口
 *   "$NODE" chrome-window.mjs set 1200 800         # 设为 1200x800
 *   "$NODE" chrome-window.mjs maximize
 *   "$NODE" chrome-window.mjs fullscreen
 *   "$NODE" chrome-window.mjs normal
 *   "$NODE" chrome-window.mjs minset 1200 800      # 先 normal 再设尺寸
 *
 * 注意：这会真实改变用户的窗口，属侵入性操作。执行前确认，用完恢复。
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 浏览器 profile 目录，按顺序找第一个存在 DevToolsActivePort 的。 */
const CANDIDATES = [
  ['chrome', join(homedir(), 'Library/Application Support/Google/Chrome')],
  ['chrome-beta', join(homedir(), 'Library/Application Support/Google/Chrome Beta')],
  ['chrome-dev', join(homedir(), 'Library/Application Support/Google/Chrome Dev')],
  ['chrome-canary', join(homedir(), 'Library/Application Support/Google/Chrome Canary')],
  ['edge', join(homedir(), 'Library/Application Support/Microsoft Edge')],
  ['brave', join(homedir(), 'Library/Application Support/BraveSoftware/Brave-Browser')],
  ['vivaldi', join(homedir(), 'Library/Application Support/Vivaldi')],
  ['opera', join(homedir(), 'Library/Application Support/com.operasoftware.Opera')],
  ['chromium', join(homedir(), 'Library/Application Support/Chromium')],
  ['arc', join(homedir(), 'Library/Application Support/Arc/User Data')],
]

function findEndpoint() {
  for (const [id, dir] of CANDIDATES) {
    try {
      // 第一行是端口，第二行是浏览器级 WebSocket 路径。
      const [port, path] = readFileSync(join(dir, 'DevToolsActivePort'), 'utf8').trim().split('\n')
      if (!port || !path) continue
      return { id, wsUrl: `ws://127.0.0.1:${port}${path}` }
    } catch {
      // 没有端口文件：浏览器没开调试端点，继续试下一个。
    }
  }
  throw new Error(
    'no Chromium browser with a DevToolsActivePort file found.\n' +
      'Enable remote debugging first:\n' +
      '  - open chrome://inspect and allow remote debugging, or\n' +
      '  - launch with --remote-debugging-port=9222 --user-data-dir=/tmp/debug-profile',
  )
}

/** 极简 CDP 客户端：一个 WebSocket，按 id 配平请求与响应。 */
async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl)
  let seq = 0
  const pending = new Map()

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data)
    const slot = msg.id && pending.get(msg.id)
    if (!slot) return
    pending.delete(msg.id)
    if (msg.error) slot.reject(new Error(`${slot.method}: ${msg.error.message}`))
    else slot.resolve(msg.result)
  }

  await new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = () => reject(new Error(`cannot connect to ${wsUrl}`))
  })

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const n = ++seq
      pending.set(n, { resolve, reject, method })
      ws.send(JSON.stringify({ id: n, method, params }))
    })

  return { send, close: () => ws.close() }
}

const [command = 'get', argW, argH] = process.argv.slice(2)

const KNOWN = new Set(['get', 'set', 'minset', 'maximize', 'fullscreen', 'normal'])
/**
 * 参数先校验，再连浏览器。
 *
 * 原来把校验放在连接之后，一个拼错的分支会先抛「连不上浏览器」——把用户
 * 引向排查权限/端口，而真正的问题只是少写了个命令名。
 */
if (!KNOWN.has(command)) {
  throw new Error(`unknown command "${command}" — use get | set | minset | maximize | fullscreen | normal`)
}

const width = Number(argW)
const height = Number(argH)
if (command === 'set' || command === 'minset') {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`${command} requires positive integer width and height`)
  }
}

const { id, wsUrl } = findEndpoint()
const { send, close } = await connect(wsUrl)

try {
  // 浏览器级 CDP 没有「当前窗口」概念，要拿一个 page target 反查它的窗口。
  const { targetInfos } = await send('Target.getTargets')
  const page = targetInfos.find((t) => t.type === 'page')
  if (!page) throw new Error('no page target — open at least one tab first')

  const { windowId } = await send('Browser.getWindowForTarget', { targetId: page.targetId })

  switch (command) {
    case 'get':
      break

    case 'set':
      await send('Browser.setWindowBounds', { windowId, bounds: { width, height } })
      break

    case 'minset':
      // 最大化/全屏状态下直接改宽高可能不生效，先回到 normal。
      await send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } })
      await send('Browser.setWindowBounds', { windowId, bounds: { width, height } })
      break

    case 'maximize':
    case 'fullscreen':
    case 'normal':
      await send('Browser.setWindowBounds', { windowId, bounds: { windowState: command } })
      break
  }

  // 窗口变化是异步的，稍等一下再读回，避免报出改动前的值。
  await new Promise((r) => setTimeout(r, 400))
  const after = await send('Browser.getWindowForTarget', { targetId: page.targetId })

  console.log(JSON.stringify({ browser: id, windowId, bounds: after.bounds, page: page.url }))
} finally {
  close()
}
