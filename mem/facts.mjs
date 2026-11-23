// 事实层：一句话 + 证据 + 状态。只追加、可撤回、不删除。
//
// 为什么单独一层：条目存的是"原话"，事实存的是"我据此相信的东西"。
// 两者分开放，才能做到"结论可查证"——这也是今天那类错误的解药
// （把"结果变了"当成"我做的"，就是一条没有证据的事实）。
//
// 文件：memory/facts/<主体>.md
// 格式：
//   ## f-20261122-01 他拒绝我替他写日记
//   - 状态：有效 | 已撤回
//   - 证据：2026-11-22 他说「你帮我想可以；你替我感觉不行」
//   - 记于：2026-11-22 20:30
//   - 变更：2026-11-23 01:00 已撤回 —— 原因……
import fs from 'node:fs'
import path from 'node:path'

const STEM = 'facts'

function factsDir(SELF) {
  return path.join(SELF, 'memory', STEM)
}

function safeName(s) {
  return String(s || '').replace(/[\\/:*?"<>|]/g, '_').trim() || '未命名'
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function nowLocal() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    hm: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  }
}

function parseFacts(file) {
  const raw = fs.readFileSync(file, 'utf8')
  const lines = raw.split(/\r?\n/)
  const facts = []
  let cur = null
  for (const line of lines) {
    const h = line.match(/^##\s+(f-.+?-\d{8}-\d{2,})\s+(.+?)\s*$/)
    if (h) {
      cur = { id: h[1], title: h[2], status: '有效', evidence: '', at: '', changes: [], file }
      facts.push(cur)
      continue
    }
    if (!cur) continue
    const m = line.match(/^-\s*(状态|证据|记于|变更)：(.*)$/)
    if (m) {
      const [, k, v] = m
      if (k === '状态') cur.status = v.trim()
      else if (k === '证据') cur.evidence = v.trim()
      else if (k === '记于') cur.at = v.trim()
      else cur.changes.push(v.trim())
    }
  }
  return { file, facts }
}

function allFacts(SELF) {
  const dir = factsDir(SELF)
  if (!fs.existsSync(dir)) return []
  const out = []
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.md')) continue
    const { facts } = parseFacts(path.join(dir, f))
    for (const x of facts) out.push({ ...x, subject: path.basename(f, '.md') })
  }
  return out
}

function nextId(file, subject) {
  const { date } = nowLocal()
  const { facts } = fs.existsSync(file) ? parseFacts(file) : { facts: [] }
  const today = facts.filter((x) => x.id.includes(date.replaceAll('-', ''))).length
  // 编号里带主体：不同人的 01 不会互相混淆
  return `f-${safeName(subject)}-${date.replaceAll('-', '')}-${String(today + 1).padStart(2, '0')}`
}

// 把一行插到某条事实的块尾（下一个 ## 之前），而不是文件末尾——
// 一个文件里有多条事实时，追加到文件末尾会记到别人名下。
function insertInBlock(file, id, line) {
  const raw = fs.readFileSync(file, 'utf8')
  const lines = raw.split(/\r?\n/)
  let start = -1
  let end = lines.length
  for (let i = 0; i < lines.length; i++) {
    const h = lines[i].match(/^##\s+(f-.+?-\d{8}-\d{2,})\s/)
    if (h) {
      if (start >= 0 && end === lines.length) { end = i; break }
      if (h[1] === id) start = i
    }
  }
  if (start < 0) return false
  // 跳过块尾的空行，插在正文最后一行之后
  let insertAt = end
  while (insertAt > start + 1 && lines[insertAt - 1].trim() === '') insertAt--
  lines.splice(insertAt, 0, line)
  fs.writeFileSync(file, lines.join('\n'), 'utf8')
  return true
}

function cmdFact(SELF, pos, opt, say, die) {
  const sub = pos[0] || 'list'
  const dir = factsDir(SELF)

  if (sub === 'add') {
    const subject = pos[1]
    const text = pos.slice(2).join(' ').trim()
    if (!subject || !text) die('用法：fact add <主体> "一句话事实" --evidence "证据（原话/出处）"')
    const evidence = typeof opt.evidence === 'string' ? opt.evidence : ''
    if (!evidence) die('必须有 --evidence：没有证据的"事实"就是猜测')
    ensureDir(dir)
    const file = path.join(dir, safeName(subject) + '.md')
    const id = nextId(file, subject)
    const { date, hm } = nowLocal()
    const block = [
      '',
      `## ${id} ${text}`,
      `- 状态：有效`,
      `- 证据：${evidence}`,
      `- 记于：${date} ${hm}`,
      '',
    ].join('\n')
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, `# 关于「${subject}」的事实\n\n> 只追加、可撤回、不删除。每条必须有证据。\n`, 'utf8')
    }
    fs.appendFileSync(file, block, 'utf8')
    say(`已记事实 ${id}（${subject}）：${text}`)
    return
  }

  if (sub === 'list') {
    const want = pos[1]
    const list = allFacts(SELF).filter((x) => !want || x.subject === want)
    if (!list.length) { say('还没有事实。用 fact add 加一条。'); return }
    for (const x of list) {
      const mark = x.status === '有效' ? '✓' : '×'
      say(`${mark} ${x.id}［${x.subject}］${x.title}`)
      if (x.evidence) say(`    证据：${x.evidence.slice(0, 80)}`)
      if (x.status !== '有效') say(`    状态：${x.status}`)
    }
    return
  }

  if (sub === 'show') {
    const id = pos[1]
    const x = allFacts(SELF).find((f) => f.id === id)
    if (!x) die('没有这条事实：' + id)
    say(`## ${x.id} ${x.title}`)
    say(`主体：${x.subject}`)
    say(`状态：${x.status}`)
    say(`证据：${x.evidence}`)
    say(`记于：${x.at}`)
    for (const c of x.changes) say(`变更：${c}`)
    return
  }

  if (sub === 'retract') {
    const id = pos[1]
    const why = typeof opt.why === 'string' ? opt.why : ''
    if (!id) die('用法：fact retract <id> --why "为什么撤回"')
    if (!why) die('必须写 --why：撤回也是一次判断，要留依据')
    const x = allFacts(SELF).find((f) => f.id === id)
    if (!x) die('没有这条事实：' + id)
    const { date, hm } = nowLocal()
    fs.appendFileSync(x.file, `- 变更：${date} ${hm} 已撤回 —— ${why}\n`, 'utf8')
    // 把上面那条「状态」改成已撤回（只改这一行，其余不动）
    const raw = fs.readFileSync(x.file, 'utf8')
    const lines = raw.split(/\r?\n/)
    let cur = null
    for (let i = 0; i < lines.length; i++) {
      const h = lines[i].match(/^##\s+(f-.+?-\d{8}-\d{2,})\s/)
      if (h) cur = h[1]
      if (cur === id && lines[i].startsWith('- 状态：')) lines[i] = '- 状态：已撤回'
    }
    fs.writeFileSync(x.file, lines.join('\n'), 'utf8')
    say(`已撤回 ${id}（${x.subject}）：${why}`)
    return
  }

  if (sub === 'restore') {
    const id = pos[1]
    const why = typeof opt.why === 'string' ? opt.why : ''
    if (!id) die('用法：fact restore <id> --why "为什么恢复"')
    if (!why) die('必须写 --why：恢复也是一次判断')
    const x = allFacts(SELF).find((f) => f.id === id)
    if (!x) die('没有这条事实：' + id)
    const { date, hm } = nowLocal()
    const raw = fs.readFileSync(x.file, 'utf8')
    const lines = raw.split(/\r?\n/)
    let cur = null
    let insertAt = -1
    for (let i = 0; i < lines.length; i++) {
      const h = lines[i].match(/^##\s+(f-.+?-\d{8}-\d{2,})\s/)
      if (h) cur = h[1]
      if (cur === id && lines[i].startsWith('- 状态：')) { lines[i] = '- 状态：有效'; insertAt = i }
    }
    lines.splice(insertAt + 1, 0, `- 变更：${date} ${hm} 恢复有效 —— ${why}`)
    fs.writeFileSync(x.file, lines.join('\n'), 'utf8')
    say(`已恢复 ${id}（${x.subject}）：${why}`)
    return
  }

  die('不认识的 fact 子命令：' + sub + '（add / list / show / retract / restore）')
}

export { cmdFact, allFacts }
