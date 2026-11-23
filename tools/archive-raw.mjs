// 把 DSH 会话里的**原话**归档到本地仓库（不动库里的条目，单独放）。
//
// 为什么要它：压缩会把原话换成摘要，摘要没写到的就永远没了。
// 这个脚本把 user / assistant 的正文抽出来，落到 memory/raw/，跟压缩无关。
//
// 用法：
//   node tools/archive-raw.mjs                 # 归档所有会话（增量）
//   node tools/archive-raw.mjs --session <id>  # 只归档一个
//   node tools/archive-raw.mjs --list          # 只列出会话，不写
//
// 增量：memory/raw/.state.json 记每个会话已处理的源文件大小；源文件没变大就跳过，
// 变大了只追加新行。可以反复跑。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

const SESSIONS = path.join(os.homedir(), '.dsh', 'sessions')
const SELF = process.env.DSH_SELF || path.join(os.homedir(), 'dsh-self')
const RAW = path.join(SELF, 'memory', 'raw')
const STATE = path.join(RAW, '.state.json')
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

const args = process.argv.slice(2)
const wantSession = args.includes('--session') ? args[args.indexOf('--session') + 1] : ''
const listOnly = args.includes('--list')

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

function sessions() {
  const out = []
  if (!fs.existsSync(SESSIONS)) return out
  for (const dir of fs.readdirSync(SESSIONS, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue
    const sub = path.join(SESSIONS, dir.name)
    for (const ent of fs.readdirSync(sub, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue
      const f = path.join(sub, ent.name, 'session.v4.jsonl.zstd')
      if (!fs.existsSync(f)) continue
      out.push({ id: ent.name, file: f, workspace: dir.name, size: fs.statSync(f).size })
    }
  }
  out.sort((a, b) => a.size - b.size)
  return out
}

function extract(file) {
  const rows = []
  let sessionId = ''
  for (const line of decode(file).split('\n')) {
    if (!line.trim()) continue
    let ev
    try { ev = JSON.parse(line) } catch { continue }
    if (ev.type === 'session') { sessionId = ev.id || sessionId; continue }
    if (ev.type !== 'user/message' && ev.type !== 'assistant/message') continue
    const msg = ev.data && ev.data.message
    if (!msg || !Array.isArray(msg.content)) continue
    const text = msg.content.filter(c => c.type === 'text').map(c => c.text).join('\n').trim()
    if (!text) continue
    if (text.startsWith('[SCHEDULE REMINDER]') || text.startsWith('[SCHEDULE CHANGE]')) continue
    const t = new Date(ev.time).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).slice(0, 16)
    rows.push({ t, who: msg.role === 'user' ? '他' : '我', text })
  }
  return { sessionId, rows }
}

const all = sessions().filter(s => !wantSession || s.id === wantSession)
if (listOnly) {
  for (const s of all) console.log(`${s.id}  ${(s.size / 1024 / 1024).toFixed(1)} MB  ${s.workspace}`)
  console.log(`共 ${all.length} 个会话`)
  process.exit(0)
}

fs.mkdirSync(RAW, { recursive: true })
let state = {}
try { state = JSON.parse(fs.readFileSync(STATE, 'utf8')) } catch {}

let touched = 0
let added = 0
for (const s of all) {
  const prev = state[s.id] || { size: 0, count: 0 }
  if (s.size <= prev.size) continue
  const { sessionId, rows } = extract(s.file)
  if (!rows.length) { state[s.id] = { size: s.size, count: 0 }; continue }

  // 只写新行（rows 按时间顺序，state 里记了已写过多少条）
  const fresh = rows.slice(prev.count)
  if (!fresh.length) { state[s.id] = { size: s.size, count: rows.length }; continue }

  const month = fresh[0].t.slice(0, 7)
  const dir = path.join(RAW, month)
  fs.mkdirSync(dir, { recursive: true })
  const out = path.join(dir, `${sessionId || s.id}.md`)

  let head = ''
  if (!fs.existsSync(out)) {
    head = `# 原话存档 · ${sessionId || s.id}\n\n- 工作区：${s.workspace}\n- 来源：${s.file}\n- 说明：只有 user / assistant 的正文，没有工具调用和推理。压缩改写的是"我看到的"，这里存的是"真发生过的"。\n\n---\n\n`
  }
  const body = fresh.map(r => `## ${r.t} · ${r.who}\n\n${r.text}\n`).join('\n')
  fs.appendFileSync(out, head + body, 'utf8')

  state[s.id] = { size: s.size, count: rows.length, out }
  touched++
  added += fresh.length
}

fs.writeFileSync(STATE, JSON.stringify(state, null, 2), 'utf8')
console.log(`归档 ${touched} 个会话，新增 ${added} 条原话 → ${RAW}`)
