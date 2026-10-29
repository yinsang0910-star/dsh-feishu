/**
 * 用 CDP 驱动 Edge headless，把 DSH 设置页真实渲染出来截图。
 * 不依赖 playwright/puppeteer —— Node 24 自带 WebSocket 和 fetch。
 *
 * 用法：node scripts/shot-settings.mjs <url> <out.png> [点击脚本JS]
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const url = process.argv[2] || 'http://127.0.0.1:8099/'
const out = process.argv[3] || path.join(os.tmpdir(), 'shot.png')
const clickArg = process.argv[4] || ''
const clickJs = clickArg.startsWith('@') ? fs.readFileSync(clickArg.slice(1), 'utf8') : clickArg
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const PORT = 9333
const profileDir = path.join(os.tmpdir(), 'edge-cdp-' + Date.now())

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const edge = spawn(
  EDGE,
  [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profileDir}`,
    '--window-size=1440,1000',
    'about:blank',
  ],
  { stdio: 'ignore', detached: false },
)

let targets = null
for (let i = 0; i < 40; i++) {
  await sleep(400)
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
    const list = await res.json()
    const page = list.find((t) => t.type === 'page')
    if (page?.webSocketDebuggerUrl) {
      targets = page
      break
    }
  } catch {}
}
if (!targets) {
  console.error('CDP 没起来')
  edge.kill()
  process.exit(1)
}

const ws = new WebSocket(targets.webSocketDebuggerUrl)
await new Promise((res, rej) => {
  ws.onopen = res
  ws.onerror = rej
})

let seq = 0
const pending = new Map()
const events = []
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg)
    pending.delete(msg.id)
  } else if (msg.method) {
    events.push(msg.method)
  }
}
const send = (method, params = {}) =>
  new Promise((res) => {
    const id = ++seq
    pending.set(id, res)
    ws.send(JSON.stringify({ id, method, params }))
  })

const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', {
    expression: expr,
    awaitPromise: true,
    returnByValue: true,
  })
  if (r.result?.exceptionDetails) return { error: r.result.exceptionDetails.text }
  return r.result?.result?.value
}

await send('Page.enable')
await send('Runtime.enable')
await send('Log.enable')

// 收集 console 与未捕获异常
const logs = []
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data)
  if (m.method === 'Runtime.consoleAPICalled') {
    logs.push(
      'console.' +
        m.params.type +
        ': ' +
        (m.params.args || []).map((a) => a.value ?? a.description ?? a.type).join(' '),
    )
  }
  if (m.method === 'Runtime.exceptionThrown') {
    logs.push('EXCEPTION: ' + (m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text))
  }
})

await send('Page.navigate', { url })
for (let i = 0; i < 60 && !events.includes('Page.loadEventFired'); i++) await sleep(300)
await sleep(3500)

const before = await evaluate('document.body.innerText.slice(0,600)')
console.log('--- 页面文本（点击前）---')
console.log(typeof before === 'string' ? before : JSON.stringify(before))

if (clickJs) {
  const clicked = await evaluate(clickJs)
  console.log('--- 点击脚本返回 ---')
  console.log(JSON.stringify(clicked))
  await sleep(2500)
  const after = await evaluate('document.body.innerText.slice(0,1500)')
  console.log('--- 页面文本（点击后）---')
  console.log(typeof after === 'string' ? after : JSON.stringify(after))
}

const shot = await send('Page.captureScreenshot', { format: 'png' })
if (shot.result?.data) {
  fs.writeFileSync(out, Buffer.from(shot.result.data, 'base64'))
  console.log(`SCREENSHOT ${out} ${fs.statSync(out).size} bytes`)
} else {
  console.log('截图失败: ' + JSON.stringify(shot).slice(0, 300))
}

console.log('--- console/异常 ---')
console.log(logs.length ? logs.join('\n') : '(无)')

ws.close()
edge.kill()
await sleep(500)
try {
  fs.rmSync(profileDir, { recursive: true, force: true })
} catch {}
