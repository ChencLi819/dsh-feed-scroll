// 分享用的封面图:把封面下到「QQ 发送白名单里」的目录,再把本地路径交给 qqbot_send_file。
//
// 为什么不直接把封面 URL 丢给 qqbot_send_file:
//   dsh-qqbot 的 URL 直发补丁能下直链,但它用的是自己的 UA/无 Referer ——
//   B 站封面(i*.hdslb.com)对无 Referer 的请求会 403,贴吧图片同理。
//   所以插件自己按平台带 Referer 下载、按魔数定扩展名落到媒体目录;失败才退回 URL。
//
// 目录选择:默认 ~/.dsh-qqbot/media —— 它本来就在 qqbot 的发送白名单(MEDIA_ROOT)里,
// 而且受 media.ttlHours(默认 24h)清理,不会越攒越多。可用 config.mediaDir 覆盖。
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fetchBuffer, sniffImage } from './http.js'

/** 各平台封面图需要的 Referer(不给就 403) */
const REFERER_BY_HOST = [
  [/hdslb\.com|bilibili\.com/i, 'https://www.bilibili.com/'],
  [/tiebapic\.baidu\.com|baidu\.com/i, 'https://tieba.baidu.com/'],
  [/zhimg\.com|zhihu\.com/i, 'https://www.zhihu.com/'],
  [/juejin\.cn|byteimg\.com/i, 'https://juejin.cn/'],
  [/sspai\.com/i, 'https://sspai.com/'],
  [/ithome\.com/i, 'https://www.ithome.com/'],
]

export function refererFor(url) {
  for (const [re, referer] of REFERER_BY_HOST) if (re.test(url)) return referer
  return ''
}

export function resolveMediaDir(config = {}) {
  const dir = config.mediaDir && String(config.mediaDir).trim()
  const target = dir || join(homedir(), '.dsh-qqbot', 'media')
  try {
    if (!existsSync(target)) mkdirSync(target, { recursive: true })
  } catch {
    /* 建不出来就让后面的写入报错,由调用方降级成 URL */
  }
  return target
}

/**
 * 找 sharp —— 这个插件是 link: 装进 profile 的(本体在工作区),
 * 从工作区路径 `import('sharp')` 解析不到,所以按 profile 目录用 createRequire 找。
 * 找不到也没关系:webp 会退回「把直链交给 qqbot_send_file,让它自己转」。
 */
let sharpPromise = null
export function loadSharp() {
  if (sharpPromise) return sharpPromise
  sharpPromise = (async () => {
    const dirs = []
    if (process.env.DSH_PROFILE_DIR) dirs.push(String(process.env.DSH_PROFILE_DIR))
    try {
      const root = join(homedir(), '.dsh', 'profiles')
      for (const name of readdirSync(root)) dirs.push(join(root, name))
    } catch { /* 没有 profiles 目录就算了 */ }
    for (const dir of dirs) {
      try {
        const req = createRequire(join(dir, 'noop.js'))
        const mod = req('sharp')
        if (mod) return mod
      } catch { /* 换个 profile 再试 */ }
    }
    return null
  })()
  return sharpPromise
}

/** webp → jpg/png(QQ 对 webp 支持不确定);转不了返回 null,调用方退回直链 */
async function normalizeWebp(buf) {
  const sharp = await loadSharp()
  if (!sharp) return null
  try {
    const image = sharp(buf, { animated: true })
    const meta = await image.metadata()
    if ((meta.pages ?? 1) > 1) return null          // 动图原样发,别转成一帧
    const keepAlpha = meta.hasAlpha === true
    const out = await (keepAlpha ? image.png() : image.jpeg({ quality: 92 })).toBuffer()
    return { buf: out, ext: keepAlpha ? '.png' : '.jpg' }
  } catch {
    return null
  }
}

/**
 * 准备一张可以直接发给 qqbot_send_file 的封面图。
 * @returns {Promise<{path?: string, url?: string, bytes?: number, note?: string} | null>}
 *   path 有值 = 本地文件已就绪(首选);只有 url = 交给 qqbot 自己拉(它那边会转 webp);null = 这条内容没有封面。
 */
export async function prepareCover(item, { mediaDir, maxBytes = 4 * 1024 * 1024 } = {}) {
  const cover = String(item?.cover ?? '').trim()
  if (!/^https?:\/\//i.test(cover)) return null
  try {
    const referer = refererFor(cover)
    const { buf } = await fetchBuffer(cover, {
      maxBytes,
      ...(referer ? { headers: { referer } } : {}),
    })
    let bytes = buf
    let sniff = sniffImage(bytes)
    if (!sniff) return { url: cover, note: '封面不是常见图片格式,退回直链交给 qqbot 下载' }
    if (sniff.ext === '.webp') {
      const converted = await normalizeWebp(bytes)
      if (!converted) {
        // 没 sharp(或动图):让 qqbot 的 URL 直发补丁去下、去转,别把 webp 直接发出去
        return { url: cover, note: 'webp 封面没转成 jpg,退回直链交给 qqbot 处理' }
      }
      bytes = converted.buf
      sniff = { ext: converted.ext }
    }
    const hash = createHash('sha1').update(`${item.id}|${cover}`).digest('hex').slice(0, 12)
    const path = join(mediaDir, `feed-${hash}${sniff.ext}`)
    writeFileSync(path, bytes)
    return { path, bytes: bytes.length }
  } catch (error) {
    return { url: cover, note: `封面下载失败(${error.message}),退回直链交给 qqbot 下载` }
  }
}
