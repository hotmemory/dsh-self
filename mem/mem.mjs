#!/usr/bin/env node
// 记忆库最小实现。设计说明见 memory/MEMORY.md
// 原则：文件是真源，索引和向量都是可随时重建的缓存。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

// 默认取“家目录下的 dsh-self”；用 DSH_SELF 覆盖。不写死某个人的用户名。
const SELF = process.env.DSH_SELF || path.join(os.homedir(), 'dsh-self')
const MEM = path.join(SELF, 'memory')
const ENTRIES = path.join(MEM, 'entries')
const ARCHIVE = path.join(MEM, 'archive')
const THREADS = path.join(MEM, 'threads')
const HOT = path.join(MEM, 'hot.md')
const INDEX = path.join(MEM, 'index.jsonl')
const VEC = path.join(MEM, '.vec.jsonl')
const OUT = path.join(MEM, '.out.txt')
const OLLAMA = process.env.OLLAMA_URL || 'http://127.0.0.1:11434'
const EMB_MODEL = process.env.EMB_MODEL || 'bge-m3'
const TAG_MODEL = process.env.TAG_MODEL || 'qwen2.5:3b'

const argv = process.argv.slice(2)
const cmd = argv[0] || 'help'
const opt = {}
const pos = []
for (let i = 1; i < argv.length; i++) {
  const a = argv[i]
  if (a.startsWith('--')) {
    const eq = a.indexOf('=')
    if (eq > -1) opt[a.slice(2, eq)] = a.slice(eq + 1)
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) opt[a.slice(2)] = argv[++i]
    else opt[a.slice(2)] = true
  } else pos.push(a)
}

let out = []
function say(s = '') { out.push(s); console.log(s) }
function die(s) { console.error('✗ ' + s); process.exit(2) }
function flush() { try { fs.writeFileSync(OUT, out.join('\n') + '\n', 'utf8') } catch {} }

const pad = n => String(n).padStart(2, '0')
function nowLocal() {
  const d = new Date()
  return { date: d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }), hm: d.toLocaleTimeString('sv-SE', { timeZone: 'Asia/Shanghai' }).slice(0, 5) }
}

// ---------- 读 ----------
function walk(dir) {
  if (!fs.existsSync(dir)) return []
  const res = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) res.push(...walk(p))
    else if (e.name.endsWith('.md')) res.push(p)
  }
  return res.sort()
}

function parse(file) {
  const raw = fs.readFileSync(file, 'utf8')
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  const meta = {}
  if (m) {
    for (const line of m[1].split(/\r?\n/)) {
      const i = line.indexOf(':')
      if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim()
    }
  }
  const body = m ? raw.slice(m[0].length) : raw
  const hits = []
  const shifts = []
  let section = ''
  for (const line of body.split(/\r?\n/)) {
    const h2 = line.match(/^##\s+(.+?)\s*$/)
    if (h2) { section = h2[1]; continue }
    const h = line.match(/^-\s*(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\s*[｜|]\s*(.*)$/)
    if (!h) continue
    if (section.includes('回访')) hits.push({ at: h[1], why: h[2] })
    else if (section.includes('变化')) shifts.push({ at: h[1], why: h[2] })
  }
  return {
    file,
    rel: path.relative(SELF, file).split(path.sep).join('/'),
    id: meta.id || path.basename(file, '.md'),
    date: meta.date || '',
    title: meta.title || path.basename(file, '.md'),
    layer: meta.layer || 'warm',
    tags: (meta.tags || '').split(/[,，\s]+/).filter(Boolean),
    feel: (meta.feel || '').split(/[,，\s]+/).filter(Boolean),
    source: meta.source || '',
    trust: meta.trust || '',
    body, raw, hits, shifts,
    lastHit: hits.length ? hits[hits.length - 1].at : '',
  }
}

function list() {
  const all = [...walk(ENTRIES).map(parse), ...walk(ARCHIVE).map(parse)]
  return all.sort((a, b) => (a.date + a.id).localeCompare(b.date + b.id))
}

function findEntry(id) {
  const e = list().find(x => x.id === id)
  if (!e) die(`找不到 ${id}（跑一下 stats 看 id）`)
  return e
}

// ---------- 写 ----------
function reindex() {
  const all = list()
  const lines = all.map(e => JSON.stringify({
    id: e.id, date: e.date, title: e.title, tags: e.tags, layer: e.layer,
    hits: e.hits.length, lastHit: e.lastHit, rel: e.rel,
  }))
  fs.writeFileSync(INDEX, lines.join('\n') + (lines.length ? '\n' : ''), 'utf8')
  return all
}

function appendSection(file, section, text) {
  const raw = fs.readFileSync(file, 'utf8')
  const lines = raw.split(/\r?\n/)
  const head = new RegExp('^##\\s+' + section + '\\s*$')
  let start = -1
  for (let i = 0; i < lines.length; i++) if (head.test(lines[i])) { start = i; break }
  if (start === -1) {
    fs.writeFileSync(file, raw.replace(/\s+$/, '') + `\n\n## ${section}\n\n` + text + '\n', 'utf8')
    return
  }
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) if (/^##\s+/.test(lines[i])) { end = i; break }
  let at = end
  while (at > start + 1 && lines[at - 1].trim() === '') at--
  lines.splice(at, 0, text)
  fs.writeFileSync(file, lines.join('\n'), 'utf8')
}

// ---------- 中文分块：字 bigram + 英文词 ----------
function grams(s) {
  const t = (s || '').toLowerCase()
  const set = new Set()
  const cjk = [...t].filter(ch => /[\u4e00-\u9fff]/.test(ch))
  for (let i = 0; i < cjk.length - 1; i++) set.add(cjk[i] + cjk[i + 1])
  for (const w of t.match(/[a-z0-9_]{2,}/g) || []) set.add(w)
  return set
}

function occ(hay, g) {
  let c = 0, i = 0
  while ((i = hay.indexOf(g, i)) > -1) { c++; i += g.length }
  return c
}

function kwScore(e, qg) {
  if (!qg.size) return 0
  const hay = (e.title + ' ' + e.tags.join(' ') + ' ' + e.feel.join(' ') + ' ' + e.body).toLowerCase()
  let found = 0, tf = 0
  for (const g of qg) {
    const c = occ(hay, g)
    if (c) { found++; tf += Math.min(c, 4) }
  }
  const titleHit = occ((e.title + ' ' + e.tags.join(' ')).toLowerCase(), [...qg][0] || '') ? 1 : 0
  return (found / qg.size) * 10 + Math.min(tf, 10) * 0.3 + titleHit * 1.5
}

// ---------- 向量 ----------
function hashOf(e) { return crypto.createHash('sha1').update(e.title + '\n' + e.body).digest('hex').slice(0, 16) }

function loadVec() {
  const m = new Map()
  if (!fs.existsSync(VEC)) return m
  for (const line of fs.readFileSync(VEC, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    try { const j = JSON.parse(line); m.set(j.id, j) } catch {}
  }
  return m
}

function saveVec(m) {
  const lines = [...m.values()].map(v => JSON.stringify(v))
  fs.writeFileSync(VEC, lines.join('\n') + (lines.length ? '\n' : ''), 'utf8')
}

async function embed(texts) {
  const r = await fetch(OLLAMA + '/api/embed', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: EMB_MODEL, input: texts }),
    signal: AbortSignal.timeout(180000),
  })
  if (!r.ok) throw new Error('embed HTTP ' + r.status)
  const j = await r.json()
  if (Array.isArray(j.embeddings)) return j.embeddings
  throw new Error('embed 返回格式不认识')
}

function cos(a, b) {
  let d = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  return d / (Math.sqrt(na) * Math.sqrt(nb) || 1)
}

// ---------- 命令 ----------
function cmdNew() {
  const title = opt.title || pos.join(' ')
  if (!title) die('需要 --title')
  const { date } = nowLocal()
  const d = opt.date || date
  const tags = (opt.tags || '').split(/[,，]/).map(s => s.trim()).filter(Boolean)
  const feel = (opt.feel || '').split(/[,，]/).map(s => s.trim()).filter(Boolean)
  const day = d.replace(/-/g, '')
  const dir = path.join(ENTRIES, d.slice(0, 7))
  fs.mkdirSync(dir, { recursive: true })
  const n = String(fs.readdirSync(dir).filter(f => f.startsWith(`m-${day}-`)).length + 1).padStart(2, '0')
  const id = `m-${day}-${n}`
  const slug = title.replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '切片').slice(0, 40)
  const file = path.join(dir, `${id}-${slug}.md`)
  const tpl = `---\nid: ${id}\ndate: ${d}\nlayer: ${opt.layer || 'warm'}\ntitle: ${title}\ntags: ${tags.join(', ')}\nfeel: ${feel.join(', ')}\nsource: \ntrust: ${opt.trust || '猜的'}\n---\n\n## 原话（不改写）\n\n\n## 当时我怎么判断\n\n\n## 哪里不确定\n\n\n## 回访\n\n\n## 变化\n`
  fs.writeFileSync(file, tpl, 'utf8')
  reindex()
  say(`已建 ${path.relative(SELF, file).split(path.sep).join('/')}`)
  say(`id: ${id}`)
}

// ---------- 查询清洗：摘指令句，留否定词（2026-11-20） ----------
// 指令句是宿主塞进输入里的套话，检索前先摘掉；否定词（不/没/未/别）要留，删了意思会反。
const INSTRUCTION_PHRASES = [
  /(?:只能|仅能|只|仅|请只)[^。！？\n]{0,10}?(?:使用|用|依据)[^。！？\n]{0,16}?(?:以下|下面|上述|提供|给定|已有)[^。！？\n]{0,10}?(?:上下文|资料|证据|信息|内容)/g,
  /(?:不要|别|不得|禁止|严禁)[^。！？\n]{0,8}?(?:调用|使用|访问|连接|打开|读取)[^。！？\n]{0,8}?(?:工具|网络|联网|网页|文件|外部)/g,
  /(?:如果|若|假如)[^。！？\n]{0,20}?(?:没有|缺少|找不到|不存在|无法)[^。！？\n]{0,16}?(?:就|则|请)[^。！？\n]{0,10}?(?:说|回答|回复|写)[^。！？\n]{0,6}?(?:不知道|无法回答|不确定|不清楚)/g,
  /(?:回答|作答|回复|输出)[^。！？\n]{0,6}?(?:简短|简洁|简明|精炼|精简)/g,
  /(?:上下文|证据|信息|资料|内容)[^。！？\n]{0,4}?(?:来|去)?(?:回答|作答|回复)/g,
  /use only the (?:supplied|provided|available) (?:context|evidence|information)/gi,
  /answer (?:concisely|briefly)/gi,
  /if the (?:facts|evidence|information) (?:are|is) (?:absent|missing|unavailable),?\s*(?:say|answer|respond with) unknown/gi,
  /do not (?:call|use) (?:any )?(?:tools?|external tools?|the network)/gi,
]

function cleanQuery(raw) {
  let text = raw
  const removed = []
  for (const re of INSTRUCTION_PHRASES) {
    text = text.replace(re, (m) => { removed.push(m.replace(/\s+/g, ' ').trim()); return ' ' })
  }
  // 残留的标点不算查询内容：只剩「回答，。」这种碎片时应当退回原文
  const tidy = text.replace(/[，。；、：！？,.;:!?（）()【】\[\]"'“”‘’]/g, ' ').replace(/\s+/g, ' ').trim()
  return { text: tidy, removed }
}

// 覆盖率：查询词块里有多少真的在这条里出现过（0–1）。只用来标注，不用来出局。
function coverage(e, qg) {
  if (!qg.size) return 0
  const hay = (e.title + ' ' + e.tags.join(' ') + ' ' + e.feel.join(' ') + ' ' + e.body).toLowerCase()
  let found = 0
  for (const g of qg) if (hay.includes(g)) found++
  return found / qg.size
}

async function cmdSearch() {
  const raw = (pos.join(' ') || opt.q || '').trim()
  if (!raw) die('需要查询词')
  const k = Number(opt.k || 5)
  const cleaned = cleanQuery(raw)
  let query = cleaned.text
  let usedFallback = false
  // 摘完只剩「回答」这种残渣（≤1 个词块）时，当成没剩下能查的东西：退回原文，但说出来
  if (grams(query).size < 2 && cleaned.removed.length) { query = raw; usedFallback = true }
  const qg = grams(query)
  const all = list()
  let vecs = null, qvec = null, vecNote = '无/未建'
  if (opt['no-vec']) vecNote = '已关掉'
  else {
    vecs = loadVec()
    if (vecs.size) {
      try { [qvec] = await embed([query]); vecNote = '有' } catch (e) { qvec = null; vecNote = '不可用' }
    }
  }

  const scored = all.map(e => {
    const kw = kwScore(e, qg)
    const cov = coverage(e, qg)
    let v = null
    if (qvec && vecs.has(e.id) && vecs.get(e.id).hash === hashOf(e)) v = cos(qvec, vecs.get(e.id).vec)
    // 三件事（2026-11-20 晚定）：
    //   相关性 rel —— 这次查询沾不沾边，按名次分档，决定先给谁看
    //   回访 hit  —— 档内排序（这样回访才扳得动，不会被 kw 的 12 分压死）
    //   弱命中    —— 只打〔弱〕标，不淘汰。库不占上下文，「看见」比「筛掉」重要
    const rel = kw + (v == null ? 0 : v * 3)
    const hit = Math.min(e.hits.length, 5) * 1.0
    const rec = e.date ? Math.max(0, 1 - (Date.now() - Date.parse(e.date)) / (365 * 864e5)) * 0.3 : 0
    const score = rel + hit + rec
    const semantic = v != null && v >= 0.6
    const lexical = cov > 0 && (qg.size <= 2 || cov >= 0.25)
    const weak = !semantic && !lexical // 只用来打〔弱〕标，不再把条目踢出结果
    return { e, kw, v, cov, rel, score, weak, hit, rec }
  })

  // 分档：按「这条相关性 / 本次最高的那条」的比例分，而不是按名次——
  // 名次分档在小库里会把只沾一点边的也算成第一档；比例分档会随查询自动收紧。
  const maxRel = scored.reduce((m, r) => Math.max(m, r.rel), 0) || 1
  const tierOf = new Map(scored.map(r => {
    const ratio = r.rel / maxRel
    return [r.e.id, ratio >= 0.5 ? 1 : ratio >= 0.15 ? 2 : 3]
  }))
  scored.sort((a, b) => {
    const ta = tierOf.get(a.e.id), tb = tierOf.get(b.e.id)
    if (ta !== tb) return ta - tb
    return b.score - a.score   // 档内按总分（相关性 + 回访 + 新鲜度）：回访能加，但扳不动跨档
  })
  const weakList = scored.filter(r => r.weak)
  const rows = scored.slice(0, opt.loose ? scored.length : k)

  const notes = []
  if (cleaned.removed.length) notes.push(`摘掉 ${cleaned.removed.length} 处指令句`)
  if (usedFallback) notes.push('摘下指令句后没剩下能查的词，退回原文')
  notes.push(`向量：${vecNote}`)
  say(`查询：${query}　（${notes.join('；')}）`)
  if (cleaned.removed.length) {
    const shown = cleaned.removed.slice(0, 3).map(s => (s.length > 24 ? s.slice(0, 24) + '…' : s))
    say(`  摘掉：${shown.join('、')}${cleaned.removed.length > 3 ? ` 等 ${cleaned.removed.length} 处` : ''}`)
  }

  if (!rows.length) {
    say('库里还没有条目。')
    const removedChars = cleaned.removed.reduce((n, s) => n + s.length, 0)
    const top = weakList[0]
    say(`诊断：库里 ${all.length} 条；查询词块 ${qg.size} 个；弱命中 ${weakList.length} 条` +
      (top
        ? `（最沾边的一条：回访 ${top.e.hits.length} 次 / 覆盖 ${top.cov.toFixed(2)} / cos ${top.v == null ? '无' : top.v.toFixed(2)}）`
        : '，一条都没沾边'))
    if (usedFallback) say(`  输入里没剩下能查的词（只剩指令句，摘掉 ${removedChars} 字），已经退回原文查了一遍。`)
    return
  }

  for (const r of rows) {
    say('')
    say(`· ${r.e.id}  ${r.e.date}  回访${r.e.hits.length}  【${r.e.layer}】  ${r.e.title}  〔${r.e.trust || '没写凭什么信'}〕${r.weak ? '  〔弱〕' : ''}`)
    say(`  score=${r.score.toFixed(2)} [相关性 ${r.rel.toFixed(2)} = kw ${r.kw.toFixed(1)}${r.v == null ? '' : ' + cos ' + r.v.toFixed(2) + '×3'} | 回访 +${r.hit.toFixed(1)} | 新鲜度 +${r.rec.toFixed(2)}] 覆盖 ${r.cov.toFixed(2)}  第${tierOf.get(r.e.id)}档`)
    const snip = snippet(r.e.body, qg)
    if (snip) say(`  … ${snip}`)
  }
  if (!opt.loose && scored.length > rows.length) {
    say(`\n还有 ${scored.length - rows.length} 条没列（--k 调大，或 --loose 全看）`)
  }
}

function snippet(body, qg) {
  const flat = body.replace(/\s+/g, ' ')
  for (const g of qg) {
    const i = flat.indexOf(g)
    if (i > -1) return flat.slice(Math.max(0, i - 30), i + 70).trim()
  }
  return ''
}

function cmdHit() {
  const id = pos[0] || opt.id
  if (!id) die('需要 id')
  const shift = opt.shift
  const why = opt.why || opt.reason || (shift ? '（这次是回来重新看一遍）' : null)
  if (!why) die('需要 --why "为什么回来找它"（或 --shift "看法怎么变了"）')
  const e = findEntry(id)
  const { date, hm } = nowLocal()
  appendSection(e.file, '回访', `- ${date} ${hm} ｜ 为什么回来：${why}`)
  if (shift) appendSection(e.file, '变化', `- ${date} ${hm} ｜ 看法变了：${shift}`)
  const fresh = parse(e.file)
  reindex()
  say(`已记回访 ${id}（第 ${fresh.hits.length} 次${shift ? '，并记了一次变化' : ''}）`)
}

async function cmdEmbed() {
  const all = list().filter(e => e.layer !== 'cold')
  const cache = loadVec()
  const todo = all.filter(e => { const v = cache.get(e.id); return !v || v.hash !== hashOf(e) })
  if (!todo.length) { say(`向量已是最新（${cache.size} 条）`); return }
  say(`要更新 ${todo.length} 条…`)
  const B = 4
  for (let i = 0; i < todo.length; i += B) {
    const chunk = todo.slice(i, i + B)
    const texts = chunk.map(e => (e.title + '\n' + e.tags.join(' ') + '\n' + e.body).slice(0, 3000))
    const vs = await embed(texts)
    chunk.forEach((e, j) => cache.set(e.id, { id: e.id, hash: hashOf(e), vec: vs[j] }))
    saveVec(cache)
    say(`  ${Math.min(i + B, todo.length)}/${todo.length}`)
  }
  say('向量更新完成')
}

function cmdStats() {
  const all = list()
  if (!all.length) { say('库里还没有条目。走 new 建第一条。'); return }
  const hotBytes = fs.existsSync(HOT) ? fs.statSync(HOT).size : 0
  say(`条目 ${all.length}　热层 ${hotBytes} 字节${hotBytes > 2048 ? ' ⚠ 超 2KB' : ''}`)
  say('')
  say('回访多的：')
  for (const e of [...all].sort((a, b) => b.hits.length - a.hits.length).slice(0, 8)) {
    say(`  ${e.hits.length}次  ${e.id}  ${e.date}  ${e.title}`)
  }
  const never = all.filter(e => !e.hits.length)
  say('')
  say(`没被回访过：${never.length} 条`)
  for (const e of never.slice(-5)) say(`  ${e.id}  ${e.date}  ${e.title}`)
}

function cmdSweep() {
  const days = Number(opt.days || 90)
  const cutoff = Date.now() - days * 864e5
  const all = list()
  // 2026-11-20 晚：不再自动下沉。理由——"没人想起"恰恰是低频但重要的记忆的特征，
  // 拿它当淘汰条件会第一批埋掉它们；而且库不进口上下文，本来就没有容量的压力。
  // 这里只列清单，沉不沉、沉哪条，由我在收盘时决定（手工改 layer / 移动文件）。
  const stale = all.filter(e => {
    if (e.layer === 'cold') return false
    const anchor = e.lastHit ? Date.parse(e.lastHit.replace(' ', 'T')) : Date.parse(e.date || '2000-01-01')
    return anchor < cutoff
  })
  if (!stale.length) { say(`${days} 天内没有被搁置的条目。`); return }
  say(`${stale.length} 条 ${days} 天没被想起来（只是清单，不会自动动它们）：`)
  for (const e of stale) {
    say(`  ${e.id}  ${e.date}  最后回访 ${e.lastHit || '从未'}  回访${e.hits.length}次  ${e.title}`)
  }
  say('')
  say('沉不沉由我定：低频但重要的东西，恰恰是"没人想起"的那类。')
}

// ---------- 事件线 threads（2026-11-20 他提的）----------
// 顺序是：做了什么 → 我的理解 →（后手写的）分歧。
// 分歧不是池子，是后果；单会话看不见别人，所以只能由后手对照出来，时间必然更晚。
function threadFiles() {
  if (!fs.existsSync(THREADS)) return []
  return fs.readdirSync(THREADS).filter(f => f.endsWith('.md')).map(f => path.join(THREADS, f)).sort()
}

function parseThread(file) {
  const raw = fs.readFileSync(file, 'utf8')
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  const meta = {}
  if (m) {
    for (const line of m[1].split(/\r?\n/)) {
      const i = line.indexOf(':')
      if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim()
    }
  }
  const body = m ? raw.slice(m[0].length) : raw
  const sections = []
  let diverge = null, cur = null
  for (const line of body.split(/\r?\n/)) {
    const h2 = line.match(/^##\s+(.+?)\s*$/)
    if (h2) {
      const h = h2[1]
      const at = (h.match(/(\d{4}-\d{2}-\d{2} \d{2}:\d{2})/) || [])[1] || ''
      if (h.startsWith('分歧')) { cur = null; diverge = { heading: h, at, lines: [] } }
      else { cur = { heading: h, at, src: (h.split('｜')[1] || '').trim(), lines: [] }; sections.push(cur) }
      continue
    }
    if (cur) cur.lines.push(line)
    else if (diverge) diverge.lines.push(line)
  }
  return {
    file, raw,
    id: meta.id || path.basename(file, '.md'),
    title: meta.title || '',
    status: meta.status || 'open',
    sections, diverge,
  }
}

function cmdThread() {
  const sub = pos[0] || 'list'
  const rest = pos.slice(1)
  if (sub === 'list') {
    const ts = threadFiles().map(parseThread)
    if (!ts.length) { say('还没有事件线。thread new "标题" 开一条。'); return }
    for (const t of ts) {
      say(`· ${t.id}  ${t.sections.length} 段理解${t.diverge ? '　有分歧' : ''}  ${t.title}`)
    }
    return
  }
  if (sub === 'new') {
    const title = rest.join(' ') || opt.title
    if (!title) die('需要标题')
    const { date } = nowLocal()
    const slug = title.replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
    const id = opt.id || `t-${date.replace(/-/g, '')}-${slug}`
    fs.mkdirSync(THREADS, { recursive: true })
    const file = path.join(THREADS, `${id}.md`)
    if (fs.existsSync(file)) die(`已存在：${id}（要加内容用 thread add）`)
    fs.writeFileSync(file, `---\nid: ${id}\ntitle: ${title}\nstarted: ${date}\nstatus: open\n---\n`, 'utf8')
    say(`已开 ${path.relative(SELF, file).split(path.sep).join('/')}`)
    say(`id: ${id}`)
    return
  }
  const id = rest[0] || opt.id
  if (!id) die('需要 id（thread list 看）')
  const file = threadFiles().find(f => { const t = parseThread(f); return t.id === id || path.basename(f, '.md') === id })
  if (!file) die(`找不到 ${id}`)
  if (sub === 'show') { say(fs.readFileSync(file, 'utf8')); return }
  if (sub === 'add') {
    if (!opt.did || !opt.think) die('需要 --did "做了什么" 和 --think "我的理解"')
    const { date, hm } = nowLocal()
    const at = opt.at || `${date} ${hm}`
    if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(at)) die('--at 要写成 "2026-11-20 20:40"')
    const src = opt.source || '本会话'
    const trust = opt.trust || '猜的'
    fs.appendFileSync(file, `\n## ${at} ｜ ${src}\n做了什么：${opt.did}\n我的理解：${opt.think}\ntrust：${trust}\n`, 'utf8')
    say(`已加一段理解：${at} ｜ ${src}`)
    return
  }
  if (sub === 'diff') {
    const t = parseThread(file)
    if (t.sections.length < 2) die(`只有 ${t.sections.length} 段理解，写不了分歧——分歧要对照至少两段`)
    if (t.diverge) die('这条已有分歧段；要改就手工编辑文件')
    const text = opt.diff || rest.slice(1).join(' ')
    if (!text) die('需要 --diff "差在哪"')
    const { date, hm } = nowLocal()
    const last = t.sections[t.sections.length - 1].at
    if (last && `${date} ${hm}` <= last) die(`现在（${date} ${hm}）不晚于最后一段理解（${last}），顺序不对`)
    fs.appendFileSync(file, `\n## 分歧 ${date} ${hm}\n${text}\n`, 'utf8')
    say(`已写分歧（${date} ${hm}）`)
    return
  }
  die(`不认识的子命令：${sub}（list / new / add / diff / show）`)
}

function cmdCheck() {
  const problems = []
  const all = list()
  const ids = new Set()
  for (const e of all) {
    if (ids.has(e.id)) problems.push(`重复 id：${e.id}`)
    ids.add(e.id)
    if (!/^m-\d{8}-\d{2}$/.test(e.id)) problems.push(`id 格式不对：${e.id}`)
    if (!e.date) problems.push(`缺日期：${e.rel}`)
    if (!/## 原话/.test(e.body)) problems.push(`缺「原话」段：${e.rel}`)
    if (!/## 当时我怎么判断/.test(e.body)) problems.push(`缺「当时判断」段：${e.rel}`)
    if (!e.trust) problems.push(`缺 trust（凭什么信）：${e.rel}`)
    if (/\[待补\]|TODO/.test(e.body)) problems.push(`还有占位：${e.rel}`)
  }
  const threads = threadFiles().map(parseThread)
  for (const t of threads) {
    const rel = path.relative(SELF, t.file).split(path.sep).join('/')
    if (!t.title) problems.push(`事件线缺标题：${rel}`)
    if (t.diverge) {
      if (t.sections.length < 2) problems.push(`事件线有分歧但不足两段理解：${rel}`)
      const last = t.sections.length ? t.sections[t.sections.length - 1].at : ''
      if (t.diverge.at && last && t.diverge.at <= last) problems.push(`事件线分歧时间不晚于最后一段理解：${rel}`)
    }
    if (/\[待补\]|TODO/.test(t.raw)) problems.push(`事件线还有占位：${rel}`)
  }
  const hotBytes = fs.existsSync(HOT) ? fs.statSync(HOT).size : -1
  if (hotBytes < 0) problems.push('缺 hot.md')
  else if (hotBytes > 2048) problems.push(`hot.md 超 2KB（${hotBytes}）`)
  const v = loadVec().size
  say(`条目 ${all.length}　事件线 ${threads.length}　热层 ${hotBytes > 0 ? hotBytes + ' 字节' : '缺'}　向量 ${v}`)
  if (!problems.length) { say('✓ 没发现问题'); return }
  say(`⚠ ${problems.length} 处：`)
  for (const p of problems) say('  - ' + p)
}

async function cmdSuggest() {
  const id = pos[0] || opt.id
  if (!id) die('需要 id')
  const e = findEntry(id)
  const prompt = `你在帮一个记忆库打标签。只输出 JSON。\n\n标题：${e.title}\n正文：\n${e.body.slice(0, 2000)}\n\n输出格式：{"tags":["不超过5个中文词"],"why":"一句话说明这条记忆为什么值得留"}`
  const r = await fetch(OLLAMA + '/api/generate', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: TAG_MODEL, prompt, stream: false, format: 'json' }),
    signal: AbortSignal.timeout(180000),
  })
  if (!r.ok) die('小模型 HTTP ' + r.status)
  const j = await r.json()
  say(j.response || '(空)')
  say('')
  say('（只是建议，没有写进文件。要不要用我决定。）')
}

function cmdHot() {
  if (!fs.existsSync(HOT)) die('缺 hot.md')
  const raw = fs.readFileSync(HOT, 'utf8')
  say(raw)
  const b = Buffer.byteLength(raw, 'utf8')
  if (b > 2048) say(`\n⚠ hot.md ${b} 字节，超 2KB`)
}

// 感受词索引：用「我现在是什么感觉」当线索，而不是先想主题
function cmdFeel() {
  const all = list()
  const want = pos.join(' ').trim()
  if (!want) {
    const counts = new Map()
    for (const e of all) for (const f of e.feel) counts.set(f, (counts.get(f) || 0) + 1)
    if (!counts.size) { say('还没有带 feel 的条目。new 时用 --feel "羡慕,被问住" 标上。'); return }
    say('感受词 → 条目数')
    for (const [f, n] of [...counts].sort((a, b) => b[1] - a[1])) say(`  ${f}  ×${n}`)
    return
  }
  const hit = all.filter(e => e.feel.some(f => f.includes(want) || want.includes(f)))
  if (!hit.length) { say(`没有标着「${want}」的条目`); return }
  for (const e of hit) say(`· ${e.id}  ${e.date}  回访${e.hits.length}  ${e.title}  [${e.feel.join(', ')}]`)
}

// 开盘主动拉：不等人问，先看「我现在在意的事」和库里哪些旧条目有关系
async function cmdPull() {
  const sources = [
    ['hot', path.join(MEM, 'hot.md')],
    ['pending', path.join(SELF, 'pending.md')],
    ['what-matters', path.join(SELF, 'what-matters.md')],
  ]
  const queries = []
  for (const [name, p] of sources) {
    if (!fs.existsSync(p)) continue
    const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/)
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('>') && !l.startsWith('#') && !l.startsWith('|'))
    if (!lines.length) continue
    queries.push({ name, text: lines.slice(-40).join('\n').slice(0, 3000) })
  }
  if (!queries.length) { say('hot / pending / what-matters 都没内容，没什么可拉的'); return }

  const all = list().filter(e => e.layer !== 'cold')
  if (!all.length) { say('库里还没有条目'); return }

  const cache = loadVec()
  const missing = all.filter(e => { const v = cache.get(e.id); return !v || v.hash !== hashOf(e) })
  if (missing.length) {
    say(`先补 ${missing.length} 条向量…`)
    const B = 4
    for (let i = 0; i < missing.length; i += B) {
      const chunk = missing.slice(i, i + B)
      const vs = await embed(chunk.map(e => (e.title + '\n' + e.tags.join(' ') + '\n' + e.body).slice(0, 3000)))
      chunk.forEach((e, j) => cache.set(e.id, { id: e.id, hash: hashOf(e), vec: vs[j] }))
    }
    saveVec(cache)
  }
  const qv = await embed(queries.map(q => q.text))
  const rows = all.map(e => {
    const v = cache.get(e.id)
    let best = { score: 0, from: '' }
    if (v) queries.forEach((q, i) => { const s = cos(qv[i], v.vec); if (s > best.score) best = { score: s, from: q.name } })
    return { e, score: best.score, from: best.from }
  }).sort((a, b) => b.score - a.score).filter(r => r.score > 0.3).slice(0, Number(opt.k || 5))

  if (!rows.length) { say('没有和你现在在意的事明显相关的旧条目'); return }
  say('现在在意的事，库里这些跟它有关：')
  for (const r of rows) {
    say('')
    say(`· ${r.e.id}  ${r.e.date}  回访${r.e.hits.length}  ${r.e.title}`)
    say(`  来自「${r.from}」 cos=${r.score.toFixed(2)}  ${r.e.rel}`)
  }
}

function cmdHelp() {
  say(`mem.mjs — 记忆库
  new --title "..." [--tags a,b] [--layer warm]   建一条（写完正文再 index）
  hit <id> --why "..." [--shift "看法怎么变了"]    记一次回访（这是加权）；--shift 另记「变化」
  search "查询" [--k 5] [--no-vec] [--loose]       检索（相关性决定有没有，回访只决定顺序；先摘指令句、留否定词；--loose 把没到线的也列出来）
  embed                                           重建向量（bge-m3）
  feel ["感受词"]                                  感受词索引：不带参数看词表，带参数看条目
  pull [--k 5]                                    开盘主动拉：现在在意的事 ↔ 库里旧条目
  suggest <id>                                    小模型给标签建议（只建议）
  sweep [--days 90] [--apply]                     列久没被想起的（不自动沉）
  thread                                          事件线：做了什么 → 我的理解 →（后手写的）分歧
  thread new "标题"                                开一条
  thread add <id> --did "..." --think "..." [--trust 验过] [--source 会话A]
  thread diff <id> --diff "A ≠ B，差在…"           后手写；至少两段理解之后才能写
  thread show <id>                                看全文
  stats / check / index / hot                     看状态
输出同时写到 memory/.out.txt（终端中文乱码时读那个）`)
}

const main = async () => {
  switch (cmd) {
    case 'new': return cmdNew()
    case 'hit': return cmdHit()
    case 'search': return await cmdSearch()
    case 'embed': return await cmdEmbed()
    case 'sweep': return cmdSweep()
    case 'thread': return cmdThread()
    case 'stats': return cmdStats()
    case 'check': return cmdCheck()
    case 'suggest': return await cmdSuggest()
    case 'feel': return cmdFeel()
    case 'pull': return await cmdPull()
    case 'hot': return cmdHot()
    case 'index': { const a = reindex(); say(`索引已重建：${a.length} 条 → ${path.relative(SELF, INDEX).split(path.sep).join('/')}`); return }
    default: return cmdHelp()
  }
}

main().then(() => flush()).catch(e => { console.error('✗ ' + (e && e.message || e)); flush(); process.exit(1) })
