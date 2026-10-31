// 文本小工具:去 HTML 标签、截断、时长/数量格式化、关键词提取(兴趣画像用)。

/** 去掉搜索结果里的 <em class="keyword">…</em> 之类标签,并还原实体 */
export function stripTags(input) {
  return String(input ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 按字符数截断(中文按字算),超出加省略号 */
export function clip(input, max = 120) {
  const text = stripTags(input)
  return text.length <= max ? text : text.slice(0, max - 1) + '…'
}

/** 播放/点赞这类数字:12345678 → 1234.6万 */
export function humanCount(n) {
  const num = Number(n)
  if (!Number.isFinite(num) || num <= 0) return ''
  if (num < 10000) return String(Math.round(num))
  if (num < 100000000) return `${(num / 10000).toFixed(num < 100000 ? 1 : 0)}万`
  return `${(num / 100000000).toFixed(1)}亿`
}

/** 秒 → 12:34 / 1:02:03;B 站搜索接口给的本来就是 "12:34" 时原样返回 */
export function humanDuration(value) {
  if (value == null || value === '') return ''
  if (typeof value === 'string' && value.includes(':')) return value
  const total = Number(value)
  if (!Number.isFinite(total) || total <= 0) return ''
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = Math.floor(total % 60)
  const pad = (x) => String(x).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

/** 时间戳(秒或毫秒)→ "3 小时前" / "10-28" */
export function humanAge(ts, now = Date.now()) {
  const ms = Number(ts) > 1e12 ? Number(ts) : Number(ts) * 1000
  if (!Number.isFinite(ms) || ms <= 0) return ''
  const diff = now - ms
  if (diff < 0) return '刚刚'
  const min = diff / 60000
  if (min < 60) return `${Math.max(1, Math.round(min))} 分钟前`
  const hour = min / 60
  if (hour < 24) return `${Math.round(hour)} 小时前`
  const day = hour / 24
  if (day < 30) return `${Math.round(day)} 天前`
  const d = new Date(ms)
  return `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, '0')}`
}

/** 关键词提取的停用词(太泛,进了兴趣画像只会稀释信号) */
const STOP = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'are', 'was', 'you', 'your', 'how', 'why', 'what', 'when',
  'https', 'http', 'www', 'com', 'html', 'org', 'net', '一个', '我们', '他们', '这个', '那个', '什么', '怎么',
  '可以', '已经', '因为', '所以', '但是', '如果', '就是', '还是', '不是', '没有', '自己', '大家', '现在',
  '今天', '昨天', '明天', '以及', '对于', '关于', '这样', '那样', '这些', '那些', '一种', '一下', '已经',
])

/**
 * 从一条内容里抽关键词,用于兴趣画像。
 * 中文没有分词器,用 2-gram 近似(标题短,噪声可接受),英文/数字按词切。
 * @returns {string[]} 去重后的关键词
 */
export function keywordsOf(item) {
  const out = new Set()
  for (const tag of item?.tags ?? []) {
    const t = String(tag).trim().toLowerCase()
    if (t && t.length <= 12) out.add(t)
  }
  const text = `${item?.title ?? ''} ${item?.desc ?? ''}`.toLowerCase()
  for (const word of text.match(/[a-z0-9][a-z0-9+.#_-]{1,23}/g) ?? []) {
    if (!STOP.has(word) && !/^\d+$/.test(word)) out.add(word)
  }
  const cjk = text.replace(/[^\u4e00-\u9fa5]+/g, ' ').split(/\s+/).filter(Boolean)
  for (const seg of cjk) {
    for (let i = 0; i + 2 <= seg.length; i++) {
      const gram = seg.slice(i, i + 2)
      if (!STOP.has(gram)) out.add(gram)
    }
  }
  return [...out]
}

/** 一条内容与兴趣画像的匹配度(命中关键词的权重和) */
export function tasteScore(item, taste) {
  if (!taste) return 0
  let score = 0
  for (const key of keywordsOf(item)) {
    const weight = taste[key]
    if (weight) score += Math.min(weight, 6)
  }
  return score
}
