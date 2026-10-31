// 「刷帖账本」:刷到过什么、分享过什么、对什么感兴趣、给哪个群定时刷。
//
// 为什么要有账本:
//   - 群里重复推同一条链接最掉价 —— seen 让 feed_scroll 默认只吐新的;
//   - feed_share 只拿到一个 id(BV号/知乎 question id),靠 recent 把条目还原回来;
//   - 「感兴趣」不是玄学:shared 里的标题关键词累积成兴趣画像,下次刷的时候加权排序;
//   - 定时刷要记住往哪个会话推、推到几点、今天推过几条。
//
// 状态文件: <stateDir>/state.json(默认 ~/.dsh/feed-scroll/state.json),原子写(tmp + rename)。
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const VERSION = 1
const SEEN_TTL_MS = 45 * 24 * 3600 * 1000   // 刷过的记录留 45 天,够避免重复了
const RECENT_MAX = 400                       // 最近条目元数据上限
const SHARED_MAX = 200                       // 分享历史上限
const TASTE_MAX_KEYS = 400                   // 兴趣画像上限(超出砍权重最低的)
const TASTE_MAX_WEIGHT = 24

export function emptyState() {
  return {
    version: VERSION,
    seen: {},
    recent: {},
    shared: [],
    taste: {},
    watch: [],
    targets: {},
    stats: { dayKey: '', dayCount: 0, lastWakeAt: 0 },
  }
}

/** 本地日期键 YYYY-MM-DD(按本地时区,安静时段/每日上限都按它算) */
export function dayKey(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function loadState(stateDir) {
  const file = join(stateDir, 'state.json')
  let raw = null
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return emptyState()
  }
  const state = emptyState()
  if (!raw || typeof raw !== 'object') return state
  for (const key of ['seen', 'recent', 'taste', 'targets']) {
    if (raw[key] && typeof raw[key] === 'object' && !Array.isArray(raw[key])) state[key] = raw[key]
  }
  for (const key of ['shared', 'watch']) if (Array.isArray(raw[key])) state[key] = raw[key]
  if (raw.stats && typeof raw.stats === 'object') state.stats = { ...state.stats, ...raw.stats }
  return state
}

export function saveState(stateDir, state) {
  try {
    mkdirSync(stateDir, { recursive: true })
    const file = join(stateDir, 'state.json')
    const tmp = file + '.tmp'
    writeFileSync(tmp, JSON.stringify(state, null, 2))
    renameSync(tmp, file)
  } catch {
    /* 账本写不进去不该拖垮工具调用 */
  }
}

/** 顺手清理过期/超量的记录,避免文件无限长 */
export function pruneState(state, now = Date.now()) {
  for (const [id, ts] of Object.entries(state.seen)) {
    if (!Number.isFinite(ts) || now - ts > SEEN_TTL_MS) delete state.seen[id]
  }
  const recentIds = Object.keys(state.recent)
  if (recentIds.length > RECENT_MAX) {
    const ordered = recentIds
      .map((id) => [id, Number(state.recent[id]?.at) || 0])
      .sort((a, b) => b[1] - a[1])
      .slice(RECENT_MAX)
    const keep = new Set(ordered.map(([id]) => id))
    for (const id of recentIds) if (!keep.has(id)) delete state.recent[id]
  }
  if (state.shared.length > SHARED_MAX) state.shared = state.shared.slice(-SHARED_MAX)
  const tasteKeys = Object.keys(state.taste)
  if (tasteKeys.length > TASTE_MAX_KEYS) {
    const keep = new Set(tasteKeys.sort((a, b) => state.taste[b] - state.taste[a]).slice(TASTE_MAX_KEYS))
    for (const key of tasteKeys) if (!keep.has(key)) delete state.taste[key]
  }
  return state
}

export function isSeen(state, id) {
  return Object.prototype.hasOwnProperty.call(state.seen, id)
}

export function markSeen(state, ids, now = Date.now()) {
  for (const id of ids) state.seen[id] = now
}

/** 记住条目的元数据(feed_share 之后要靠 id 找回来) */
export function rememberItems(state, items, now = Date.now()) {
  for (const item of items) {
    state.recent[item.id] = {
      id: item.id, source: item.source, sourceLabel: item.sourceLabel, kind: item.kind,
      title: item.title, url: item.url, cover: item.cover ?? '', author: item.author ?? '',
      desc: item.desc ?? '', extra: item.extra ?? '', stats: item.stats ?? {}, tags: item.tags ?? [],
      at: now,
    }
  }
}

/**
 * 用一个 id / 平台内 id / 链接 找回条目。
 * 支持: 完整 id(bilibili:BV1xx)、裸 BV 号、知乎 question id、以及条目自己的 url。
 */
export function findItem(state, key) {
  const raw = String(key ?? '').trim()
  if (!raw) return null
  if (state.recent[raw]) return state.recent[raw]
  const lower = raw.toLowerCase()
  for (const item of Object.values(state.recent)) {
    if (item.url && item.url.toLowerCase() === lower) return item
  }
  const bare = lower.includes(':') ? lower.split(':').pop() : lower
  for (const item of Object.values(state.recent)) {
    const idBare = String(item.id).toLowerCase().split(':').pop()
    if (idBare === bare) return item
    if (idBare && bare && (idBare.includes(bare) || bare.includes(idBare)) && bare.length >= 6) return item
  }
  return null
}

export function wasShared(state, id) {
  return state.shared.some((row) => row.id === id)
}

/** 记一次分享:进 shared 历史,同时给兴趣画像加权 */
export function markShared(state, item, { comment = '', keywords = [], now = Date.now() } = {}) {
  state.shared.push({
    id: item.id, title: item.title, url: item.url, source: item.source,
    sourceLabel: item.sourceLabel, at: now, comment: String(comment ?? '').slice(0, 200),
  })
  if (state.shared.length > SHARED_MAX) state.shared = state.shared.slice(-SHARED_MAX)
  bumpTaste(state, keywords, 3)
  return state
}

/** 兴趣画像加权:分享(强信号) / 只看过(弱信号) / 明确不喜欢(负信号) */
export function bumpTaste(state, keywords, delta) {
  for (const key of keywords ?? []) {
    const k = String(key).toLowerCase()
    if (!k) continue
    const next = (state.taste[k] ?? 0) + delta
    if (next <= 0) delete state.taste[k]
    else state.taste[k] = Math.min(next, TASTE_MAX_WEIGHT)
  }
  return state
}

export function history(state, { limit = 10, onlyShared = false } = {}) {
  const rows = onlyShared
    ? state.shared.slice(-limit).reverse()
    : [...state.shared.slice(-limit).reverse()]
  return rows
}

// ---- 定时刷(主动推送) ----

export function findWatch(state, id) {
  return state.watch.find((w) => w.id === id) ?? null
}

export function upsertWatch(state, watch) {
  const existing = findWatch(state, watch.id)
  if (existing) Object.assign(existing, watch)
  else state.watch.push(watch)
  return state
}

export function removeWatch(state, id) {
  const before = state.watch.length
  state.watch = state.watch.filter((w) => w.id !== id)
  return state.watch.length !== before
}

/**
 * 登记一个「可以主动推」的会话。第一次在某个群里刷内容时自动登记,
 * 之后定时器才知道往哪儿推。重复登记只更新 label。
 */
export function registerTarget(state, sessionId, label = '') {
  if (!sessionId) return null
  const now = Date.now()
  const existing = state.targets[sessionId]
  if (existing) {
    existing.lastSeenAt = now
    if (label) existing.label = label
    return existing
  }
  const target = {
    sessionId,
    label,
    addedAt: now,
    lastSeenAt: now,
    lastWakeAt: 0,
    dayKey: dayKey(),
    dayCount: 0,
    // 默认订阅:B站热门,每 3 小时看一眼。可以用 feed_watch 改或关掉。
    watch: { source: 'auto', query: '', everyMinutes: 180, enabled: true },
  }
  state.targets[sessionId] = target
  return target
}

/**
 * 同一个群在 `/new` 之后会拿到新的 sessionId,账本里就同时留着新旧两条目标 ——
 * 那会让同一个群被叫醒两次(每日上限还各算各的)。按 peer(scope + peerId)合并:
 * 保留「最近用过」的那条,计数取大值。返回是否有改动。
 */
export function dedupeTargets(state) {
  const byPeer = new Map()
  let changed = false
  for (const [sessionId, target] of Object.entries(state.targets ?? {})) {
    const scope = target?.peer?.scope
    const peerId = target?.peer?.peerId
    if (!scope || !peerId) continue
    const key = `${scope}:${peerId}`
    const prevId = byPeer.get(key)
    if (!prevId) {
      byPeer.set(key, sessionId)
      continue
    }
    const prev = state.targets[prevId]
    const keepNew = (target.lastSeenAt ?? 0) > (prev.lastSeenAt ?? 0)
    const keepId = keepNew ? sessionId : prevId
    const dropId = keepNew ? prevId : sessionId
    const keep = state.targets[keepId]
    const drop = state.targets[dropId]
    keep.dayCount = Math.max(keep.dayCount ?? 0, drop.dayCount ?? 0)
    keep.lastWakeAt = Math.max(keep.lastWakeAt ?? 0, drop.lastWakeAt ?? 0)
    keep.lastMissedAt = Math.max(keep.lastMissedAt ?? 0, drop.lastMissedAt ?? 0)
    keep.watch = keep.watch ?? drop.watch
    delete state.targets[dropId]
    byPeer.set(key, keepId)
    changed = true
  }
  return changed
}
