// 修会话日志里「缺标识」的消息事件。
//
// 背景:DSH 的消息事件(user/message 等)必须是「带标识的 user 消息」——
// data 里要有 id / role / source / content。少一样,事件照样会被写进
// session.v4.jsonl.zstd,但之后每次 resume 都会在 assertMessageEventShape 上失败:
//   stored session "<id>" failed validation: Error: session event at seq N lacks an identified message
// 会话于是永远叫不回来(agent 没了、日志又读不了),只能重启宿主 —— 2026-10-31 就这么卡了一个群。
//
// 本脚本做的事:把日志里缺 id/role 的消息事件补上(id 用随机 uuid,role 按事件类型),
// 其余内容一字不动;zstd 按原来的帧边界重压(帧与行不对齐时退化成单帧)。
//
// 用法:
//   node feed-scroll/tools/repair-session-log.mjs <session.v4.jsonl.zstd> [--apply]
//   不带 --apply 就是 dry-run,只报告要改哪几条。
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { randomUUID } from 'node:crypto'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const ROLE_BY_TYPE = {
  'system/message': 'system',
  'developer/message': 'developer',
  'user/message': 'user',
  'assistant/message': 'assistant',
  'tool/result': 'tool',
}

/** 按 zstd 魔数切开,逐帧解压 */
function framesOf(buffer) {
  const starts = []
  for (let i = 0; i + 4 <= buffer.length; i++) {
    if (buffer.compare(MAGIC, 0, 4, i, i + 4) === 0) starts.push(i)
  }
  if (starts.length === 0) throw new Error('不是 zstd 文件(找不到魔数)')
  return starts.map((start, index) => {
    const end = index + 1 < starts.length ? starts[index + 1] : buffer.length
    return buffer.subarray(start, end)
  })
}

/** 校验一条事件是否满足 DSH 的形状要求(和 assertMessageEventShape 同规则) */
function problemOf(event) {
  const type = event?.type
  const role = ROLE_BY_TYPE[type]
  if (!role) return null
  const data = event.data
  const message = type === 'user/message' ? data : data?.message
  if (typeof message !== 'object' || message === null) return '缺 message'
  if (typeof message.id !== 'string' || message.id === '') return '缺 id'
  if (message.role !== role) return `role 应为 ${role}(现在是 ${JSON.stringify(message.role)})`
  if (typeof message.source?.kind !== 'string' || message.source.kind === '') return 'source 不合法'
  if (!Array.isArray(message.content)) return 'content 不合法'
  return null
}

/** 给一条事件补上缺的 id / role;返回是否改动 */
function patchEvent(event) {
  const role = ROLE_BY_TYPE[event?.type]
  if (!role) return false
  const message = event.type === 'user/message' ? event.data : event.data?.message
  if (typeof message !== 'object' || message === null) return false
  let changed = false
  if (typeof message.id !== 'string' || message.id === '') {
    message.id = randomUUID()
    changed = true
  }
  if (message.role !== role) {
    message.role = role
    changed = true
  }
  return changed
}

const file = process.argv[2]
const apply = process.argv.includes('--apply')
if (!file || !existsSync(file)) {
  console.error('用法:node repair-session-log.mjs <session.v4.jsonl.zstd> [--apply]')
  process.exit(1)
}

const raw = readFileSync(file)
const frames = framesOf(raw)
const texts = frames.map((frame) => zstdDecompressSync(frame).toString('utf8'))
const whole = texts.join('')
const aligned = texts.every((text, index) => index === texts.length - 1 || text.endsWith('\n'))

let events = 0
let patched = 0
const before = []
const after = []

/** 逐行处理一段文本,返回 [新文本, 改动数] */
function processChunk(chunk) {
  let changes = 0
  const out = chunk.split('\n').map((line) => {
    if (!line.trim()) return line
    let event
    try {
      event = JSON.parse(line)
    } catch {
      console.error('⚠️  有整行解析不了(可能是写入被截断),原样保留:', line.slice(0, 80))
      return line
    }
    events++
    const beforeProblem = problemOf(event)
    if (!beforeProblem) return line
    before.push(`seq=${event.seq ?? '?'} ${event.type} — ${beforeProblem}`)
    if (!patchEvent(event)) return line
    changes++
    const afterProblem = problemOf(event)
    after.push(`seq=${event.seq ?? '?'} ${event.type} — ${afterProblem ? `还是不对:${afterProblem}` : '已补 id/role ✅'}`)
    return JSON.stringify(event)
  })
  return [out.join('\n'), changes]
}

let nextTexts
if (aligned) {
  nextTexts = texts.map((text) => {
    const [next, changes] = processChunk(text)
    patched += changes
    return next
  })
} else {
  console.log('⚠️  zstd 帧和行边界不对齐,整份重写成单帧')
  const [next, changes] = processChunk(whole)
  patched += changes
  nextTexts = [next]
}

console.log(`文件:${file}`)
console.log(`事件 ${events} 条,需要修 ${before.length} 条,已改 ${patched} 条`)
for (const line of before) console.log('  改前:', line)
for (const line of after) console.log('  改后:', line)
const remaining = after.filter((line) => line.includes('还是不对'))
if (remaining.length > 0) {
  console.error('❌ 还有修不好的事件,别写回去,先人工看看')
  process.exit(2)
}

if (!apply) {
  console.log('(dry-run,没写文件;加 --apply 才写)')
  process.exit(0)
}
if (patched === 0) {
  console.log('没有需要改的,不动文件。')
  process.exit(0)
}

const backup = file + '.pre-repair.bak'
if (!existsSync(backup)) copyFileSync(file, backup)
writeFileSync(file, Buffer.concat(nextTexts.map((text) => zstdCompressSync(Buffer.from(text)))))
console.log(`✅ 已写回(备份:${backup})`)
