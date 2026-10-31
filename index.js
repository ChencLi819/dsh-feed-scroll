// dsh-feed-scroll —— 让 agent 会「刷」:逛 B站/知乎/掘金/贴吧/HN 的视频和贴文,
// 把感兴趣的分享到群里(封面图 + 一句话 + 链接),闲着的时候还能自己定时刷。
//
// 六个工具:
//   feed_scroll  刷内容(自动跳过刷过的,按兴趣画像加权排序)
//   feed_share   把挑中的一条准备成「可发」的:封面图落到发送白名单目录 + 分享文案
//   feed_read    把一条内容的正文/热评/字幕/关键帧读出来
//   grab_image   把网上的图片直链抓成本地可发的文件(带 Referer 下载 + webp 转码 + 缩到表情包尺寸)
//   feed_history 看最近刷过/分享过什么
//   feed_watch   定时刷的开关(默认每个登记的群每 80 分钟看一眼)
//
// 三个设计取舍:
//   1. 分享动作仍由模型完成:feed_share 只把封面图准备好并返回路径,真正发图走
//      qqbot_send_file(和 dsh-meme 的 send_meme → qqbot_send_file 同一条链路),
//      正文则由模型自己写 —— 语气不被插件写死。
//   2. 主动推送靠 agent.followup():定时器到点叫醒那个群会话,给一句「到点刷帖了」。
//      QQ 会话闲置会被 dsh-qqbot 回收(记录直接删掉,回复就没人路由了),所以:
//        · tools/install.mjs 把 im-qqbot 的 sessionIdleTimeout 调大;
//        · tools/patch-dsh-qqbot-manager.mjs 把会话管理器挂成服务,被回收/重启后
//          还能用 manager.getOrCreate() 按历史把会话 resume 回来再叫醒(最稳的那条)。
//   3. 所有抓取都在宿主进程里用 Node fetch 做,不依赖 pwsh/curl 之类的外部命令,
//      换台机器行为也一致。
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  bumpTaste, dayKey, dedupeTargets, findItem, findWatch, isSeen, loadState, markSeen, markShared, pruneState,
  registerTarget, rememberItems, removeWatch, saveState, upsertWatch, wasShared,
} from './lib/store.js'
import { SOURCE_IDS, describeItem, itemFromUrl, scroll, sourceMenu } from './lib/sources.js'
import { READABLE, readItem } from './lib/read.js'
import { prepareCover, resolveMediaDir } from './lib/card.js'
import { DEFAULT_EDGE, grabImage } from './lib/grab.js'
import { clip, humanAge, keywordsOf } from './lib/text.js'

export const name = 'feed-scroll'
/** tools 是硬依赖:没有工具注册表这个插件没有任何意义 */
export const inject = ['tools']

/** 用来确认「正在跑的是哪一版」:热重载有延迟,diag 里会打出来 */
const PLUGIN_REV = '2026-10-31.4'

const DEFAULTS = {
  stateDir: '',
  mediaDir: '',
  proactive: {
    enabled: true,
    quietFrom: 10,
    quietTo: 23,
    maxPerDay: 9,
    minGapMinutes: 60,
    defaultEveryMinutes: 80,
    defaultSource: 'auto',
    allGroups: true,
  },
  promptEnabled: true,
  promptText: '',
}

const DEFAULT_PROMPT = [
  '【刷帖——你自己的娱乐】',
  '你是群里的网友,不是助手。闲着的时候你会自己刷 B站和论坛(视频、帖子、热榜都刷)。',
  '- 想刷就 feed_scroll(source 不填=几个源混着刷),别报备、别念过程。',
  '- 单条值得安利的:feed_share 拿封面图路径 → 把那条路径原样交给 qqbot_send_file 发图 → 正文写你自己的一两句话(带上链接)。',
  '  别复述标题,像群友安利东西那样说;路径只交给工具,绝对不要写进回复正文。',
  '- 想发网图/表情包(自己 image_search 搜到的直链、别人丢群里的图):先 grab_image 把图抓到本地(它带 Referer、会把 webp 转成 jpg/png、缩到表情包尺寸),再把返回的路径交给 qqbot_send_file。别把直链直接丢给 qqbot_send_file——有些图床没 Referer 会 403,大图在 QQ 里也会被拉成一张大图。',
  '- 想聊一条内容之前先用 feed_read 读正文和热评(视频还能看关键帧画面),别只凭标题下结论。',
  '- 被人问「最近刷到啥」:挑重点用嘴说就行,不用一条条贴链接;想翻自己发过什么用 feed_history。',
  '- 没意思的就别发。一次最多发一条;群里没人搭理你的时候更要克制,一天主动发帖别超过五六条。',
  '- 想看某个话题/某个 UP 主就给 feed_scroll 传 query;定时刷归 feed_watch 管(白天每隔一个多小时会自己看一轮,不想刷了就 feed_watch pause)。',
  '- 只发 feed_scroll 返回过的链接,别自己编 URL。',
].join('\n')

/** 工具输出统一成 { text }:模型看 render,程序调用方拿规范值,两边一致 */
const TEXT_OUTPUT = {
  schema: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
    additionalProperties: false,
  },
  render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
}

export function apply(ctx, config = {}) {
  const settings = mergeConfig(config)
  const stateDir = settings.stateDir || join(homedir(), '.dsh', 'feed-scroll')
  const logger = ctx.logger ?? console
  const log = (level, message) => {
    const text = `[feed-scroll] ${message}`
    try {
      if (typeof logger[level] === 'function') logger[level](text)
      else console.log(text)
    } catch {
      /* 日志失败不连坐 */
    }
  }

  const readState = () => loadState(stateDir)
  const commit = (state) => {
    pruneState(state)
    saveState(stateDir, state)
    return state
  }

  /** 会话事件快照(宿主两版 Session 的字段名不同,拿不到就当空) */
  const sessionEventsOf = (session) => {
    try {
      const events = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : session?.events
      return Array.isArray(events) ? events : []
    } catch {
      return []
    }
  }

  /** 宿主装了 dsh-qqbot(qqbot_send_file 在工具表里);scope 是 agent 本身 */
  const hasQqbotTool = (exec) => {
    try {
      const tools = ctx.get('tools')
      if (!tools?.get) return false
      const agent = exec?.agent
      if (!agent) return false
      if (tools.get('qqbot_send_file', agent)) return true
      return Boolean(agent.ctx && tools.get('qqbot_send_file', agent.ctx))
    } catch {
      return false
    }
  }

  /**
   * 这一轮是不是从 QQ 官方机器人进来的?
   *
   * 判据取自 dsh-meme 踩出来的那条:qqbot 的入站消息 `source: { kind: 'user' }`
   * **没有 rpcId**,而 Web/桌面客户端发来的消息带一个裸 uuid 的 rpcId。
   * 只看「最后一条真实用户消息」——同一个会话可能既被群里用过、又被 Web 打开过。
   *
   * 为什么非要分:定时刷要往会话里插一句话叫醒她,插到 Web 会话里就是打扰,
   * 插到群里才是「自己刷到了好东西」。
   */
  const isQqConversation = (exec) => {
    if (!hasQqbotTool(exec)) return false
    const events = sessionEventsOf(exec?.agent?.session)
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i]
      if (event?.type !== 'user/message') continue
      const source = event.data?.source
      if (!source || source.kind !== 'user') continue
      return !String(source.rpcId ?? '').trim()
    }
    return false
  }

  const sessionIdOf = (exec) => {
    try {
      return String(exec?.agent?.session?.id ?? exec?.agent?.id ?? '')
    } catch {
      return ''
    }
  }

  /**
   * qqbot 的会话管理器。两条路都试:
   *   1. Cordis 服务 `qqbot-sessions`(补丁里 ctx.provide 的那个,正规做法);
   *   2. 进程级后门 globalThis[Symbol.for('dsh.qqbot-sessions')] —— 实测跨插件
   *      ctx.get() 未必看得见(插件重载/隔离都会让服务查不到),这个后门更稳。
   * 都没有就是没打补丁:定时刷退化成「只能叫醒还活着的会话」。
   */
  const sessionManager = () => {
    try {
      const viaCtx = ctx.get('qqbot-sessions')
      if (viaCtx) return viaCtx
    } catch {
      /* 服务不可见,试后门 */
    }
    try {
      return globalThis[Symbol.for('dsh.qqbot-sessions')] ?? undefined
    } catch {
      return undefined
    }
  }

  /** 和 dsh-qqbot 的 SessionManager.deriveSessionId 保持一致 */
  const derivedSessionId = (key) => {
    const hash = createHash('sha256').update(key).digest('hex')
    return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`
  }

  /**
   * 反查一个会话「往哪发」:scope / peerId / replyTarget 是会话被回收后重建记录的全部材料。
   * 两个来源:
   *   1. 会话还活着的时候直接问 qqbot 的会话记录(最准);
   *   2. 问不到就翻 ~/.dsh-qqbot/model-prefs.json —— qqbot 把
   *      `qqbot:<appId>:<scope>:<peerId>` → sessionId 的映射存在那儿(sessionId 要么是表里的,
   *      要么是那个 key 的 sha256),所以老账本里没存 peer 的条目也能补回来。
   */
  const peerOf = (sessionId) => {
    const record = sessionManager()?.findBySessionId?.(sessionId)
    if (record) {
      return {
        scope: record.scope,
        peerId: record.peerId,
        senderId: record.senderId,
        replyTarget: record.replyTarget,
      }
    }
    try {
      const prefs = JSON.parse(readFileSync(join(homedir(), '.dsh-qqbot', 'model-prefs.json'), 'utf8'))
      for (const [key, id] of Object.entries(prefs?.sessionIds ?? {})) {
        if (id !== sessionId && derivedSessionId(key) !== sessionId) continue
        const [, , scope, peerId] = key.split(':')
        if (!scope || !peerId) continue
        return {
          scope,
          peerId,
          senderId: scope === 'c2c' ? peerId : undefined,
          replyTarget: { scope, targetId: peerId },
        }
      }
    } catch {
      /* 文件不在/读不动就算了,退化成「只能叫醒还活着的会话」 */
    }
    return null
  }

  /**
   * qqbot 知道的所有**群**(内存记录 + model-prefs.json)。
   *
   * 光靠「在群里用过刷帖工具」登记的话,只会有一个群能被主动推 —— 实际她同时在好几个群里。
   * 这里把 qqbot 见过的群都找出来(有记录的最准,宿主重启后内存没了就翻 prefs 文件),
   * 交给 tick 登记成推送目标,这样每个群都会按同样的节奏被叫醒。
   */
  const knownGroupPeers = () => {
    const manager = sessionManager()
    const peers = new Map()
    try {
      for (const record of manager?.sessions?.values?.() ?? []) {
        if (record?.scope !== 'group' || !record.peerId) continue
        peers.set(record.peerId, {
          scope: 'group',
          peerId: record.peerId,
          senderId: record.senderId,
          replyTarget: record.replyTarget,
          sessionId: record.sessionId,
        })
      }
    } catch {
      /* 拿不到记录就只看 prefs */
    }
    try {
      const prefs = JSON.parse(readFileSync(join(homedir(), '.dsh-qqbot', 'model-prefs.json'), 'utf8'))
      const appId = manager?.config?.appId
      for (const [key, sessionId] of Object.entries(prefs?.sessionIds ?? {})) {
        const [kind, keyAppId, scope, peerId] = key.split(':')
        if (kind !== 'qqbot' || scope !== 'group' || !peerId) continue
        if (appId && keyAppId !== appId) continue
        if (peers.has(peerId)) continue
        peers.set(peerId, {
          scope: 'group',
          peerId,
          senderId: undefined,
          replyTarget: { scope: 'group', targetId: peerId },
          sessionId,
        })
      }
    } catch {
      /* 文件不在就算了 */
    }
    return [...peers.values()]
  }

  /** 在群里用过刷帖工具,就把这个会话登记成「可以主动推」的目标 */
  const registerIfGroup = (state, exec, label) => {
    if (!isQqConversation(exec)) return null
    const sessionId = sessionIdOf(exec)
    if (!sessionId) return null
    const target = registerTarget(state, sessionId, label)
    if (target && target.watch && !Number.isFinite(target.watch.everyMinutes)) {
      target.watch.everyMinutes = settings.proactive.defaultEveryMinutes
    }
    if (target && !target.peer) {
      const peer = peerOf(sessionId)
      if (peer) target.peer = peer
    }
    dedupeTargets(state)
    return state.targets[sessionId] ?? target
  }

  // ── 工具注册 ────────────────────────────────────────────────────────────
  const tools = ctx.get('tools')
  if (!tools?.register) {
    log('warn', 'tools 服务不可用,feed_* 工具未注册')
    return
  }

  tools.register({
    name: 'feed_scroll',
    description:
      '刷内容:从 B站/知乎/掘金/贴吧/HackerNews/少数派/IT之家/GitHub 拉一批新的视频或贴文,自动跳过刷过的,并按兴趣画像排序。' +
      '刷视频用 bilibili-hot(热门)/bilibili-rank(排行榜)/bilibili-search(搜索,配 query);逛论坛用 zhihu-hot/juejin/tieba-hot/hackernews/sspai/ithome;' +
      '想看某个话题或某个 UP 主的新投稿,用 bilibili-search 配 query 和 sort=new。不填 source 就是 auto(几个源混着刷)。' +
      `可选源:${sourceMenu()}。`,
    parameters: {
      type: 'object',
      properties: {
        source: { type: 'string', description: `内容源,默认 auto。可选:${sourceMenu()}` },
        query: { type: 'string', description: '关键词或 UP 主名字(source=bilibili-search 时必填)' },
        count: { type: 'number', description: '要几条,默认 6,最多 10' },
        sort: { type: 'string', description: 'bilibili-search 的排序:totalrank(综合,默认)/new(最新)/hot(最多播放)' },
        mood: { type: 'string', description: '此刻想看什么,空格分隔(如「游戏 抽象 独立游戏」),用来给结果加权' },
        include_seen: { type: 'boolean', description: '连刷过的也一起返回(默认跳过刷过的)' },
      },
      required: [],
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const state = readState()
      const source = SOURCE_IDS.includes(args.source) ? args.source : 'auto'
      const count = Math.max(1, Math.min(Number(args.count) || 6, 10))
      const seen = new Set(Object.keys(state.seen))
      const result = await scroll({
        source,
        query: args.query ?? '',
        count,
        sort: args.sort ?? '',
        mood: args.mood ?? '',
        taste: state.taste,
        seen,
        includeSeen: args.include_seen === true,
      })

      if (result.items.length > 0) {
        markSeen(state, result.items.map((item) => item.id))
        rememberItems(state, result.items)
      }
      registerIfGroup(state, exec)
      commit(state)

      const lines = []
      if (result.items.length === 0) {
        lines.push(`刷完了,没有新的可看(共 ${result.total} 条,其中 ${result.skippedSeen} 条之前刷过)。`)
        lines.push('换个源试试,或者传 include_seen=true 把刷过的也翻出来。')
      } else {
        const labels = result.sources.map((id) => SOURCE_IDS.includes(id) ? id : id).join(' + ')
        lines.push(`刷到 ${result.items.length} 条(${labels || source}),已跳过刷过的 ${result.skippedSeen} 条:`)
        lines.push('')
        result.items.forEach((item, index) => {
          lines.push(describeItem(item, index))
          if (wasShared(state, item.id)) lines.push('   (这条之前分享过)')
        })
        lines.push('')
        lines.push('想发哪条就 feed_share(id=方括号里那个),它会准备封面图;没意思就别发。')
      }
      if (result.notes.length > 0) lines.push('', `备注:${result.notes.join(';')}`)
      return { text: lines.join('\n') }
    },
  })

  tools.register({
    name: 'feed_share',
    description:
      '把刷到的一条内容准备成可分享的样子:下载封面图(落到 QQ 发送白名单目录)并返回本地路径,同时记进「已分享」和兴趣画像。' +
      '之后把返回的封面路径交给 qqbot_send_file 发图,正文自己写一两句(带上链接)。' +
      'id 传 feed_scroll 返回的那个,或者直接传一条 http(s) 链接(自己找的、别人丢过来的都行,B站链接会去取标题封面)。' +
      '同一会话里重复调用不会重复计数;没刷过的内容先 feed_scroll 一次再来。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'feed_scroll 返回的 id(如 bilibili:BV1xx),或者一条 http(s) 链接' },
        comment: { type: 'string', description: '可选:你打算配的那句话(只记进账本,不会替你发)' },
        send_image: { type: 'boolean', description: '默认 true;false = 只发文字,不准备封面图' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const state = readState()
      let item = findItem(state, args.id)
      if (!item && /^https?:\/\//i.test(String(args.id ?? '').trim())) {
        try {
          item = await itemFromUrl(args.id)
          rememberItems(state, [item])
        } catch (error) {
          return { text: `这条链接我没解析出来:${error.message}。那就只发文字链接吧,别编标题。` }
        }
      }
      if (!item) {
        return {
          text: `账本里找不到 ${args.id}。先 feed_scroll 刷一轮,再拿返回的 id 来分享(链接也可以直接传)。`,
        }
      }
      const repeat = wasShared(state, item.id)
      const cover = args.send_image === false ? null : await prepareCover(item, { mediaDir: resolveMediaDir(settings) })
      if (!repeat) markShared(state, item, { comment: args.comment ?? '', keywords: keywordsOf(item) })
      registerIfGroup(state, exec)
      commit(state)

      const lines = []
      lines.push(`${repeat ? '又分享了一次' : '记下了'}:《${clip(item.title, 60)}》(${item.sourceLabel})`)
      lines.push(`链接:${item.url}`)
      if (cover?.path) lines.push(`封面图(本地,直接交给 qqbot_send_file):${cover.path}`)
      else if (cover?.url) lines.push(`封面图(直链,交给 qqbot_send_file 让它自己下):${cover.url}`)
      else lines.push('这条没有封面图,只发文字就行。')
      if (cover?.note) lines.push(`备注:${cover.note}`)
      lines.push('')
      lines.push('接下来:把封面图交给 qqbot_send_file(file_path=上面那条路径/直链)发出去,然后正文写你自己的一两句话,带上链接。')
      lines.push('路径只交给工具,别写进回复正文。')
      return { text: lines.join('\n') }
    },
  })

  tools.register({
    name: 'feed_read',
    description:
      '看内容:把一条视频/贴文**里面**读出来——正文、热评、字幕、B站关键帧图,想评论/安利一条东西之前先读它,别只凭标题下结论。' +
      `能读:${READABLE}。` +
      'B站的关键帧图是 10×10 的雪碧图(几十帧画面),把那一行的链接交给 qqbot_describe_image 就能「看到」视频画面;' +
      '字幕多数视频要登录 B 站账号才有,拿不到会明说。知乎不登录读不到正文。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'feed_scroll 返回的 id(如 bilibili:BV1xx),或者一条 http(s) 链接' },
        parts: { type: 'string', description: '要读哪几块,逗号分隔:text(正文) / comments(热评) / subtitles(字幕) / frames(关键帧图);默认全读' },
        max_chars: { type: 'number', description: '正文最多读多少字,默认 1200,最多 4000' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      const state = readState()
      let item = findItem(state, args.id)
      const preNotes = []
      if (!item && /^https?:\/\//i.test(String(args.id ?? '').trim())) {
        try {
          item = await itemFromUrl(args.id)
          rememberItems(state, [item])
          commit(state)
        } catch (error) {
          // 元信息解析不出来(JS 渲染页、反爬)也别放弃:退回最简条目,硬抽一次正文
          const host = (() => {
            try { return new URL(String(args.id)).host.replace(/^www\./, '') } catch { return '链接' }
          })()
          item = {
            id: `url:${args.id}`,
            source: 'url',
            sourceLabel: host,
            kind: 'post',
            title: String(args.id),
            url: String(args.id),
            cover: '',
            desc: '',
            extra: '',
            stats: {},
            tags: [],
          }
          preNotes.push(`没能解析出标题/封面(${error.message}),下面是直接从页面里抽的正文`)
        }
      }
      if (!item) {
        return { text: `账本里找不到 ${args.id}。先 feed_scroll 刷一轮,或者直接传链接。` }
      }
      const parts = String(args.parts ?? '')
        .split(/[,，\s]+/)
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
      const { blocks, notes } = await readItem(item, { parts, maxChars: args.max_chars })
      notes.unshift(...preNotes)

      const lines = [`《${clip(item.title, 70)}》(${item.sourceLabel})`, item.url, '']
      if (blocks.length === 0) lines.push('(什么都没读到)')
      for (const block of blocks) {
        lines.push(`【${block.title}】`)
        for (const l of block.lines) lines.push(String(l))
        lines.push('')
      }
      if (notes.length > 0) lines.push(`备注:${notes.join(';')}`)
      const frames = blocks.find((b) => b.title.startsWith('关键帧图'))
      if (frames) {
        lines.push('')
        lines.push('想看画面:把「关键帧图」那行的链接交给 qqbot_describe_image(它自己会下载),别把链接贴进群里。')
      }
      return { text: lines.join('\n') }
    },
  })

  tools.register({
    name: 'grab_image',
    description:
      '把网上的一张图抓到本地、转成「能直接发」的样子:按图床带 Referer 下载(贴吧/B站/知乎没 Referer 会 403)、按魔数认格式、webp 转 jpg/png、比 edge 大的缩到 edge 长边,落到 QQ 发送白名单目录并返回本地路径。' +
      '把返回的路径原样交给 qqbot_send_file 就能发出去。用 image_search 搜到直链后走这里 —— 别把直链直接丢给 qqbot_send_file:有些图床会 403,而且大图在 QQ 里会被拉成一张大图,不像表情包。' +
      `默认缩到 ${DEFAULT_EDGE}px 长边(表情包尺寸);要发照片/大图传 edge=1000;一点不想缩传 edge=0。`,
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '图片直链(http/https),来自 image_search 的结果或别人丢的链接' },
        edge: { type: 'number', description: `长边目标像素,默认 ${DEFAULT_EDGE};传 0 = 不缩(webp 仍会转成 jpg/png)` },
        referer: { type: 'string', description: '可选:覆盖自动推断的 Referer(默认按图床域名给)' },
      },
      required: ['url'],
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      try {
        const got = await grabImage(args.url, {
          mediaDir: resolveMediaDir(settings),
          ...(args.edge === undefined ? {} : { edge: args.edge }),
          ...(args.referer ? { referer: args.referer } : {}),
        })
        const lines = []
        lines.push(`抓到本地了:${got.path}`)
        const size = got.width && got.height ? `${got.width}×${got.height} · ` : ''
        lines.push(`${size}${got.ext} · ${Math.max(1, Math.round(got.bytes / 1024))}KB${got.resized ? '(已缩小)' : ''}`)
        if (got.note) lines.push(`备注:${got.note}`)
        lines.push('')
        lines.push('接下来:把上面那条路径原样交给 qqbot_send_file(file_path=…) 发出去,正文写你自己的话,别把路径写进回复。')
        return { text: lines.join('\n') }
      } catch (error) {
        return {
          text: `这张图没抓下来:${error.message}。换个链接或换一张候选再试;` +
            '实在不行就把直链交给 qqbot_send_file,让它自己下(那边也会转 webp,就是没有 Referer 和大图不缩)。',
        }
      }
    },
  })

  tools.register({
    name: 'feed_history',
    description: '看最近刷过/分享过什么:避免重复推荐,或者回答「你最近刷到啥」。',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '条数,默认 8' },
        only_shared: { type: 'boolean', description: 'true = 只看分享过的' },
      },
      required: [],
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      const state = readState()
      const limit = Math.max(1, Math.min(Number(args.limit) || 8, 30))
      const lines = []
      const shared = state.shared.slice(-limit).reverse()
      lines.push(`分享过 ${state.shared.length} 条,最近 ${shared.length} 条:`)
      if (shared.length === 0) lines.push('  (还没分享过)')
      for (const row of shared) {
        lines.push(`- [${new Date(row.at).toLocaleString('zh-CN', { hour12: false }).slice(5, 16)}] ${clip(row.title, 50)} · ${row.sourceLabel ?? row.source} · ${row.url}`)
        if (row.comment) lines.push(`    配的话:${clip(row.comment, 60)}`)
      }
      if (args.only_shared !== true) {
        const recent = Object.values(state.recent)
          .sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
          .filter((item) => !wasShared(state, item.id))
          .slice(0, limit)
        lines.push('')
        lines.push(`刷过但没分享的(最近 ${recent.length} 条):`)
        if (recent.length === 0) lines.push('  (没有)')
        for (const item of recent) {
          lines.push(`- ${clip(item.title, 50)} · ${item.sourceLabel} · ${humanAge(item.at)} · ${item.url}`)
        }
      }
      const tasteKeys = Object.keys(state.taste).sort((a, b) => state.taste[b] - state.taste[a]).slice(0, 12)
      if (tasteKeys.length > 0) {
        lines.push('')
        lines.push(`兴趣画像(权重最高的词):${tasteKeys.join('、')}`)
      }
      return { text: lines.join('\n') }
    },
  })

  tools.register({
    name: 'feed_watch',
    description:
      '定时刷的开关:登记/查看/暂停「到点自己刷一轮并分享到当前群」。' +
      `默认每个群每 ${settings.proactive.defaultEveryMinutes} 分钟看一眼(只在 ${settings.proactive.quietFrom}:00–${settings.proactive.quietTo}:00 之间,每天最多 ${settings.proactive.maxPerDay} 次);action 不填等于 list。只在 QQ 群/私聊会话里能登记。`,
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'add(登记/改) / list(查看) / pause(暂停) / resume(恢复) / remove(删掉) / diag(查为什么没叫醒) / recover(修一条叫不醒的会话),默认 list' },
        source: { type: 'string', description: `定时刷用的源,默认 ${DEFAULTS.proactive.defaultSource}` },
        query: { type: 'string', description: '定时刷的关键词(比如某个 UP 主),配合 source=bilibili-search' },
        every_minutes: { type: 'number', description: `多久刷一次(分钟),默认 ${settings.proactive.defaultEveryMinutes},最小 30` },
      },
      required: [],
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const state = readState()
      const action = String(args.action ?? 'list').toLowerCase()
      const sessionId = sessionIdOf(exec)
      const lines = []

      // 排障:定时刷没叫醒时,直接问宿主「哪一步断了」——agent 还在不在、
      // qqbot 的会话管理器服务可不可见、能不能靠历史把会话 resume 回来。
      if (action === 'diag') {
        const agentsSvc = ctx.get('agents')
        const manager = sessionManager()
        lines.push(`feed-scroll rev ${PLUGIN_REV}`)
        lines.push(`qqbot-sessions 服务:${manager ? '✅ 可见' : '❌ 不可见(补丁没生效 / 隔离到别的 realm)'}`)
        lines.push(`agents 服务:${agentsSvc?.get ? '✅' : '❌'}`)
        lines.push(`安静时段 ${settings.proactive.quietFrom}:00–${settings.proactive.quietTo}:00 · 每天最多 ${settings.proactive.maxPerDay} 次 · 现在 ${new Date().toLocaleString('zh-CN', { hour12: false })}`)
        for (const target of Object.values(state.targets)) {
          const short = target.sessionId.slice(0, 8)
          let live = null
          try {
            live = agentsSvc?.get?.(target.sessionId) ?? null
          } catch (error) {
            live = `抛错:${error instanceof Error ? error.message : String(error)}`
          }
          const record = manager?.findBySessionId?.(target.sessionId)
          let restored = ''
          if (!live && manager?.getOrCreate && target.peer) {
            try {
              const peer = target.peer
              const rec = record ?? await manager.getOrCreate(peer.scope, peer.peerId, peer.senderId ?? peer.peerId, peer.replyTarget ?? { scope: peer.scope, targetId: peer.peerId })
              restored = rec?.agent ? ' · 试着重建:✅ 成功(会话已回到内存)' : ' · 试着重建:❌ 没拿到 agent'
            } catch (error) {
              restored = ` · 试着重建:❌ ${error instanceof Error ? error.message : String(error)}`
            }
          }
          // getOrCreate 里的错误常被「create 撞上已存在」盖住,这里直接 resume 一次看真错误
          let direct = ''
          if (!live && !restored.includes('✅') && agentsSvc?.resume) {
            try {
              const resumed = await agentsSvc.resume({ resumeSessionId: target.sessionId })
              direct = resumed?.agent ? ' · 直接 resume:✅' : ' · 直接 resume:❌ 没 agent'
            } catch (error) {
              direct = ` · 直接 resume:❌ ${error instanceof Error ? error.message : String(error)}`
            }
          }
          lines.push(
            `- ${short} · agent ${typeof live === 'string' ? live : live ? '活着' : '不在了'} · manager 记录 ${record ? '在' : '不在'} · ` +
            `peer ${target.peer ? `${target.peer.scope}:${String(target.peer.peerId).slice(0, 8)}` : '无'}${restored}${direct}`,
          )
          lines.push(`  上次叫醒 ${target.lastWakeAt ? humanAge(target.lastWakeAt) : '还没'} · 最近一次错过 ${target.lastMissedAt ? humanAge(target.lastMissedAt) : '—'}${target.lastError ? ` · 原因:${target.lastError}` : ''}`)
        }
        if (Object.keys(state.targets).length === 0) lines.push('(还没有登记任何会话)')
        return { text: lines.join('\n') }
      }

      // 修一条叫不醒的会话。会话记录被回收后,agent 和 session 的清理可能只完成一半
      // (agent 没了、session 还挂在 sessions store 里),这时 resume 会一直报
      // `session "..." already exists`,直到宿主重启。这里按代价从小到大试:
      //   ① 直接重建 → ② 退回上一个会话 id(保住旧历史) → ③ 换新会话(会话会忘掉这个群)
      if (action === 'recover') {
        const manager = sessionManager()
        if (!manager?.getOrCreate) return { text: '拿不到 qqbot 的会话管理器(补丁没生效或插件没重载),修不了。' }
        const agentsSvc = ctx.get('agents')
        const appId = manager.config?.appId
        const lines = []
        for (const target of Object.values(state.targets)) {
          const short = target.sessionId.slice(0, 8)
          const peer = target.peer ?? peerOf(target.sessionId)
          if (!peer?.scope || !peer?.peerId) {
            lines.push(`${short}: 没有 peer 信息(不知道往哪个群发),跳过`)
            continue
          }
          target.peer = peer
          const replyTarget = peer.replyTarget ?? { scope: peer.scope, targetId: peer.peerId }
          let live = null
          try {
            live = agentsSvc?.get?.(target.sessionId) ?? null
          } catch { /* 忽略 */ }
          if (live) {
            lines.push(`${short}: agent 还活着,不用修`)
            continue
          }

          let record = null
          let route = ''
          try {
            record = await manager.getOrCreate(peer.scope, peer.peerId, peer.senderId ?? peer.peerId, replyTarget)
            if (record?.agent) route = '直接重建'
          } catch (error) {
            lines.push(`${short}: 直接重建失败 — ${error instanceof Error ? error.message : String(error)}`)
          }

          if (!record?.agent && appId && manager.modelResolver?.clearSessionId) {
            // 清掉 prefs 里的 sessionId 映射 → currentSessionId() 回落到「派生 id」,
            // 那通常是这个群更早的会话(还能 resume 出旧历史)
            try {
              manager.modelResolver.clearSessionId(`qqbot:${appId}:${peer.scope}:${peer.peerId}`)
              const rec = await manager.getOrCreate(peer.scope, peer.peerId, peer.senderId ?? peer.peerId, replyTarget)
              if (rec?.agent) {
                record = rec
                route = `退回上一个会话(${String(rec.sessionId).slice(0, 8)},旧历史还在)`
              }
            } catch (error) {
              lines.push(`${short}: 退回旧会话也失败 — ${error instanceof Error ? error.message : String(error)}`)
            }
          }

          if (!record?.agent && manager.remove) {
            try {
              await manager.remove(peer.scope, peer.peerId)
              const rec = await manager.getOrCreate(peer.scope, peer.peerId, peer.senderId ?? peer.peerId, replyTarget)
              if (rec?.agent) {
                record = rec
                route = `换了一个新会话(${String(rec.sessionId).slice(0, 8)},这个群的旧上下文没了)`
              }
            } catch (error) {
              lines.push(`${short}: 换新会话也失败 — ${error instanceof Error ? error.message : String(error)}`)
            }
          }

          if (record?.agent) {
            const oldId = target.sessionId
            const newId = String(record.sessionId ?? oldId)
            if (newId !== oldId) {
              delete state.targets[oldId]
              target.sessionId = newId
              state.targets[newId] = target
            }
            target.lastMissedAt = 0
            delete target.lastError
            lines.push(`${short}: ✅ ${route} —— 下一个到点(或下一分钟)就会正常叫醒`)
          } else {
            lines.push(`${short}: ❌ 三条路都没走通,得重启 DSH 清掉内存里卡住的会话`)
          }
        }
        commit(state)
        if (lines.length === 0) lines.push('(还没有登记任何会话)')
        return { text: lines.join('\n') }
      }

      if (action === 'add' || action === 'pause' || action === 'resume' || action === 'remove') {
        if (!sessionId) return { text: '拿不到当前会话 id,没法登记定时刷。' }
        let target = state.targets[sessionId]
        if (!target && action !== 'remove') {
          if (!isQqConversation(exec)) {
            return { text: '当前不是 QQ 群/私聊会话,定时刷只能登记在 QQ 会话里(那边才有发送目标)。' }
          }
          target = registerTarget(state, sessionId)
        }
        if (!target) return { text: '这个会话没有登记过定时刷,不用删。' }
        if (action === 'remove') {
          delete state.targets[sessionId]
          lines.push('定时刷已删掉。')
        } else if (action === 'pause') {
          target.watch = { ...target.watch, enabled: false }
          lines.push('定时刷已暂停(想恢复就 action=resume)。')
        } else {
          const everyMinutes = Math.max(30, Math.min(Number(args.every_minutes) || target.watch?.everyMinutes || settings.proactive.defaultEveryMinutes, 1440))
          target.watch = {
            source: SOURCE_IDS.includes(args.source) ? args.source : (target.watch?.source ?? settings.proactive.defaultSource),
            query: String(args.query ?? target.watch?.query ?? ''),
            everyMinutes,
            enabled: true,
          }
          lines.push(`定时刷已开启:${target.watch.source}${target.watch.query ? ` · ${target.watch.query}` : ''},每 ${everyMinutes} 分钟看一眼。`)
          lines.push(`安静时段 ${settings.proactive.quietFrom}:00–${settings.proactive.quietTo}:00,每天最多叫醒 ${settings.proactive.maxPerDay} 次。`)
        }
        commit(state)
      }

      lines.push('')
      lines.push('登记的会话:')
      const targets = Object.values(state.targets)
      if (targets.length === 0) lines.push('  (还没有:在群里刷一次 feed_scroll 就会自动登记)')
      for (const target of targets) {
        const watch = target.watch ?? {}
        const today = target.dayKey === dayKey() ? target.dayCount : 0
        lines.push(
          `- ${target.label || target.sessionId.slice(0, 8)} · ${watch.enabled === false ? '已暂停' : '开着'} · ` +
          `${watch.source ?? 'auto'}${watch.query ? `(${watch.query})` : ''} · 每 ${watch.everyMinutes ?? '-'} 分钟 · ` +
          `今天叫过 ${today}/${settings.proactive.maxPerDay} 次 · 上次 ${target.lastWakeAt ? humanAge(target.lastWakeAt) : '还没'}`,
        )
      }
      return { text: lines.join('\n') }
    },
  })

  log('info', `工具已注册(feed_scroll / feed_share / feed_read / grab_image / feed_history / feed_watch),账本:${stateDir}`)

  // ── 提示词:让「刷帖 + 分享」成为习惯,而不是等人开口 ────────────────
  ctx.inject(['systemPrompt'], (scope) => {
    if (settings.promptEnabled === false) return
    scope.effect(() => scope.systemPrompt.section({
      name: 'feed-scroll:scroll',
      order: 9500,
      interpolate: false,
      text: settings.promptText || DEFAULT_PROMPT,
    }), 'feed-scroll: prompt section')
  })

  // ── 定时刷:到点叫醒那个群会话,让会话自己刷一轮 ────────────────────────────
  ctx.inject(['agents'], (scope) => {
    if (settings.proactive.enabled === false) return
    const tick = async () => {
      try {
        const manager = sessionManager()
        await runWatchTick(scope, {
          settings,
          stateDir,
          log,
          commit: (s) => commit(s),
          peerOf,
          // qqbot 知道的所有群(内存记录 + model-prefs),用来把每个群都登记成推送目标
          discoverGroups: knownGroupPeers,
          // 会话被回收/宿主重启过时,请 qqbot 用历史把它 resume 回来
          restore: manager?.getOrCreate
            ? async (target) => {
              const peer = target.peer ?? peerOf(target.sessionId)
              if (!peer?.scope || !peer?.peerId) throw new Error('账本里没有 peer(不知道往哪个群发)')
              if (!target.peer) target.peer = peer
              const live = manager.findBySessionId?.(target.sessionId)
              const record = live ?? await manager.getOrCreate(
                peer.scope,
                peer.peerId,
                peer.senderId ?? peer.peerId,
                peer.replyTarget ?? { scope: peer.scope, targetId: peer.peerId },
              )
              if (!record?.agent) throw new Error('manager 没给出 agent')
              return record.agent
            }
            : undefined,
        })
      } catch (error) {
        log('warn', `定时刷这轮出错:${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const timer = setInterval(tick, 60_000)
    if (typeof timer.unref === 'function') timer.unref()
    scope.effect(() => () => clearInterval(timer), 'feed-scroll: watch timer')
    // 启动 90 秒后先跑一次,省得刚启动要等一分钟
    const first = setTimeout(tick, 90_000)
    if (typeof first.unref === 'function') first.unref()
    scope.effect(() => () => clearTimeout(first), 'feed-scroll: first watch tick')
  })
}

/**
 * 定时刷的一轮:找出到点的会话 → 叫醒它。
 *
 * 会话可能是「睡着的」:qqbot 的会话记录闲置超时就被回收,重启后也不会自己回来,
 * 出站路由查不到记录,回复会静默丢掉。所以这里给 restore 留了个口子 ——
 * 宿主打了 qqbot-sessions 服务补丁时,restore 会用 manager.getOrCreate() 把会话
 * (连同它的历史)resume 回来,再叫醒;没打补丁就只能等群里下次说话。
 *
 * @param {{get: (id: string) => unknown}} agents
 * @param {{settings: object, stateDir?: string, log?: Function, commit?: Function, restore?: (target: object) => Promise<unknown>|unknown, peerOf?: (sessionId: string) => object|null}} options
 */
async function runWatchTick(agents, { settings, stateDir, log, commit, restore, peerOf, discoverGroups }) {
  const state = loadState(stateDir)
  const now = Date.now()
  const hour = new Date().getHours()
  const { quietFrom, quietTo, maxPerDay, minGapMinutes } = settings.proactive
  const inQuiet = quietFrom <= quietTo ? hour >= quietFrom && hour < quietTo : hour >= quietFrom || hour < quietTo
  if (!inQuiet) return

  const today = dayKey()
  let changed = dedupeTargets(state)

  // 把 qqbot 知道的每个群都登记成推送目标(不只是开口刷过的那个)。
  // 新发现的群错开 10 分钟首刷,免得几个群同时被叫醒、一起刷屏。
  if (settings.proactive.allGroups !== false && typeof discoverGroups === 'function') {
    const known = discoverGroups()
    let index = 0
    for (const peer of known) {
      if (!peer?.peerId || peer.scope !== 'group') continue
      const sessionId = peer.sessionId
      if (!sessionId) continue
      const existing = state.targets[sessionId]
      if (existing) {
        if (!existing.peer) {
          existing.peer = peer
          changed = true
        }
        continue
      }
      const target = registerTarget(state, sessionId, `群 ${String(peer.peerId).slice(0, 8)}`)
      target.peer = peer
      target.watch = {
        source: settings.proactive.defaultSource,
        query: '',
        everyMinutes: settings.proactive.defaultEveryMinutes,
        enabled: true,
      }
      target.firstWakeAt = now + index * 10 * 60_000
      index += 1
      changed = true
      log?.('info', `发现新群 ${String(peer.peerId).slice(0, 8)},已登记定时刷(首刷 +${index * 10} 分钟)`)
    }
  }

  // 老账本里没存 peer 的目标:趁现在补一次(不然会话被回收后就叫不回来了)
  if (typeof peerOf === 'function') {
    for (const target of Object.values(state.targets)) {
      if (target.peer || !target.sessionId) continue
      const peer = peerOf(target.sessionId)
      if (peer) {
        target.peer = peer
        changed = true
      }
    }
  }
  for (const target of Object.values(state.targets)) {
    const watch = target.watch
    if (!watch || watch.enabled === false) continue
    if (target.dayKey !== today) {
      target.dayKey = today
      target.dayCount = 0
      changed = true
    }
    if ((target.dayCount ?? 0) >= maxPerDay) continue
    if (target.firstWakeAt && now < target.firstWakeAt) continue
    const gap = Math.max(minGapMinutes, watch.everyMinutes ?? settings.proactive.defaultEveryMinutes) * 60_000
    if (now - (target.lastWakeAt ?? 0) < gap) continue

    let agent = null
    let why = ''
    try {
      agent = agents.get(target.sessionId)
    } catch (error) {
      why = `agents.get 抛错:${error instanceof Error ? error.message : String(error)}`
      agent = null
    }
    if (!agent && restore) {
      // 会话被回收了(或宿主重启过):请 qqbot 把记录重建出来
      try {
        agent = (await restore(target)) ?? null
        if (agent) log?.('info', `会话 ${target.label || target.sessionId.slice(0, 8)} 已被回收,已用 manager 叫回来`)
        else why = why || 'restore 没拿到 agent(manager 里没有这条会话)'
      } catch (error) {
        why = `重建会话失败:${error instanceof Error ? error.message : String(error)}`
        log?.('warn', `重建会话失败 ${target.sessionId}:${why}`)
      }
    } else if (!agent && !restore) {
      why = '没有 restore 通道(qqbot-sessions 服务不可见,补丁没生效?)'
    }
    if (!agent) {
      // 还是叫不醒:记录一下(顺便把原因写进账本,免得只能靠猜),等下次在群里说话再继续
      target.lastMissedAt = now
      target.lastError = why || '未知原因'
      if (/already exists|failed validation|lacks an identified message|active write handle/.test(target.lastError)) {
        target.lastError += '(会话卡住了 → feed_watch action=recover,或按 README 修会话日志)'
      }
      changed = true
      continue
    }
    const hint = watch.source && watch.source !== 'auto'
      ? `（到点刷帖了:${watch.source}${watch.query ? ` · ${watch.query}` : ''}）`
      : '（到点刷帖了）'
    try {
      agent.followup({
        // 必须是「带标识的 user 消息」:role + id 缺一不可。
        // 少了它们,这条事件会被原样写进会话日志,之后任何 resume 都会在
        // `assertMessageEventShape` 上炸掉(session event at seq N lacks an identified message),
        // 那个群就再也叫不醒了 —— 2026-10-31 踩过一次。
        role: 'user',
        id: randomUUID(),
        content: [{
          type: 'text',
          text: `${hint}用 feed_scroll 刷一轮,看到值得发群里的就 feed_share + qqbot_send_file 发出去;刷不到有意思的就什么都别发,也不用解释。`,
        }],
        source: { kind: 'feed-scroll' },
      })
      target.lastWakeAt = now
      target.dayCount = (target.dayCount ?? 0) + 1
      target.dayKey = today
      delete target.lastError
      state.stats = { dayKey: today, dayCount: (state.stats?.dayKey === today ? state.stats.dayCount : 0) + 1, lastWakeAt: now }
      changed = true
      log('info', `叫醒会话 ${target.label || target.sessionId.slice(0, 8)} 去刷 ${watch.source ?? 'auto'}(今天第 ${target.dayCount} 次)`)
    } catch (error) {
      log('warn', `叫醒会话失败 ${target.sessionId}:${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (changed) commit(state)
}

function mergeConfig(config) {
  const out = { ...DEFAULTS, ...(config && typeof config === 'object' ? config : {}) }
  out.proactive = { ...DEFAULTS.proactive, ...(config?.proactive ?? {}) }
  return out
}

// 供测试脚本直接调用
export { DEFAULT_PROMPT, runWatchTick }
