// 内容源:把 B站 / 知乎 / 掘金 / 贴吧 / HackerNews / 少数派 / IT之家 / GitHub
// 各自的接口归一化成同一形状的条目,供 feed_scroll 使用。
//
// 条目形状:
//   { id, source, sourceLabel, kind, title, url, cover, author, desc, extra, stats, tags, publishedAt }
//   id 稳定且带平台前缀(bilibili:BV1xx / zhihu:2099…),账本、去重、分享都靠它。
//
// 部分站点在不少网络环境下连不通(实测 V2EX、Reddit、RSSHub、linux.do 常年超时)
// (被墙),所以不接;微博 403、B站 UP 主空间接口 412(WBI 风控),也不接。
// B 站搜索接口要带 Referer,否则回 HTML 风控页。
import { fetchBuffer, fetchJson } from './http.js'
import { clip, humanAge, humanCount, humanDuration, stripTags, tasteScore } from './text.js'

// B 站风控很挑头,而且**各接口口味不一样**(2026-10-31 实测):
//   popular / search 带 Referer 正常;ranking/v2 带 Referer 反而回 -352;
//   view 只给 Referer、不给 Origin 会回 412 的 HTML 风控页。
// 所以统一走 biliJson():按几套头档位依次试,谁给出 code=0 用谁,别猜哪个接口喜欢什么。
const BILI_HEADERS = { referer: 'https://www.bilibili.com/', origin: 'https://www.bilibili.com' }
const BILI_SEARCH_HEADERS = { referer: 'https://search.bilibili.com/', origin: 'https://search.bilibili.com' }
const BARE_HEADERS = {}

/**
 * 依次用几套请求头请求同一个 B 站接口,返回第一个 code=0 的响应。
 * @param {string} url
 * @param {{profiles?: Record<string,string>[], method?: string, body?: string}} [options]
 */
async function biliJson(url, options = {}) {
  const profiles = options.profiles ?? [BILI_HEADERS, BARE_HEADERS]
  let lastError
  for (const headers of profiles) {
    try {
      const data = await fetchJson(url, { headers, ...(options.method ? { method: options.method } : {}), ...(options.body ? { body: options.body } : {}) })
      if (data && data.code === 0) return data
      lastError = new Error(`B站接口返回 code=${data?.code ?? '?'} ${data?.message ?? ''}`.trim())
    } catch (error) {
      lastError = error
    }
  }
  throw lastError instanceof Error ? lastError : new Error('B站接口没有可用响应')
}

const videoUrl = (bvid) => `https://www.bilibili.com/video/${bvid}`

/** B 站封面 http:// → https://(QQ 侧拉 http 可能被拦) */
const httpsPic = (pic) => {
  const raw = String(pic ?? '').trim()
  if (!raw) return ''
  if (raw.startsWith('//')) return 'https:' + raw
  return raw.replace(/^http:\/\//, 'https://')
}

const tagList = (value) => {
  if (!Array.isArray(value)) return []
  return value
    .map((t) => (typeof t === 'string' ? t : t?.title ?? t?.name ?? ''))
    .map((t) => String(t).trim())
    .filter(Boolean)
    .slice(0, 6)
}

/** 从 bilibili popular / ranking 的公共形状里取条目 */
function biliVideoFrom(row, source, sourceLabel, index) {
  const bvid = row?.bvid
  if (!bvid) return null
  const stat = row.stat ?? {}
  return {
    id: `bilibili:${bvid}`,
    source,
    sourceLabel,
    kind: 'video',
    title: stripTags(row.title),
    url: videoUrl(bvid),
    cover: httpsPic(row.pic),
    author: row.owner?.name ?? row.author ?? '',
    desc: clip(row.desc, 110),
    extra: humanDuration(row.duration),
    stats: { view: stat.view ?? 0, like: stat.like ?? 0, danmaku: stat.danmaku ?? 0, reply: stat.reply ?? 0 },
    tags: [row.tname].filter(Boolean),
    publishedAt: Number(row.pubdate) ? Number(row.pubdate) * 1000 : 0,
    rank: index,
  }
}

export const SOURCES = {
  'bilibili-hot': {
    label: 'B站热门',
    kind: 'video',
    hint: 'B站当前热门视频(算法推荐流,不挑话题)',
    async fetch({ count }) {
      const data = await biliJson(`https://api.bilibili.com/x/web-interface/popular?ps=${Math.min(count * 2, 20)}&pn=1`)
      const list = data?.data?.list ?? []
      return list.map((row, i) => biliVideoFrom(row, 'bilibili-hot', 'B站热门', i)).filter(Boolean)
    },
  },

  'bilibili-rank': {
    label: 'B站排行榜',
    kind: 'video',
    hint: 'B站全站排行榜(按综合数据,通常比热门更"硬")',
    async fetch({ count }) {
      // 这个接口反过来:带 Referer 会被风控(-352),裸头才行
      const data = await biliJson('https://api.bilibili.com/x/web-interface/ranking/v2?rid=0&type=all', {
        profiles: [BARE_HEADERS, BILI_HEADERS],
      })
      const list = (data?.data?.list ?? []).slice(0, Math.max(count * 2, 20))
      return list.map((row, i) => biliVideoFrom(row, 'bilibili-rank', 'B站排行榜', i)).filter(Boolean)
    },
  },

  'bilibili-search': {
    label: 'B站搜索',
    kind: 'video',
    hint: '在 B 站搜视频,query 填关键词或 UP 主名字(配 sort=new 就是追更)',
    needsQuery: true,
    async fetch({ query, count, sort }) {
      const order = sort === 'new' ? 'pubdate' : sort === 'hot' ? 'click' : 'totalrank'
      const url =
        'https://api.bilibili.com/x/web-interface/search/type?search_type=video' +
        `&keyword=${encodeURIComponent(query)}&page=1&order=${order}`
      const data = await biliJson(url, { profiles: [BILI_SEARCH_HEADERS, BILI_HEADERS, BARE_HEADERS] })
      const list = (data?.data?.result ?? []).slice(0, Math.max(count * 2, 12))
      return list
        .map((row, i) => {
          const bvid = row.bvid
          if (!bvid) return null
          return {
            id: `bilibili:${bvid}`,
            source: 'bilibili-search',
            sourceLabel: 'B站搜索',
            kind: 'video',
            title: stripTags(row.title),
            url: videoUrl(bvid),
            cover: httpsPic(row.pic),
            author: row.author ?? '',
            desc: clip(row.description, 110),
            extra: humanDuration(row.duration),
            stats: { view: Number(row.play) || 0, danmaku: Number(row.danmaku) || 0, like: Number(row.like) || 0 },
            tags: [row.typename].filter(Boolean),
            publishedAt: Number(row.pubdate) ? Number(row.pubdate) * 1000 : 0,
            rank: i,
          }
        })
        .filter(Boolean)
    },
  },

  'bilibili-trending': {
    label: 'B站热搜',
    kind: 'topic',
    hint: 'B站热搜词(适合拿来找搜索灵感,不是视频)',
    async fetch({ count }) {
      const data = await fetchJson(`https://app.bilibili.com/x/v2/search/trending/ranking?limit=${Math.min(count * 2, 20)}`)
      const list = data?.data?.list ?? []
      return list.map((row, i) => {
        const keyword = String(row.keyword ?? row.show_name ?? '').trim()
        if (!keyword) return null
        return {
          id: `bilibili-trend:${keyword}`,
          source: 'bilibili-trending',
          sourceLabel: 'B站热搜',
          kind: 'topic',
          title: keyword,
          url: `https://search.bilibili.com/all?keyword=${encodeURIComponent(keyword)}`,
          cover: '',
          author: '',
          desc: '',
          extra: row.heat_score ? `热度 ${humanCount(row.heat_score)}` : '',
          stats: {},
          tags: [],
          publishedAt: 0,
          rank: i,
        }
      }).filter(Boolean)
    },
  },

  'zhihu-hot': {
    label: '知乎热榜',
    kind: 'post',
    hint: '知乎热榜问题(中文论坛/讨论区里最热的话题)',
    async fetch({ count }) {
      const data = await fetchJson(`https://api.zhihu.com/topstory/hot-list?limit=${Math.min(count * 2, 20)}`)
      return (data?.data ?? [])
        .map((row, i) => {
          const target = row?.target
          if (!target?.title) return null
          const id = String(target.id)
          const thumb = row?.children?.[0]?.thumbnail ?? target?.thumbnail ?? ''
          return {
            id: `zhihu:${id}`,
            source: 'zhihu-hot',
            sourceLabel: '知乎热榜',
            kind: 'post',
            title: stripTags(target.title),
            url: `https://www.zhihu.com/question/${id}`,
            cover: typeof thumb === 'string' ? thumb : '',
            author: '',
            desc: clip(target.excerpt, 110),
            extra: String(row.detail_text ?? '').trim(),
            stats: { answer: Number(target.answer_count) || 0, follower: Number(target.follower_count) || 0 },
            tags: [],
            publishedAt: Number(target.created) ? Number(target.created) * 1000 : 0,
            rank: i,
          }
        })
        .filter(Boolean)
    },
  },

  juejin: {
    label: '掘金',
    kind: 'post',
    hint: '掘金推荐流(中文技术社区的文章)',
    async fetch({ count }) {
      const data = await fetchJson('https://api.juejin.cn/recommend_api/v1/article/recommend_all_feed', {
        method: 'POST',
        body: JSON.stringify({ id_type: 2, client_type: 2608, sort_type: 200, cursor: '0', limit: Math.min(count * 2, 20) }),
      })
      return (data?.data ?? [])
        .map((row, i) => {
          const info = row?.item_info?.article_info
          if (!info?.title) return null
          const id = String(info.article_id)
          const author = row?.item_info?.author_user_info?.user_name ?? ''
          return {
            id: `juejin:${id}`,
            source: 'juejin',
            sourceLabel: '掘金',
            kind: 'post',
            title: stripTags(info.title),
            url: `https://juejin.cn/post/${id}`,
            cover: info.cover_image ?? '',
            author,
            desc: clip(info.brief_content, 110),
            extra: '',
            stats: {
              view: Number(info.view_count) || 0,
              like: Number(info.digg_count) || 0,
              comment: Number(info.comment_count) || 0,
            },
            tags: tagList(row?.item_info?.tags),
            publishedAt: Number(info.ctime) ? Number(info.ctime) * 1000 : 0,
            rank: i,
          }
        })
        .filter(Boolean)
    },
  },

  'tieba-hot': {
    label: '贴吧热榜',
    kind: 'topic',
    hint: '百度贴吧热议话题(游戏/娱乐向的讨论)',
    async fetch({ count }) {
      const data = await fetchJson('https://tieba.baidu.com/hottopic/browse/topicList')
      const list = data?.data?.bang_topic?.topic_list ?? []
      return list.slice(0, Math.max(count * 2, 16)).map((row, i) => {
        const name = stripTags(row.topic_name)
        if (!name) return null
        const url = stripTags(row.topic_url)
        return {
          id: `tieba:${row.topic_id}`,
          source: 'tieba-hot',
          sourceLabel: '贴吧热榜',
          kind: 'topic',
          title: name,
          url: url || `https://tieba.baidu.com/hottopic/browse/hottopic?topic_id=${row.topic_id}`,
          cover: httpsPic(row.topic_pic),
          author: '',
          desc: clip(row.topic_desc || row.abstract, 110),
          extra: '',
          stats: { discuss: Number(row.discuss_num) || 0 },
          tags: [],
          publishedAt: Number(row.create_time) ? Number(row.create_time) * 1000 : 0,
          rank: i,
        }
      }).filter(Boolean)
    },
  },

  hackernews: {
    label: 'Hacker News',
    kind: 'post',
    hint: 'Hacker News 头条(英文技术/创业圈)',
    async fetch({ count }) {
      const ids = await fetchJson('https://hacker-news.firebaseio.com/v0/topstories.json')
      const picked = (Array.isArray(ids) ? ids : []).slice(0, Math.min(count * 2, 14))
      const rows = await Promise.all(
        picked.map((id) =>
          fetchJson(`https://hacker-news.firebaseio.com/v0/item/${id}.json`, { timeoutMs: 12000 }).catch(() => null),
        ),
      )
      return rows
        .map((row, i) => {
          if (!row?.title) return null
          return {
            id: `hn:${row.id}`,
            source: 'hackernews',
            sourceLabel: 'Hacker News',
            kind: 'post',
            title: stripTags(row.title),
            url: row.url || `https://news.ycombinator.com/item?id=${row.id}`,
            cover: '',
            author: row.by ?? '',
            desc: '',
            extra: '',
            stats: { score: Number(row.score) || 0, comment: Number(row.descendants) || 0 },
            tags: [],
            publishedAt: Number(row.time) ? Number(row.time) * 1000 : 0,
            rank: i,
          }
        })
        .filter(Boolean)
    },
  },

  sspai: {
    label: '少数派',
    kind: 'post',
    hint: '少数派首页文章(数码/效率/生活)',
    async fetch({ count }) {
      const data = await fetchJson(`https://sspai.com/api/v1/article/index/page/get?limit=${Math.min(count * 2, 20)}&offset=0`)
      return (data?.data ?? [])
        .map((row, i) => {
          if (!row?.title) return null
          const banner = String(row.banner ?? '').trim()
          return {
            id: `sspai:${row.id}`,
            source: 'sspai',
            sourceLabel: '少数派',
            kind: 'post',
            title: stripTags(row.title),
            url: `https://sspai.com/post/${row.id}`,
            cover: banner ? (banner.startsWith('http') ? banner : `https://cdn.sspai.com/${banner}`) : '',
            author: row.author?.nickname ?? '',
            desc: clip(row.summary, 110),
            extra: '',
            stats: { like: Number(row.like_count) || 0, comment: Number(row.comment_count) || 0 },
            tags: tagList(row.tags),
            publishedAt: Number(row.released_time) ? Number(row.released_time) * 1000 : 0,
            rank: i,
          }
        })
        .filter(Boolean)
    },
  },

  ithome: {
    label: 'IT之家',
    kind: 'post',
    hint: 'IT之家快讯(数码/科技新闻)',
    async fetch({ count }) {
      const data = await fetchJson('https://api.ithome.com/json/newslist/news')
      const list = [...(data?.newslist ?? []), ...(data?.toplist ?? [])]
      const seen = new Set()
      return list
        .map((row, i) => {
          const id = String(row.newsid ?? row.url ?? '')
          if (!row.title || !id || seen.has(id)) return null
          seen.add(id)
          const url = String(row.url ?? '')
          return {
            id: `ithome:${id}`,
            source: 'ithome',
            sourceLabel: 'IT之家',
            kind: 'post',
            title: stripTags(row.title),
            url: url.startsWith('http') ? url : `https://www.ithome.com${url.startsWith('/') ? '' : '/'}${url}`,
            cover: httpsPic(row.image),
            author: '',
            desc: clip(row.description, 110),
            extra: '',
            stats: { hit: Number(row.hitcount) || 0, comment: Number(row.commentcount) || 0 },
            tags: tagList(row.kwdlist),
            publishedAt: row.postdate ? Date.parse(row.postdate) || 0 : 0,
            rank: i,
          }
        })
        .filter(Boolean)
        .slice(0, Math.max(count * 2, 16))
    },
  },

  github: {
    label: 'GitHub',
    kind: 'repo',
    hint: 'GitHub 新项目(近三周 star 涨得快的开源仓库)',
    async fetch({ count }) {
      const since = new Date(Date.now() - 21 * 24 * 3600 * 1000).toISOString().slice(0, 10)
      const url = `https://api.github.com/search/repositories?q=created:%3E${since}&sort=stars&order=desc&per_page=${Math.min(count * 2, 20)}`
      const data = await fetchJson(url, {
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'dsh-feed-scroll' },
      })
      return (data?.items ?? [])
        .map((row, i) => {
          if (!row?.full_name) return null
          return {
            id: `github:${row.full_name}`,
            source: 'github',
            sourceLabel: 'GitHub',
            kind: 'repo',
            title: row.full_name,
            url: row.html_url,
            cover: '',
            author: row.owner?.login ?? '',
            desc: clip(row.description, 110),
            extra: row.language ?? '',
            stats: { star: Number(row.stargazers_count) || 0, fork: Number(row.forks_count) || 0 },
            tags: [row.language].filter(Boolean),
            publishedAt: row.pushed_at ? Date.parse(row.pushed_at) || 0 : 0,
            rank: i,
          }
        })
        .filter(Boolean)
    },
  },
}

/** auto 模式默认混哪几个源(各取几条,再按兴趣重排) */
const AUTO_MIX = [
  ['bilibili-hot', 4],
  ['zhihu-hot', 3],
  ['juejin', 3],
  ['hackernews', 3],
  ['sspai', 2],
  ['tieba-hot', 2],
]

export const SOURCE_IDS = Object.keys(SOURCES)

/**
 * 从一条链接反推条目 —— 不一定只分享刷出来的东西:
 * 用 web_search / platform_search 找到的、或者群里别人丢过来的链接,也该能发。
 *
 * B站链接走官方 view 接口(拿得到播放量/封面/UP主);
 * 其它站点抓 HTML 头部的 og:title / og:image / <title>(够用,不做正文解析)。
 */
export async function itemFromUrl(url) {
  const raw = String(url ?? '').trim()
  if (!/^https?:\/\//i.test(raw)) throw new Error(`不是 http(s) 链接: ${raw}`)

  // HN 的帖子页是纯服务端渲染的静态页,抓页面拿不到评论 —— 直接走 firebase 接口
  const hn = /news\.ycombinator\.com\/item\?id=(\d+)/i.exec(raw)
  if (hn) {
    const row = await fetchJson(`https://hacker-news.firebaseio.com/v0/item/${hn[1]}.json`)
    if (!row) throw new Error(`HN 上没有 #${hn[1]}`)
    return {
      id: `hn:${hn[1]}`,
      source: 'hackernews',
      sourceLabel: 'Hacker News',
      kind: 'post',
      title: stripTags(row.title ?? `HN #${hn[1]}`),
      url: `https://news.ycombinator.com/item?id=${hn[1]}`,
      cover: '',
      author: row.by ?? '',
      desc: clip(stripTags(row.text ?? ''), 110),
      extra: '',
      stats: { score: Number(row.score) || 0, comment: (row.kids ?? []).length },
      tags: [],
      publishedAt: row.time ? row.time * 1000 : 0,
      rank: 0,
    }
  }

  // 知乎不登录是 403,别白抓一次:先按 id 建条目,正文由 feed_read 如实报告读不到
  const zhihu = /zhihu\.com\/(?:question|p)\/(\d+)/i.exec(raw)
  if (zhihu) {
    const isQuestion = /question\//i.test(raw)
    return {
      id: `zhihu:${zhihu[1]}`,
      source: 'zhihu',
      sourceLabel: '知乎',
      kind: 'post',
      title: `${isQuestion ? '知乎问题' : '知乎专栏'} ${zhihu[1]}`,
      url: raw,
      cover: '',
      author: '',
      desc: '',
      extra: '',
      stats: {},
      tags: [],
      publishedAt: 0,
      rank: 0,
    }
  }

  const bili = /bilibili\.com\/video\/(BV[0-9A-Za-z]+)/i.exec(raw)
  if (bili) {
    const data = await biliJson(`https://api.bilibili.com/x/web-interface/view?bvid=${bili[1]}`)
    const row = data?.data
    if (!row?.bvid) throw new Error(`B站接口没返回这条视频: ${data?.message ?? '未知错误'}`)
    return {
      id: `bilibili:${row.bvid}`,
      source: 'bilibili-url',
      sourceLabel: 'B站',
      kind: 'video',
      title: stripTags(row.title),
      url: videoUrl(row.bvid),
      cover: httpsPic(row.pic),
      author: row.owner?.name ?? '',
      desc: clip(row.desc, 110),
      extra: humanDuration(row.duration),
      stats: {
        view: Number(row.stat?.view) || 0,
        like: Number(row.stat?.like) || 0,
        danmaku: Number(row.stat?.danmaku) || 0,
      },
      tags: [row.tname].filter(Boolean),
      publishedAt: Number(row.pubdate) ? Number(row.pubdate) * 1000 : 0,
      rank: 0,
    }
  }

  // 认识的站点:og 抓不到标题(反爬/JS 渲染)也要能按站点读正文 —— feed_read 是按 source 分发的
  const known = knownSourceOfUrl(raw)
  let parsed
  try {
    parsed = await parseOpenGraph(raw)
  } catch (error) {
    if (known) return { ...known, url: raw, cover: '', author: '', desc: '', extra: '', stats: {}, tags: [], publishedAt: 0, rank: 0 }
    throw error
  }
  return parsed
}

/** 按域名认出站点,返回一个「先有 id 和 source,标题待补」的条目 */
function knownSourceOfUrl(raw) {
  const rules = [
    [/juejin\.cn\/post\/(\d+)/i, (m) => ({ id: `juejin:${m[1]}`, source: 'juejin', sourceLabel: '掘金', kind: 'post', title: `掘金文章 ${m[1]}` })],
    [/sspai\.com\/post\/(\d+)/i, (m) => ({ id: `sspai:${m[1]}`, source: 'sspai', sourceLabel: '少数派', kind: 'post', title: `少数派文章 ${m[1]}` })],
    [/ithome\.com\/0\/(\d+)\/(\d+)\.htm/i, (m) => ({ id: `ithome:${m[1]}${m[2]}`, source: 'ithome', sourceLabel: 'IT之家', kind: 'post', title: `IT之家 ${m[1]}/${m[2]}` })],
    [/ithome\.com\/html\/(\d+)\/(\d+)\.htm/i, (m) => ({ id: `ithome:${m[1]}${m[2]}`, source: 'ithome', sourceLabel: 'IT之家', kind: 'post', title: `IT之家 ${m[1]}/${m[2]}` })],
    [/tieba\.baidu\.com\/(?:p|hottopic)/i, () => ({ id: `tieba:${raw}`, source: 'tieba', sourceLabel: '贴吧', kind: 'post', title: '贴吧帖子' })],
    [/github\.com\/([\w.-]+)\/([\w.-]+)/i, (m) => ({ id: `github:${m[1]}/${m[2]}`, source: 'github', sourceLabel: 'GitHub', kind: 'repo', title: `${m[1]}/${m[2]}` })],
  ]
  for (const [re, build] of rules) {
    const hit = re.exec(raw)
    if (hit) return build(hit)
  }
  return null
}

/** 抓页面头部的 og:title / og:image(够用,不做正文解析) */
async function parseOpenGraph(raw) {
  const { buf } = await fetchBuffer(raw, { maxBytes: 1024 * 1024, headers: { accept: 'text/html,*/*;q=0.8' } })
  const html = buf.toString('utf8')
  const pick = (patterns) => {
    for (const re of patterns) {
      const hit = re.exec(html)
      if (hit?.[1]) return stripTags(hit[1])
    }
    return ''
  }
  const title = pick([
    /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i,
    /<title[^>]*>([^<]+)<\/title>/i,
  ])
  const cover = pick([
    /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
  ])
  const desc = pick([
    /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i,
  ])
  if (!title && !cover) throw new Error('这个页面没给出标题/封面(可能要登录或被反爬挡了),只能当普通链接发')
  const host = (() => { try { return new URL(raw).host.replace(/^www\./, '') } catch { return '' } })()
  const known = knownSourceOfUrl(raw)
  return {
    ...(known ?? {}),
    id: known?.id ?? `url:${raw}`,
    source: known?.source ?? 'url',
    sourceLabel: known?.sourceLabel ?? (host || '链接'),
    kind: known?.kind ?? 'post',
    title: title || known?.title || raw,
    url: raw,
    cover: cover ? (cover.startsWith('//') ? 'https:' + cover : cover) : '',
    author: '',
    desc: clip(desc, 110),
    extra: '',
    stats: {},
    tags: [],
    publishedAt: 0,
    rank: 0,
  }
}

/** 给工具描述用的「源清单」文本 */
export function sourceMenu() {
  return SOURCE_IDS.map((id) => `${id}(${SOURCES[id].label})`).join(' / ')
}

/**
 * 刷一轮。返回 { items, notes, sources } —— items 已按兴趣/热度排好序,并已过滤重复。
 * 单个源失败不影响其它源(auto 模式下尤其重要)。
 */
export async function scroll({ source = 'auto', query = '', count = 6, taste = {}, seen = new Set(), includeSeen = false, sort = '', mood = '' }) {
  const wanted = Math.max(1, Math.min(Number(count) || 6, 10))
  const notes = []
  let items = []
  let usedSources = []

  if (source === 'auto') {
    const groups = await Promise.all(
      AUTO_MIX.map(async ([id, n]) => {
        try {
          const rows = await SOURCES[id].fetch({ count: n, query: '' })
          usedSources.push(id)
          return rows.slice(0, n)
        } catch (error) {
          notes.push(`${SOURCES[id].label} 抓取失败: ${error.message}`)
          return []
        }
      }),
    )
    items = groups.flat()
  } else {
    const impl = SOURCES[source]
    if (!impl) throw new Error(`未知的内容源: ${source}`)
    if (impl.needsQuery && !String(query).trim()) throw new Error(`${impl.label} 需要 query(关键词/UP主名字)`)
    items = await impl.fetch({ count: wanted, query: String(query).trim(), sort })
    usedSources = [source]
  }

  // 去重(同一 BV 号/同一个问题出现在多个源里只留一条)
  const byId = new Map()
  for (const item of items) if (item && !byId.has(item.id)) byId.set(item.id, item)
  items = [...byId.values()]

  const moodWords = String(mood ?? '')
    .split(/[\s,，、]+/)
    .map((w) => w.trim().toLowerCase())
    .filter((w) => w.length >= 2)

  const scored = items.map((item) => {
    const haystack = `${item.title} ${item.desc} ${(item.tags ?? []).join(' ')}`.toLowerCase()
    let score = 3 / (1 + (item.rank ?? 0))          // 源内越靠前越热
    score += tasteScore(item, taste) * 0.8          // 兴趣画像
    if (moodWords.length) score += moodWords.filter((w) => haystack.includes(w)).length * 2
    if (item.kind === 'video') score += 0.3
    return { ...item, score: Number(score.toFixed(3)) }
  })

  const fresh = []
  let skippedSeen = 0
  for (const item of scored.sort((a, b) => b.score - a.score)) {
    if (!includeSeen && seen.has(item.id)) {
      skippedSeen++
      continue
    }
    fresh.push(item)
  }

  return {
    items: fresh.slice(0, wanted),
    notes,
    sources: usedSources,
    skippedSeen,
    total: items.length,
  }
}

/** 把一条条目渲染成给人(和模型)看的几行 */
export function describeItem(item, index) {
  const statBits = []
  // 视频看「播放」,文章看「阅读」——掘金/知乎的 view 不是播放量
  if (item.stats?.view) statBits.push(`${item.kind === 'video' ? '播放' : '阅读'} ${humanCount(item.stats.view)}`)
  if (item.stats?.like) statBits.push(`赞 ${humanCount(item.stats.like)}`)
  if (item.stats?.danmaku) statBits.push(`弹幕 ${humanCount(item.stats.danmaku)}`)
  if (item.stats?.answer) statBits.push(`回答 ${humanCount(item.stats.answer)}`)
  if (item.stats?.comment) statBits.push(`评论 ${humanCount(item.stats.comment)}`)
  if (item.stats?.score) statBits.push(`${item.stats.score} 分`)
  if (item.stats?.star) statBits.push(`★ ${humanCount(item.stats.star)}`)
  if (item.stats?.discuss) statBits.push(`讨论 ${humanCount(item.stats.discuss)}`)
  const head = [
    `${index + 1}. [${item.id}] ${item.title}`,
    item.author ? `@${item.author}` : '',
    item.extra || '',
    statBits.join(' · '),
    item.publishedAt ? humanAge(item.publishedAt) : '',
  ].filter(Boolean)
  const lines = [head.join('  ·  ')]
  if (item.desc) lines.push(`   ${clip(item.desc, 90)}`)
  lines.push(`   ${item.url}`)
  return lines.join('\n')
}
