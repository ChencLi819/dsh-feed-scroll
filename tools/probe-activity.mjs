// 临时排查脚本:看看定时刷有没有真的叫醒过会话、有没有用过 feed_read
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { zstdDecompressSync } from 'node:zlib'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
function decode(buf) {
  const offsets = []
  for (let i = 0; i + 4 <= buf.length; i++) if (buf.compare(MAGIC, 0, 4, i, i + 4) === 0) offsets.push(i)
  const parts = []
  for (let k = 0; k < offsets.length; k++) {
    const end = k + 1 < offsets.length ? offsets[k + 1] : buf.length
    try { parts.push(zstdDecompressSync(buf.subarray(offsets[k], end))) } catch { /* 跳过坏帧 */ }
  }
  return Buffer.concat(parts).toString('utf8')
}

const root = join(homedir(), '.dsh', 'sessions')
for (const dir of readdirSync(root)) {
  const sub = join(root, dir)
  if (!statSync(sub).isDirectory()) continue
  for (const id of readdirSync(sub)) {
    const file = join(sub, id, 'session.v4.jsonl.zstd')
    if (!existsSync(file)) continue
    let text = ''
    try { text = decode(readFileSync(file)) } catch { continue }
    // 只数真正的工具调用事件(工具表里也会出现工具名,别混进来)
    const calls = {}
    for (const m of text.matchAll(/\{"type":"tool\/call","data":\{"callId":"[^"]*","name":"(feed_[a-z]+)"/g)) {
      calls[m[1]] = (calls[m[1]] ?? 0) + 1
    }
    const wakes = (text.match(/（到点刷帖了）/g) ?? []).length
    if (wakes || Object.keys(calls).length) {
      const summary = Object.entries(calls).map(([k, v]) => `${k.replace('feed_', '')}×${v}`).join(' ')
      console.log(`${id.slice(0, 8)}  定时叫醒 ${wakes} · ${summary || '(没调用)'}`)
    }
  }
}

// 账本里的叫醒记录
const state = JSON.parse(readFileSync(join(homedir(), '.dsh', 'feed-scroll', 'state.json'), 'utf8'))
console.log('\n账本 targets:')
for (const [id, t] of Object.entries(state.targets ?? {})) {
  const fmt = (ms) => (ms ? new Date(ms).toLocaleString('zh-CN', { hour12: false }) : '—')
  console.log(`  ${id.slice(0, 8)}  上次叫醒 ${fmt(t.lastWakeAt)} · 今天 ${t.dayCount} 次(${t.dayKey}) · 错过 ${fmt(t.lastMissedAt)}${t.lastError ? ' · 原因: ' + t.lastError : ''} · ${t.watch?.enabled ? '开着' : '暂停'} ${t.watch?.source}`)
}
console.log('\n分享过:', (state.shared ?? []).length, '条 | 兴趣画像词:', Object.keys(state.taste ?? {}).length)
