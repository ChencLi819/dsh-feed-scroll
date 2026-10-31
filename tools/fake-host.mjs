// 假宿主自测:不装插件、不重启 DSH,直接给 apply() 一个最小 ctx,
// 把四个工具真跑一遍(含网络抓取、封面下载、账本落盘、定时刷 tick)。
//
// 用法: node feed-scroll/tools/fake-host.mjs [--no-network]
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'

const noNetwork = process.argv.includes('--no-network')
const stateDir = mkdtempSync(join(tmpdir(), 'feed-scroll-state-'))
const mediaDir = mkdtempSync(join(tmpdir(), 'feed-scroll-media-'))
let failed = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? ' — ' + detail : ''}`)
  if (!ok) failed++
}

// ---- 假 ctx ----
const registered = new Map()
const sections = []
const effects = []
const timers = []
const fakeTools = {
  register(def) {
    if (registered.has(def.name)) throw new Error(`duplicate tool ${def.name}`)
    registered.set(def.name, def)
  },
  get(name) {
    return name === 'qqbot_send_file' ? { name } : undefined
  },
}
const fakeAgents = {
  list: () => [],
  get: (id) => (woken.includes(id) ? null : { followup: (payload) => { woken.push(id); followups.push(payload) } }),
}
const woken = []
const followups = []
const makeScope = () => ({
  get: (name) => (name === 'tools' ? fakeTools : name === 'agents' ? fakeAgents : undefined),
  // 真宿主里 ctx.effect(fn) 会立刻执行 fn 并保管它返回的 disposer
  effect: (fn) => { const disposer = fn(); effects.push(typeof disposer === 'function' ? disposer : () => {}) },
  systemPrompt: { section: (section) => { sections.push(section); return () => {} } },
})
const ctx = {
  logger: { info: () => {}, warn: () => {}, error: (...a) => console.log('  [logger.error]', ...a) },
  get: (name) => (name === 'tools' ? fakeTools : undefined),
  inject: (deps, callback) => callback(makeScope()),
  effect: (fn) => { const disposer = fn(); effects.push(typeof disposer === 'function' ? disposer : () => {}) },
}

apply(ctx, {
  stateDir,
  mediaDir,
  proactive: { enabled: true, maxPerDay: 2, minGapMinutes: 0, defaultEveryMinutes: 30, quietFrom: 0, quietTo: 24 },
})

// ---- 1. 注册结果 ----
console.log('== 注册 ==')
for (const name of ['feed_scroll', 'feed_share', 'feed_read', 'grab_image', 'feed_history', 'feed_watch']) {
  const def = registered.get(name)
  check(`工具 ${name} 已注册`, Boolean(def), def ? `参数: ${Object.keys(def.parameters.properties).join(',')}` : '')
  if (def) {
    const required = def.parameters.required ?? []
    check(`  ${name} 的 output.render 可用`, typeof def.output?.render === 'function')
    check(`  ${name} 的 schema 是 object`, def.parameters.type === 'object')
    check(`  ${name} 的 required 都在 properties 里`, required.every((k) => k in def.parameters.properties))
  }
}
check('提示词段已注入', sections.length === 1 && sections[0].name === 'feed-scroll:scroll', sections[0]?.text?.slice(0, 24))
check('effect 已登记(定时器可清理)', effects.length >= 2, `${effects.length} 个`)

// ---- 2. 工具调用 ----
// QQ 会话:最后一条用户消息没有 rpcId;Web 会话:带 rpcId(和 dsh-meme 的判据一致)
const qqSession = { id: 'sess-1', snapshotEvents: () => [{ type: 'user/message', data: { source: { kind: 'user' } } }] }
const webSession = {
  id: 'sess-web',
  snapshotEvents: () => [{ type: 'user/message', data: { source: { kind: 'user', rpcId: '5b546b99-bebb-43c3-9613-5ab11370d82d' } } }],
}
const run = async (name, args, session = qqSession) => {
  const def = registered.get(name)
  const value = await def.execute(args, { agent: { id: session.id, session }, ...{} })
  const rendered = def.output.render(args, value)
  return { value, text: rendered.map((b) => b.text).join('\n') }
}

console.log('\n== feed_scroll ==')
let scrollText = ''
if (noNetwork) {
  console.log('(跳过:--no-network)')
} else {
  const { value, text } = await run('feed_scroll', { source: 'bilibili-hot', count: 4 })
  scrollText = text
  check('返回了内容', /刷到 \d+ 条/.test(text), text.split('\n')[0])
  const ids = [...text.matchAll(/\[(bilibili:[^\]]+)\]/g)].map((m) => m[1])
  check('渲染里有可用的 id', ids.length > 0, ids.slice(0, 2).join(' '))

  console.log('\n== feed_scroll(第二次,应跳过刷过的)==')
  const second = await run('feed_scroll', { source: 'bilibili-hot', count: 4 })
  check('第二次不重复同一条', !ids.some((id) => second.text.includes(`[${id}]`)), second.text.split('\n')[0])

  console.log('\n== feed_share ==')
  const first = ids[0]
  const share = await run('feed_share', { id: first, comment: '看着有点意思' })
  check('找到了条目', !share.text.includes('账本里找不到'), share.text.split('\n')[0])
  const pathMatch = /封面图\(本地.*?\):(.+)/.exec(share.text)
  if (pathMatch) {
    const file = pathMatch[1].trim()
    check('封面图已落盘', existsSync(file), file)
    check('封面图在 mediaDir 内', file.startsWith(mediaDir))
  } else {
    check('封面图(本地)已准备', false, share.text.replace(/\n/g, ' | ').slice(0, 200))
  }
  check('提示了后续动作', share.text.includes('qqbot_send_file'))

  console.log('\n== feed_history ==')
  const history = await run('feed_history', {})
  check('历史里有刚分享的那条', history.text.includes('分享过 1 条'), history.text.split('\n')[0])
  check('历史里有兴趣画像', history.text.includes('兴趣画像'))

  console.log('\n== 直接分享一条链接(不在账本里的)==')
  const biliUrl = 'https://www.bilibili.com/video/BV1JYsd6sE4k'
  const urlShare = await run('feed_share', { id: biliUrl, comment: '别人丢过来的' })
  check('B站链接能解析成条目', !urlShare.text.includes('没解析出来') && urlShare.text.includes('B站'), urlShare.text.split('\n')[0])
  check('B站链接也拿到了封面', /封面图\(本地.*?\):/.test(urlShare.text))
  const pageShare = await run('feed_share', { id: 'https://sspai.com/post/117867', comment: '少数派的文章' })
  check('普通网页走 og 解析', !pageShare.text.includes('没解析出来'), pageShare.text.split('\n')[0])
  const badShare = await run('feed_share', { id: 'https://example.com/definitely-not-a-post' })
  check('解析不了时不抛错、给可自纠的提示', badShare.text.includes('没解析出来') || badShare.text.includes('账本里找不到'))

  console.log('\n== feed_read(B站:简介/热评/关键帧)==')
  const read = await run('feed_read', { id: first })
  check('读到视频信息', read.text.includes('【视频信息】'), read.text.split('\n').slice(0, 2).join(' / '))
  check('读到热评', read.text.includes('【热评】'))
  check('拿到关键帧图', /【关键帧图/.test(read.text), (read.text.match(/图片:(.+)/) ?? [])[1]?.slice(0, 70))
  check('提示了怎么「看画面」', read.text.includes('qqbot_describe_image'))

  console.log('\n== feed_read(论坛正文)==')
  const sspaiRead = await run('feed_read', { id: 'https://sspai.com/post/117867', parts: 'text' })
  check('少数派正文读到了', sspaiRead.text.includes('【正文】') && sspaiRead.text.length > 300, `长度 ${sspaiRead.text.length}`)
  const juejinRead = await run('feed_read', { id: 'https://juejin.cn/post/7637856870833635343', parts: 'text' })
  check('掘金正文读到了', juejinRead.text.includes('【正文】') && juejinRead.text.length > 300, `长度 ${juejinRead.text.length}`)
  const ithomeRead = await run('feed_read', { id: 'https://www.ithome.com/0/891/593.htm', parts: 'text' })
  check('IT之家正文读到了', ithomeRead.text.includes('【正文】') && ithomeRead.text.length > 200, `长度 ${ithomeRead.text.length}`)
  const hnRead = await run('feed_read', { id: 'https://news.ycombinator.com/item?id=50301462', parts: 'text,comments' })
  check('HN 读到了(外链帖会说明正文在原文)', hnRead.text.includes('原文页面') || hnRead.text.includes('【正文】'), hnRead.text.split('\n').slice(0, 3).join(' / '))
  const zhihuRead = await run('feed_read', { id: 'https://www.zhihu.com/question/2099547313488269600', parts: 'text' })
  check('知乎如实说读不到', zhihuRead.text.includes('403') || zhihuRead.text.includes('读不到正文'), zhihuRead.text.split('\n').slice(-2).join(' / '))

  console.log('\n== Web 会话不该被登记成主动推目标 ==')
  await run('feed_scroll', { source: 'bilibili-hot', count: 2 }, webSession)
  const { loadState: load1 } = await import('../lib/store.js')
  const stateWeb = load1(stateDir)
  check('Web 会话不在 targets 里', !stateWeb.targets['sess-web'], Object.keys(stateWeb.targets).join(','))
  check('QQ 会话已在 targets 里', Boolean(stateWeb.targets['sess-1']))
}

console.log('\n== feed_watch ==')
const watch = await run('feed_watch', { action: 'add', every_minutes: 45 })
check('登记成功(QQ 会话)', watch.text.includes('定时刷已开启'), watch.text.split('\n')[0])
const stateFile = join(stateDir, 'state.json')
const state = JSON.parse(readFileSync(stateFile, 'utf8'))
check('账本写进了 state.json', Boolean(state.targets['sess-1']), JSON.stringify(state.targets['sess-1']?.watch))
check('间隔被记成 45 分钟', state.targets['sess-1']?.watch?.everyMinutes === 45)

// 定时刷 tick:会话还活着 → 叫醒;间隔没到 → 不叫;会话不在 → 记 missed 不报错
const { runWatchTick } = await import('../index.js')
const { loadState, saveState } = await import('../lib/store.js')
const settings = { proactive: { enabled: true, quietFrom: 0, quietTo: 24, maxPerDay: 2, minGapMinutes: 0, defaultEveryMinutes: 30 } }
const commit = (s) => saveState(stateDir, s)
const liveAgents = { get: () => ({ followup: (p) => followups.push(p) }) }
await runWatchTick(liveAgents, { settings, stateDir, log: () => {}, commit })
check('tick 叫醒了会话', followups.length === 1, followups[0]?.content?.[0]?.text?.slice(0, 40))
const afterTick = loadState(stateDir)
check('tick 记了 lastWakeAt / dayCount', afterTick.targets['sess-1'].dayCount === 1, `dayCount=${afterTick.targets['sess-1'].dayCount}`)
await runWatchTick(liveAgents, { settings, stateDir, log: () => {}, commit })
check('间隔没到就不再叫(45 分钟 > 0)', followups.length === 1, `followups=${followups.length}`)

// 把 lastWakeAt 归零,再模拟「会话已被 dsh-qqbot 回收」
const stateForMiss = loadState(stateDir)
stateForMiss.targets['sess-1'].lastWakeAt = 0
saveState(stateDir, stateForMiss)
await runWatchTick({ get: () => null }, { settings, stateDir, log: () => {}, commit })
const missed = loadState(stateDir)
check('会话不在时记 missed 而不抛错', Boolean(missed.targets['sess-1'].lastMissedAt))

// 打了 qqbot-sessions 服务补丁时:manager.getOrCreate() 能把会话叫回来
const stateForRestore = loadState(stateDir)
stateForRestore.targets['sess-1'].lastWakeAt = 0
stateForRestore.targets['sess-1'].peer = { scope: 'group', peerId: 'G-1', senderId: 'U-1', replyTarget: { scope: 'group', targetId: 'G-1' } }
saveState(stateDir, stateForRestore)
const restored = []
const beforeRestore = followups.length
await runWatchTick(
  { get: () => null },
  {
    settings,
    stateDir,
    log: () => {},
    commit,
    restore: async (target) => {
      restored.push(target.sessionId)
      if (!target.peer?.peerId) return null
      return { followup: (p) => followups.push(p) }
    },
  },
)
check('会话被回收后能用 manager 叫回来', followups.length === beforeRestore + 1 && restored.length === 1, `restore 调用 ${restored.length} 次`)
const afterRestore = loadState(stateDir)
check('叫回来之后记的是 wake 不是 missed', afterRestore.targets['sess-1'].dayCount >= 1, `dayCount=${afterRestore.targets['sess-1'].dayCount}`)

// 没有 peer 信息(老账本)时,restore 拿不到东西,还是记 missed
const stateNoPeer = loadState(stateDir)
delete stateNoPeer.targets['sess-1'].peer
stateNoPeer.targets['sess-1'].lastWakeAt = 0
stateNoPeer.targets['sess-1'].lastMissedAt = 0
stateNoPeer.targets['sess-1'].dayCount = 0 // 别撞上 maxPerDay,这里要测的是「叫不醒」
saveState(stateDir, stateNoPeer)
await runWatchTick({ get: () => null }, { settings, stateDir, log: () => {}, commit, restore: async (t) => (t.peer?.peerId ? { followup: () => {} } : null) })
check('没有 peer 信息时如实记 missed', Boolean(loadState(stateDir).targets['sess-1'].lastMissedAt))

// 每天最多叫醒 maxPerDay 次
const stateForCap = loadState(stateDir)
stateForCap.targets['sess-1'].dayCount = settings.proactive.maxPerDay
stateForCap.targets['sess-1'].lastWakeAt = 0
saveState(stateDir, stateForCap)
const before = followups.length
await runWatchTick(liveAgents, { settings, stateDir, log: () => {}, commit })
check('到每日上限后不再叫', followups.length === before, `followups=${followups.length}`)

console.log('\n== 暂停 / 列表 ==')
const paused = await run('feed_watch', { action: 'pause' })
check('pause 生效', paused.text.includes('已暂停'))
const listed = await run('feed_watch', { action: 'list' })
check('list 能看到登记的会话', listed.text.includes('sess-1'), listed.text.split('\n').filter(Boolean).pop())

// ---- grab_image:网图直链 → 本地可发文件 ----
console.log('\n== grab_image ==')
{
  const { createServer } = await import('node:http')
  const { loadSharp } = await import('../lib/card.js')
  const sharp = await loadSharp()
  if (!sharp) {
    check('sharp 可用(缩图/转码)', false, 'profile 里找不到 sharp')
  } else {
    const big = await sharp({ create: { width: 900, height: 600, channels: 3, background: { r: 30, g: 90, b: 180 } } }).png().toBuffer()
    const server = createServer((req, res) => {
      if (req.url === '/meme.png') { res.writeHead(200, { 'content-type': 'image/png' }); res.end(big); return }
      res.writeHead(404); res.end('nope')
    })
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    const base = `http://127.0.0.1:${server.address().port}`
    try {
      const grabbed = await run('grab_image', { url: `${base}/meme.png`, edge: 300 })
      const line = grabbed.text.split('\n').find((l) => l.includes('抓到本地了')) ?? ''
      const path = line.replace('抓到本地了:', '').trim()
      check('返回了本地路径', path.startsWith(mediaDir) && existsSync(path), path)
      check('提示了交给 qqbot_send_file', grabbed.text.includes('qqbot_send_file'))
      check('路径确实落在白名单媒体目录', path.startsWith(mediaDir))
      const meta = await sharp(path).metadata()
      check('缩到 300 长边', Math.max(meta.width ?? 0, meta.height ?? 0) === 300, `${meta.width}×${meta.height}`)

      const missing = await run('grab_image', { url: `${base}/nope.png` })
      check('抓不到时如实报错且不抛', missing.text.includes('没抓下来'), missing.text.split('\n')[0].slice(0, 70))
      const webpage = await run('grab_image', { url: 'https://example.com/index.html' })
      check('网页链接被拒', noNetwork || webpage.text.includes('没抓下来'), webpage.text.split('\n')[0].slice(0, 60))
    } finally {
      server.close()
    }
  }
}

// 清理
for (const effect of effects) { try { effect() } catch { /* disposer */ } }
rmSync(stateDir, { recursive: true, force: true })
rmSync(mediaDir, { recursive: true, force: true })

console.log(failed === 0 ? '\n全部通过 ✅' : `\n有 ${failed} 项失败 ❌`)
process.exit(failed === 0 ? 0 : 1)
