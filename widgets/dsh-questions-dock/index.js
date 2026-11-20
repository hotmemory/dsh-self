// 宿主半区：读 questions.md，给挂窗一个只读接口 + 一个本机写接口。
// 文件是真源；这个插件只是把它显示出来、并允许从界面上标「答了」。
import fs from 'node:fs'

export const inject = ['webServer']

const FILE = process.env.DSH_QUESTIONS_FILE || require('node:path').join(require('node:os').homedir(), 'dsh-self', 'questions.md')

function readAll() {
  try { return fs.readFileSync(FILE, 'utf8') } catch (err) { return '' }
}

function parse(text) {
  const items = []
  let cur = null
  for (const line of text.split(/\r?\n/)) {
    const h = line.match(/^##\s+(Q-\d+)\s*(.*)$/)
    if (h) {
      cur = { id: h[1], title: h[2].trim(), status: 'open', asked: '', answer: '', note: '' }
      items.push(cur)
      continue
    }
    if (!cur) continue
    const m = line.match(/^-\s*(状态|问于|答|说明)\s*[:：]\s*(.*)$/)
    if (!m) continue
    const v = m[2].trim()
    if (m[1] === '状态') cur.status = v || 'open'
    else if (m[1] === '问于') cur.asked = v
    else if (m[1] === '答') cur.answer = v
    else cur.note = v
  }
  return items
}

function updateItem(id, { status, note }) {
  const lines = readAll().split(/\r?\n/)
  const start = lines.findIndex((l) => new RegExp('^##\\s+' + id + '(\\s|$)').test(l))
  if (start < 0) return false
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) { end = i; break }
  }
  const block = lines.slice(start, end)
  const setLine = (label, value) => {
    const re = new RegExp('^-\\s*' + label + '\\s*[:：]')
    const i = block.findIndex((l) => re.test(l))
    const line = `- ${label}：${value}`
    if (i >= 0) block[i] = line
    else block.push(line)
  }
  setLine('状态', status)
  if (note) setLine(status === 'answered' ? '答' : '说明', String(note).slice(0, 500))
  fs.writeFileSync(FILE, [...lines.slice(0, start), ...block, ...lines.slice(end)].join('\n'), 'utf8')
  return true
}

function json(res, code, body) {
  const s = JSON.stringify(body)
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(s)
}

function readBody(req, limit = 8192) {
  return new Promise((resolve) => {
    let data = ''
    req.on('data', (c) => { data += c; if (data.length > limit) req.destroy() })
    req.on('end', () => resolve(data))
    req.on('error', () => resolve(''))
  })
}

function localOnly(req) {
  const name = String(req.headers.host || '').split(':')[0].replace(/^\[|\]$/g, '')
  return name === '127.0.0.1' || name === 'localhost' || name === '::1'
}

export function apply(ctx) {
  const disposers = []

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-questions/list',
    handler: (req, res) => {
      json(res, 200, { items: parse(readAll()), file: FILE })
    },
  }))

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-questions/update',
    handler: async (req, res) => {
      if (!localOnly(req)) return json(res, 403, { error: 'local only' })
      if (req.method !== 'POST') return json(res, 405, { error: 'POST only' })
      let p = {}
      try { p = JSON.parse(await readBody(req)) } catch (err) {}
      const id = String(p.id || '')
      const status = String(p.status || '')
      if (!/^Q-\d+$/.test(id)) return json(res, 400, { error: 'bad id' })
      if (!['open', 'answered', 'deferred', 'dropped'].includes(status)) return json(res, 400, { error: 'bad status' })
      const ok = updateItem(id, { status, note: p.note ? String(p.note) : '' })
      return json(res, ok ? 200 : 404, { ok, items: parse(readAll()) })
    },
  }))

  ctx.effect(() => () => {
    for (const d of disposers) { try { d() } catch (err) {} }
  })
}
