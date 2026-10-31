// 离线冒烟:不装插件也能验证 lib/ 里的抓取、账本、封面下载是不是好的。
//
// 用法: node feed-scroll/tools/smoke.mjs [--sources bilibili-hot,zhihu-hot,...] [--cover]
//   --sources  只测指定源(默认测全部;每个源抓 3 条)
//   --cover    额外测一次封面下载(落到临时目录,不碰 QQ 媒体目录)
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SOURCE_IDS, SOURCES, describeItem, scroll } from '../lib/sources.js'
import { prepareCover } from '../lib/card.js'
import {
  bumpTaste, emptyState, findItem, loadState, markSeen, markShared, pruneState,
  registerTarget, rememberItems, saveState, wasShared,
} from '../lib/store.js'
import { keywordsOf } from '../lib/text.js'

const args = process.argv.slice(2)
const argOf = (name, def) => {
  const i = args.indexOf('--' + name)
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def
}
const only = argOf('sources', '').split(',').map((s) => s.trim()).filter(Boolean)
const ids = only.length ? only : SOURCE_IDS
let failed = 0

console.log(`== 内容源(${ids.length} 个)==`)
for (const id of ids) {
  const impl = SOURCES[id]
  if (!impl) {
    console.log(`[${id}] 未知源`)
    failed++
    continue
  }
  const started = Date.now()
  try {
    const items = await impl.fetch({ count: 3, query: argOf('query', '深度学习'), sort: 'totalrank' })
    console.log(`[${id}] ${impl.label} → ${items.length} 条 (${Date.now() - started}ms)`)
    for (const item of items.slice(0, 2)) console.log('   ' + describeItem(item, 0).split('\n')[0].slice(0, 120))
    if (items.length === 0) failed++
  } catch (error) {
    console.log(`[${id}] 失败: ${error.message}`)
    failed++
  }
}

console.log('\n== auto 混刷 + 兴趣加权 ==')
const state = emptyState()
bumpTaste(state, ['游戏', '独立游戏', 'ai'], 3)
const auto = await scroll({ source: 'auto', count: 5, taste: state.taste, seen: new Set() })
console.log(`auto → ${auto.items.length} 条,源: ${auto.sources.join(' + ')}`)
for (const [i, item] of auto.items.entries()) console.log(describeItem(item, i))
if (auto.notes.length) console.log('notes:', auto.notes.join('; '))

console.log('\n== 账本 ==')
const dir = mkdtempSync(join(tmpdir(), 'feed-scroll-smoke-'))
const first = auto.items[0]
if (first) {
  markSeen(state, auto.items.map((i) => i.id))
  rememberItems(state, auto.items)
  markShared(state, first, { comment: '冒烟测试', keywords: keywordsOf(first) })
  saveState(dir, pruneState(state))
  const reloaded = loadState(dir)
  const found = findItem(reloaded, first.id)
  console.log(`重新载入: seen=${Object.keys(reloaded.seen).length} recent=${Object.keys(reloaded.recent).length} shared=${reloaded.shared.length}`)
  console.log(`按 id 找回: ${found ? found.title.slice(0, 40) : '失败'}`)
  console.log(`wasShared: ${wasShared(reloaded, first.id)}`)
  console.log(`兴趣画像前 8 个: ${Object.entries(reloaded.taste).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k}:${v}`).join(' ')}`)
  if (!found) failed++
}
registerTarget(state, 'smoke-session', '冒烟')
console.log(`登记会话后 targets=${Object.keys(state.targets).length}`)

if (args.includes('--cover')) {
  console.log('\n== 封面下载 ==')
  const coverDir = mkdtempSync(join(tmpdir(), 'feed-scroll-cover-'))
  const withCover = auto.items.find((i) => i.cover) ?? auto.items[0]
  const cover = await prepareCover(withCover, { mediaDir: coverDir })
  console.log(`普通封面: ${JSON.stringify(cover)?.slice(0, 200)}`)
  if (!cover?.path && !cover?.url) failed++

  // 知乎封面是 webp —— 要么被转成 jpg/png,要么退回直链交给 qqbot 的转换逻辑
  try {
    const zhihu = await SOURCES['zhihu-hot'].fetch({ count: 3 })
    const webpItem = zhihu.find((i) => /\.webp/i.test(i.cover ?? ''))
    if (webpItem) {
      const webpCover = await prepareCover(webpItem, { mediaDir: coverDir })
      const ok = (webpCover?.path && /\.(jpg|png)$/.test(webpCover.path)) || Boolean(webpCover?.url)
      console.log(`webp 封面: ${JSON.stringify(webpCover)?.slice(0, 200)} → ${ok ? 'OK(已转或退回直链)' : 'FAIL'}`)
      if (!ok) failed++
    } else {
      console.log('webp 封面: 这次没抓到 webp 封面,跳过')
    }
  } catch (error) {
    console.log('webp 封面: 抓知乎失败 ' + error.message)
  }
  rmSync(coverDir, { recursive: true, force: true })
}

rmSync(dir, { recursive: true, force: true })
console.log(failed === 0 ? '\n全部通过 ✅' : `\n有 ${failed} 项失败 ❌`)
process.exit(failed === 0 ? 0 : 1)
