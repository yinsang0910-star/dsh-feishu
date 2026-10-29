// 逐项验证设置页自检/会话发现用到的飞书接口（真实调用，只读 + 一次不上传-不发送的探测）
import fs from 'node:fs'

const appId = fs.readFileSync(process.env.TEMP + '/ff_appid.txt', 'utf8').trim()
const appSecret = fs.readFileSync(process.env.TEMP + '/ff_secret.txt', 'utf8').trim()
const chatId = fs.readFileSync(process.env.TEMP + '/ff_chat.txt', 'utf8').trim()
const ORIGIN = 'https://open.feishu.cn'

const log = (name, ok, extra) => console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`)

const tokRes = await fetch(`${ORIGIN}/open-apis/auth/v3/tenant_access_token/internal`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json; charset=utf-8' },
  body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
})
const tokJson = await tokRes.json()
const token = tokJson.tenant_access_token
log('tenant_access_token', tokJson.code === 0 && !!token, `code=${tokJson.code} expire=${tokJson.expire}`)
if (!token) process.exit(1)
const H = { Authorization: `Bearer ${token}` }

// ① /bot/v3/info —— 结构：bot 在顶层
{
  const r = await fetch(`${ORIGIN}/open-apis/bot/v3/info`, { headers: H })
  const j = await r.json()
  log('bot/v3/info', j.code === 0, `code=${j.code} app_name=${j.bot?.app_name ?? '(none)'} 顶层bot=${'bot' in j}`)
}

// ② /im/v1/chats —— 列会话
let firstChat = null
{
  const r = await fetch(`${ORIGIN}/open-apis/im/v1/chats?page_size=100`, { headers: H })
  const j = await r.json()
  const items = j.data?.items ?? []
  firstChat = items[0]
  log('im/v1/chats', j.code === 0, `code=${j.code} count=${items.length} has_more=${j.data?.has_more}`)
  if (firstChat) {
    console.log(`      sample: chat_id=${firstChat.chat_id} name=${firstChat.name} user_count=${firstChat.user_count} chat_mode=${firstChat.chat_mode} external=${firstChat.external}`)
    const missing = ['chat_id', 'name', 'user_count', 'chat_mode', 'external'].filter((k) => !(k in firstChat))
    if (missing.length) console.log(`      !! 缺字段: ${missing.join(', ')}`)
  }
}

// ③ /im/v1/chats/:id —— 群详情（自检「目标会话」用这个）
{
  const r = await fetch(`${ORIGIN}/open-apis/im/v1/chats/${encodeURIComponent(chatId)}`, { headers: H })
  const j = await r.json()
  log('im/v1/chats/:id', j.code === 0, `code=${j.code} name=${j.data?.name ?? '(none)'}`)
}

// ④ 读一行历史 —— 自检「读聊天记录」，零骚扰
{
  const url = `${ORIGIN}/open-apis/im/v1/messages?container_id_type=chat&container_id=${encodeURIComponent(chatId)}&page_size=1&sort_type=ByCreateTimeDesc`
  const r = await fetch(url, { headers: H })
  const j = await r.json()
  const n = j.data?.items?.length ?? 0
  log('im/v1/messages (read 1)', j.code === 0, `code=${j.code} items=${n} msg=${j.msg ?? ''}`)
}

// ⑤ 上传探测文件 —— multipart 手拼（和 index.ts 里 buildMultipart 同构），上传后不发送
{
  const boundary = `----dshfeishu${Date.now().toString(16)}`
  const body = [
    `--${boundary}\r\nContent-Disposition: form-data; name="file_type"\r\n\r\nstream\r\n`,
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="dsh-feishu-selftest.txt"\r\nContent-Type: text/plain\r\n\r\ndsh-feishu selftest\r\n`,
    `--${boundary}--\r\n`,
  ].join('')
  const r = await fetch(`${ORIGIN}/open-apis/im/v1/files`, {
    method: 'POST',
    headers: { ...H, 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body,
  })
  const j = await r.json()
  log('im/v1/files (upload)', j.code === 0, `code=${j.code} file_key=${(j.data?.file_key ?? '').slice(0, 22)} msg=${j.msg ?? ''}`)
}

// ⑥ /drive/v1/files —— 云空间
{
  const r = await fetch(`${ORIGIN}/open-apis/drive/v1/files?page_size=1`, { headers: H })
  const j = await r.json()
  log('drive/v1/files', j.code === 0, `code=${j.code} files=${j.data?.files?.length ?? 0}`)
}
