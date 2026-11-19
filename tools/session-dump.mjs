// 把一个 DSH 会话导出成「我们之间的对话」正文——只留 user / assistant 的文字，
// 去掉工具调用、工具结果、reasoning。压缩之前跑一次，原话就还在。
//
// 用法：
//   node session-dump.mjs <sessionId|zstd路径> [输出路径]
// 不带参数：列出会话目录里最大的那个。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

const SESSIONS = path.join(os.homedir(), '.dsh', 'sessions')
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

function decode(file) {
  const buf = fs.readFileSync(file)
  const offs = []
  let i = 0
  while ((i = buf.indexOf(MAGIC, i)) !== -1) { offs.push(i); i += 4 }
  const parts = []
  for (let k = 0; k < offs.length; k++) {
    const start = offs[k]
    const end = k + 1 < offs.length ? offs[k + 1] : buf.length
    try { parts.push(zlib.zstdDecompressSync(buf.subarray(start, end))) } catch {}
  }
  return Buffer.concat(parts).toString('utf8')
}

function findSession(arg) {
  if (arg && fs.existsSync(arg)) return arg
  const all = []
  for (const dir of fs.readdirSync(SESSIONS, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue
    const sub = path.join(SESSIONS, dir.name)
    for (const ent of fs.readdirSync(sub, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue
      const f = path.join(sub, ent.name, 'session.v4.jsonl.zstd')
      if (!fs.existsSync(f)) continue
      if (arg && ent.name === arg) return f
      all.push({ f, size: fs.statSync(f).size, id: ent.name })
    }
  }
  if (arg) throw new Error('找不到会话：' + arg)
  all.sort((a, b) => b.size - a.size)
  return all[0].f
}

const file = findSession(process.argv[2])
const outPath = process.argv[3] || path.join(process.cwd(), 'dumps', path.basename(path.dirname(file)) + '.md')
fs.mkdirSync(path.dirname(outPath), { recursive: true })

const lines = []
let sessionId = ''
let cwd = ''
let kept = 0
for (const line of decode(file).split('\n')) {
  if (!line.trim()) continue
  let ev
  try { ev = JSON.parse(line) } catch { continue }
  if (ev.type === 'session') { sessionId = ev.id || ''; cwd = ev.cwd || ''; continue }
  if (ev.type !== 'user/message' && ev.type !== 'assistant/message') continue
  const msg = ev.data && ev.data.message
  if (!msg || !Array.isArray(msg.content)) continue
  const text = msg.content.filter(c => c.type === 'text').map(c => c.text).join('\n').trim()
  if (!text) continue
  if (text.startsWith('[SCHEDULE REMINDER]')) continue
  const t = new Date(ev.time).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).slice(0, 16)
  lines.push(`## ${t}  ${msg.role === 'user' ? '我（用户）' : '我（agent）'}\n\n${text}\n`)
  kept++
}

const head = `# 会话正文导出\n\n- 会话：${sessionId}\n- 工作目录：${cwd}\n- 源文件：${file}\n- 导出时间：${new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' })}\n- 条数：${kept}（只含 user / assistant 的文字，去掉工具与 reasoning）\n\n---\n\n`
fs.writeFileSync(outPath, head + lines.join('\n'), 'utf8')
console.log(`已导出 ${kept} 条 → ${outPath}`)
