// 「看内容」——把一条视频/贴文的**正文、热评、字幕、关键帧**读出来。
//
// 为什么单独一个模块:feed_scroll 只给标题/简介/数据(刷的时候够用),
// 但真要评论一件事、要跟群里聊出内容,得读到里面去。
// 各站点的门路不一样(2026-10-31 实测):
//   B站   view 接口给简介/标签/分P;评论走 legacy /x/v2/reply;关键帧走 player/videoshot;
//         字幕走 player/v2(多数视频要登录才有,拿不到就明说)
//   少数派 有正文 API(/api/v1/article/info/get)
//   HN    firebase 接口,正文和评论都是结构化的
//   掘金/IT之家/贴吧 抓 HTML 再抽正文
//   知乎  403 —— 不登录读不到,如实说,别编
import { randomUUID } from 'node:crypto'
import { fetchBuffer, fetchJson } from './http.js'
import { clip, humanCount, humanDuration, humanAge, stripTags } from './text.js'

const UA_HTML = {
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
}
const BILI_HEADERS = { referer: 'https://www.bilibili.com/', origin: 'https://www.bilibili.com' }

/** 抽正文时要丢掉的导航/控件行 */
const NOISE = /^(首页|登录|注册|搜索|下载|评论|分享|收藏|点赞|举报|回复|查看|更多|展开|收起|上一页|下一页|顶部|返回|APP|客户端|关于我们|联系方式|版权|免责声明|用户协议|隐私政策|广告|投稿|订阅|关注|关注我们|相关推荐|热门推荐|猜你喜欢|编辑于|发布于|阅读|字数|目录|评论\s*\d*|\d+)$/

/**
 * HTML → 可读正文。
 * 先按块级标签切行、去标签,再按行过滤导航噪声,最后截断。
 * 不做完整的 readability(正则解析嵌套 HTML 不划算),但对付新闻页/文章页够用。
 */
export function extractReadable(html, { limit = 1200, minLine = 8, from } = {}) {
  let source = String(html ?? '')
  // 有的站点正文在一个明确的容器里,从那儿切起能省掉一大段导航垃圾
  if (from) {
    const match = typeof from === 'string' ? { index: source.indexOf(from), length: from.length } : from.exec(source)
    if (match && match.index > 0) {
      // 切在标签结束处,别把 id="paragraph"> 这种半截标签留在正文里
      const tagEnd = source.indexOf('>', match.index + match[0].length)
      source = source.slice(tagEnd > 0 ? tagEnd + 1 : match.index)
    }
  }
  const body = source
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
  const withBreaks = body.replace(/<\/(p|div|li|tr|h[1-6]|section|article|blockquote|pre|td|figcaption)>/gi, '\n')
  const text = stripTags(withBreaks.replace(/<br\s*\/?>/gi, '\n'))
    .replace(/[ \t\u00a0]+/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length >= minLine && !NOISE.test(line))
  // 相邻重复行去掉(站点常见:标题出现两遍)
  const deduped = text.filter((line, index) => index === 0 || line !== text[index - 1])
  const joined = deduped.join('\n')
  return joined.length > limit ? joined.slice(0, limit) + '…' : joined
}

async function fetchHtml(url, extraHeaders = {}) {
  const res = await fetch(url, {
    headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36', ...UA_HTML, ...extraHeaders },
    redirect: 'follow',
    signal: AbortSignal.timeout(20000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length > 3 * 1024 * 1024) throw new Error('页面太大,放弃')
  return buf.toString('utf8')
}

const line = (label, value) => (value ? `${label}:${value}` : '')

// ── B站 ────────────────────────────────────────────────────────────────────
async function bilibiliBlocks(item, { parts, maxChars }) {
  const bvid = String(item.id).split(':').pop()
  const blocks = []
  const notes = []
  let cid = 0
  let aid = 0

  if (parts.has('text') || parts.has('comments') || parts.has('frames') || parts.has('subtitles')) {
    const view = await fetchJson(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, { headers: BILI_HEADERS })
    if (view?.code !== 0) throw new Error(`B站 view 接口:${view?.message ?? view?.code}`)
    const data = view.data
    cid = data.cid
    aid = data.aid
    if (parts.has('text')) {
      blocks.push({
        title: '视频信息',
        lines: [
          `标题:${stripTags(data.title)}`,
          `UP主:${data.owner?.name ?? ''}(${humanCount(data.owner?.mid) ? data.owner.mid : data.owner?.mid ?? ''})`,
          `时长:${humanDuration(data.duration)} · 播放 ${humanCount(data.stat?.view)} · 点赞 ${humanCount(data.stat?.like)} · 弹幕 ${humanCount(data.stat?.danmaku)} · 收藏 ${humanCount(data.stat?.favorite)}`,
          `发布:${data.pubdate ? humanAge(data.pubdate * 1000) : ''} · 分区:${data.tname ?? ''}`,
          data.desc ? `简介:${clip(data.desc, maxChars)}` : '简介:(空)',
          (data.pages ?? []).length > 1 ? `分P:${data.pages.map((p) => p.part).join(' / ')}` : '',
          `标签:${(data.tags ?? []).map((t) => t.tag_name).join('、')}`,
        ].filter(Boolean),
      })
    }
  }

  if (parts.has('subtitles')) {
    try {
      const player = await fetchJson(`https://api.bilibili.com/x/player/v2?bvid=${bvid}&cid=${cid}`, { headers: BILI_HEADERS })
      const subs = player?.data?.subtitle?.subtitles ?? []
      if (subs.length === 0) {
        notes.push('这条视频没有可用的字幕(CC/智能字幕多数要登录 B 站账号才能读)')
      } else {
        const sub = subs[0]
        const url = String(sub.subtitle_url ?? '')
        if (url.startsWith('//')) {
          const json = await fetchJson('https:' + url)
          const text = (json?.body ?? []).map((seg) => stripTags(seg.content)).join(' ').trim()
          blocks.push({ title: `字幕(${sub.lan_doc ?? sub.lan ?? ''})`, lines: [clip(text, maxChars)] })
        }
      }
    } catch (error) {
      notes.push(`字幕读取失败:${error.message}`)
    }
  }

  if (parts.has('comments')) {
    try {
      const reply = await fetchJson(`https://api.bilibili.com/x/v2/reply?type=1&oid=${aid}&sort=2&ps=12&pn=1`, { headers: BILI_HEADERS })
      const rows = [...(reply?.data?.top_replies ?? []), ...(reply?.data?.replies ?? [])]
      const seen = new Set()
      const lines = []
      for (const row of rows) {
        const text = stripTags(row?.content?.message ?? '')
        if (!text || seen.has(text)) continue
        seen.add(text)
        lines.push(`[${humanCount(row.like)} 赞] ${clip(text, 90)}`)
        if (lines.length >= 8) break
      }
      blocks.push({ title: '热评', lines: lines.length ? lines : ['(还没有评论)'] })
    } catch (error) {
      notes.push(`评论读取失败:${error.message}`)
    }
  }

  if (parts.has('frames')) {
    try {
      const shot = await fetchJson(`https://api.bilibili.com/x/player/videoshot?bvid=${bvid}&index=1`, { headers: BILI_HEADERS })
      const image = shot?.data?.image?.[0]
      if (!image) {
        notes.push('这条视频没有关键帧图')
      } else {
        const full = String(image).startsWith('//') ? 'https:' + image : String(image)
        const grid = `${shot.data.img_x_len ?? '?'} 列 × ${shot.data.img_y_len ?? '?'} 行`
        const times = (shot.data.index ?? []).slice(0, 60)
        blocks.push({
          title: '关键帧图(想看画面就把这个链接交给 qqbot_describe_image)',
          lines: [
            `图片:${full}`,
            `排布:${grid},共 ${times.length} 帧,按时间从左到右、从上到下;单帧 ${shot.data.img_x_size ?? '?'}×${shot.data.img_y_size ?? '?'}`,
            `时间点(秒):${times.slice(0, 20).join(', ')}${times.length > 20 ? ' …' : ''}`,
          ],
        })
      }
    } catch (error) {
      notes.push(`关键帧读取失败:${error.message}`)
    }
  }

  return { blocks, notes }
}

// ── 各站点 ─────────────────────────────────────────────────────────────────
/** 抓到的正文短于这个长度就认为「没真读到」,如实说,别拿导航垃圾冒充正文 */
const MIN_USEFUL = 300

async function juejinBlocks(item, { maxChars }) {
  const id = String(item.id).split(':').pop()
  const notes = []
  // 掘金网页端自己用的接口:必须带 aid/uuid/client_type,否则 err_no=2 参数错误;
  // 正文在 data.article_info.mark_content(markdown),content 经常是空的。
  try {
    const data = await fetchJson(
      `https://api.juejin.cn/content_api/v1/article/detail?aid=2608&uuid=${randomUUID()}&spider=0`,
      {
        method: 'POST',
        body: JSON.stringify({ article_id: id, client_type: 2608 }),
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/plain, */*',
          referer: 'https://juejin.cn/',
          origin: 'https://juejin.cn',
        },
      },
    )
    const info = data?.data?.article_info
    if (info?.title) {
      const raw = String(info.mark_content || info.content || '')
      // markdown 里的图片/链接会把正文冲淡,只留文字
      const cleaned = raw
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      const text = cleaned.includes('<') ? extractReadable(cleaned, { limit: maxChars }) : cleaned.slice(0, maxChars)
      return {
        blocks: [
          {
            title: '文章信息',
            lines: [
              `标题:${stripTags(info.title)}`,
              `作者:${data?.data?.author_user_info?.user_name ?? item.author ?? ''}`,
              `阅读 ${humanCount(info.view_count)} · 赞 ${humanCount(info.digg_count)} · 评论 ${humanCount(info.comment_count)}`,
            ].filter(Boolean),
          },
          { title: '正文', lines: [text.trim() || '(接口没给正文)'] },
        ],
        notes,
      }
    }
  } catch (error) {
    notes.push(`掘金接口没通(${error.message}),退回抓网页`)
  }
  const html = await fetchHtml(item.url)
  const text = extractReadable(html, { limit: maxChars })
  if (text.length < MIN_USEFUL) notes.push('这次没抽到多少正文(掘金会反爬/限流),只有摘要能看')
  return { blocks: [{ title: '正文(网页抽取)', lines: [text || '(没抽到)'] }], notes }
}

async function sspaiBlocks(item, { maxChars }) {
  const id = String(item.id).split(':').pop()
  const data = await fetchJson(`https://sspai.com/api/v1/article/info/get?id=${id}&view=second`)
  const body = data?.data?.body ?? ''
  const text = extractReadable(body, { limit: maxChars })
  return {
    blocks: [
      { title: '摘要', lines: [clip(stripTags(data?.data?.summary ?? item.desc), 300)].filter(Boolean) },
      { title: '正文', lines: [text || '(没抽到正文)'] },
    ].filter((b) => b.lines.length && b.lines[0]),
    notes: [],
  }
}

async function ithomeBlocks(item, { maxChars }) {
  const html = await fetchHtml(item.url)
  const text = extractReadable(html, { limit: maxChars, from: /id="paragraph"|class="post_content"/ })
  const notes = text.length < MIN_USEFUL ? ['IT之家这次没抽到多少正文(页面结构可能变了)'] : []
  return { blocks: [{ title: '正文', lines: [text || '(没抽到正文)'] }], notes }
}

async function tiebaBlocks(item, { maxChars }) {
  const html = await fetchHtml(item.url)
  const text = extractReadable(html, { limit: maxChars, from: /class="d_post_content"/ })
  const notes = text.length < MIN_USEFUL ? ['贴吧这次没抽到多少内容(楼层要登录才全)'] : []
  return { blocks: [{ title: '话题页正文(贴吧要登录才能看全楼层)', lines: [text || '(没抽到正文)'] }], notes }
}

async function zhihuBlocks() {
  return {
    blocks: [],
    notes: ['知乎不登录返回 403,读不到正文;只能用它给的摘要(或者你在别处看到的版本)'],
  }
}

async function hackernewsBlocks(item, { parts, maxChars }) {
  const id = String(item.id).split(':').pop()
  const blocks = []
  const notes = []
  const story = await fetchJson(`https://hacker-news.firebaseio.com/v0/item/${id}.json`)
  if (story?.text) blocks.push({ title: '正文', lines: [clip(stripTags(story.text), maxChars)] })
  else if (story?.url) notes.push(`这是一条外链帖,正文在原文页面:${story.url}`)
  if (parts.has('comments')) {
    const kids = (story?.kids ?? []).slice(0, 6)
    const lines = []
    for (const kid of kids) {
      const row = await fetchJson(`https://hacker-news.firebaseio.com/v0/item/${kid}.json`).catch(() => null)
      if (!row?.text) continue
      lines.push(`[${row.by} · ${humanCount(row.score) ? row.score : ''}] ${clip(stripTags(row.text), 120)}`)
    }
    blocks.push({ title: '热评', lines: lines.length ? lines : ['(没有可读的评论)'] })
  }
  return { blocks, notes }
}

async function githubBlocks(item, { maxChars }) {
  const slug = String(item.id).split(':').pop()
  try {
    const readme = await fetchJson(`https://api.github.com/repos/${slug}/readme`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'dsh-feed-scroll' },
    })
    const text = Buffer.from(readme?.content ?? '', 'base64').toString('utf8')
    return { blocks: [{ title: 'README', lines: [clip(text.replace(/\n{2,}/g, '\n'), maxChars)] }], notes: [] }
  } catch (error) {
    return { blocks: [], notes: [`README 读取失败:${error.message}`] }
  }
}

/** 兜底:任何链接都能抽一段正文 */
async function urlBlocks(item, { maxChars }) {
  const html = await fetchHtml(item.url)
  const text = extractReadable(html, { limit: maxChars })
  if (text.length < MIN_USEFUL) {
    return { blocks: [{ title: '正文', lines: [text || '(空)'] }], notes: ['没抽到多少正文:可能是 JS 渲染的页面,或者要登录'] }
  }
  return { blocks: [{ title: '正文', lines: [text] }], notes: [] }
}

const READERS = {
  bilibili: bilibiliBlocks,
  juejin: juejinBlocks,
  sspai: sspaiBlocks,
  ithome: ithomeBlocks,
  tieba: tiebaBlocks,
  zhihu: zhihuBlocks,
  hackernews: hackernewsBlocks,
  github: githubBlocks,
  url: urlBlocks,
  'bilibili-url': bilibiliBlocks,
}

/**
 * 读一条内容的正文/热评/字幕/关键帧。
 * @param {object} item feed_scroll 的条目(或 itemFromUrl 的结果)
 * @param {{parts?: string[], maxChars?: number}} [options]
 */
export async function readItem(item, options = {}) {
  const parts = new Set(options.parts?.length ? options.parts : ['text', 'comments', 'frames', 'subtitles'])
  const maxChars = Math.max(300, Math.min(Number(options.maxChars) || 1200, 4000))
  // 条目上的 source 带着具体渠道(bilibili-hot / tieba-hot / ithome 快讯……),
  // 统一归到站点读者;认不出来就退到通用网页抽取。
  const raw = String(item.source ?? '')
  const key = raw.startsWith('bilibili') ? 'bilibili'
    : raw.startsWith('tieba') ? 'tieba'
      : raw.startsWith('ithome') ? 'ithome'
        : raw.startsWith('sspai') ? 'sspai'
          : raw.startsWith('juejin') ? 'juejin'
            : raw.startsWith('zhihu') ? 'zhihu'
              : raw === 'hn' || raw.startsWith('hackernews') ? 'hackernews'
                : raw.startsWith('github') ? 'github'
                  : raw
  const reader = READERS[key] ?? READERS.url
  const { blocks, notes } = await reader(item, { parts, maxChars })
  return { blocks: blocks.filter((b) => b.lines?.some((l) => String(l).trim())), notes }
}

/** 能读的站点清单(给工具描述用) */
export const READABLE = 'B站(简介/标签/热评/字幕/关键帧) · 掘金 · 少数派 · IT之家 · 贴吧 · Hacker News · GitHub README · 任意网页正文'
