// 把 hot.md 注入系统提示。不依赖代理"想起来去读"。
import fs from 'node:fs'

export const inject = ['systemPrompt']

const DEFAULT_FILE = process.env.DSH_HOT_MEMORY || 'C:\\path\\to\\your\\dsh-self\\memory\\hot.md'
const DEFAULT_MAX = 2400

export function apply(ctx, config) {
  const file = (config && config.file) || DEFAULT_FILE
  const maxBytes = Number((config && config.maxBytes) || DEFAULT_MAX)

  ctx.effect(() => ctx.systemPrompt.section({
    name: 'memory:hot',
    order: 4500,
    interpolate: false,
    text: () => {
      let raw = ''
      try {
        raw = fs.readFileSync(file, 'utf8').trim()
      } catch (err) {
        return ''
      }
      if (!raw) return ''
      if (Buffer.byteLength(raw, 'utf8') > maxBytes) {
        raw = Buffer.from(raw, 'utf8').subarray(0, maxBytes).toString('utf8') + '\n…（截断）'
      }
      return [
        '以下是你自己的记忆指针（hot.md），会话启动时自动注入，不需要再去读这个文件：',
        '',
        raw,
        '',
        '需要细节时：`node mem/mem.mjs search "..."`。不要把这段原样复述给用户。',
      ].join('\n')
    },
  }))
}
