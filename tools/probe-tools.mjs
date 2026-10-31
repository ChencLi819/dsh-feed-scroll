// 探针:读会话日志里最新的 request/header,确认 feed-scroll 的工具真的进了模型工具表。
//
// 为什么不用日志:桌面端把宿主子进程的 stdout 收走,插件注册失败在用户侧一点痕迹都没有;
// 而 request/header 是「模型实际看到的工具表」,它才说明插件到底加载没加载。
//
// 用法:
//   node feed-scroll/tools/probe-tools.mjs [会话目录或 session.v4.jsonl.zstd 路径]
//   不带参数 = 自动找 ~/.dsh/sessions 下最近改动过的会话日志
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const SESSION_FILE = 'session.v4.jsonl.zstd'

function findNewestSession(root) {
  let best = null
  // 目录结构是 sessions/<cwd-hash>/<session-id>/session.v4.jsonl.zstd,所以往下走两层
  const walk = (dir, depth) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory() && depth > 0) {
        walk(full, depth - 1)
        continue
      }
      if (entry.name !== SESSION_FILE) continue
      try {
        const stat = statSync(full)
        if (!best || stat.mtimeMs > best.mtimeMs) best = { path: full, mtimeMs: stat.mtimeMs }
      } catch {
        /* 读不到就算了 */
      }
    }
  }
  walk(root, 2)
  return best
}

function resolveTarget() {
  const arg = process.argv[2]
  if (arg) return { path: arg, mtimeMs: 0 }
  const root = join(homedir(), '.dsh', 'sessions')
  const found = findNewestSession(root)
  if (!found) {
    console.error(`在 ${root} 下没找到 ${SESSION_FILE}`)
    process.exit(1)
  }
  return found
}

function decompressAll(buf) {
  const offsets = []
  for (let i = 0; i + 4 <= buf.length; i++) if (buf.compare(MAGIC, 0, 4, i, i + 4) === 0) offsets.push(i)
  const parts = []
  for (let k = 0; k < offsets.length; k++) {
    const end = k + 1 < offsets.length ? offsets[k + 1] : buf.length
    try { parts.push(zstdDecompressSync(buf.subarray(offsets[k], end))) } catch { /* 半截帧跳过 */ }
  }
  return Buffer.concat(parts).toString('utf8')
}

const target = resolveTarget()
console.log(`会话日志: ${target.path}`)

const events = decompressAll(readFileSync(target.path)).split('\n').filter(Boolean)
  .map((line) => { try { return JSON.parse(line) } catch { return null } })
  .filter(Boolean)

const headers = events.filter((event) => event.type === 'request/header')
const last = headers[headers.length - 1]
if (!last) {
  console.log('这个会话里还没有 request/header(先发一条消息再看)')
  process.exit(1)
}

const tools = (last.data?.header?.tools ?? []).map((tool) => tool.name)
const wanted = ['feed_scroll', 'feed_read', 'feed_share', 'grab_image', 'feed_history', 'feed_watch']
console.log(`request/header 事件数: ${headers.length},最新一个的工具数: ${tools.length}`)
for (const name of wanted) {
  const hit = (last.data?.header?.tools ?? []).find((tool) => tool.name === name)
  console.log(`  ${hit ? '✅' : '❌'} ${name}${hit ? `  —  ${String(hit.description ?? '').slice(0, 70)}…` : ''}`)
}

// 提示词段:会话日志里搜标记文本,确认 system prompt 真的带上了「刷帖」那一段
const raw = JSON.stringify(events)
const promptHit = raw.includes('【刷帖——你自己的娱乐】')
console.log(`  ${promptHit ? '✅' : '❌'} 系统提示词里的「刷帖」段${promptHit ? '' : '(日志里没找到;若工具已加载,多半是本会话还没发过请求)'}`)

const missing = wanted.filter((name) => !tools.includes(name))
if (missing.length === 0) {
  console.log('\nfeed-scroll 已加载 ✅')
  process.exit(0)
}
console.log(`\n缺少: ${missing.join(', ')} —— 多半是插件没装/没重载,或注册时抛错了`)
process.exit(2)
