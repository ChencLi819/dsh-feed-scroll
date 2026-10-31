// 把网上的一张图抓到本地,转成「QQ 能直接发」的样子。
//
// 为什么不直接把直链丢给 qqbot_send_file(dsh-qqbot 明明能下直链):
//   1. 有些图床对没有 Referer 的请求 403(贴吧/B站/知乎都是),qqbot 那边用自己的
//      UA、不带 Referer,拉不动;
//   2. 网图动辄 1000px+,QQ 里会被拉成一张大图,不像表情包 —— 本地图库统一缩到 300px,
//      网图也照同一套办;
//   3. webp 在 QQ 侧支持不确定 —— 统一转成 jpg/png(带透明通道的转 png)。
// 落盘目录默认 ~/.dsh-qqbot/media:它本来就在 qqbot 的发送白名单(MEDIA_ROOT)里,
// 而且受 media.ttlHours(默认 24h)清理,不会越攒越多。
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fetchBuffer, sniffImage } from './http.js'
import { loadSharp, refererFor } from './card.js'

/** 表情包尺寸:和 dsh-meme 的「QQ 发图尺寸」默认值保持一致 */
export const DEFAULT_EDGE = 300
/** 再大就别缩了(缩了反而糊),留个上限防止手滑传 100000 */
const MAX_EDGE = 1600
/** 网图上限:比封面宽松一点,但也别把几 MB 的原图拽进来 */
const MAX_BYTES = 8 * 1024 * 1024

/**
 * 抓一张网图到本地。
 * @param {string} url 图片直链(http/https)
 * @param {{mediaDir: string, edge?: number, maxBytes?: number, referer?: string}} options
 *   edge: 长边目标像素,默认 300;传 0 = 不缩(webp 仍会转格式)
 * @returns {Promise<{path: string, bytes: number, ext: string, width?: number, height?: number,
 *   resized: boolean, animated: boolean, contentType: string, note: string}>}
 */
export async function grabImage(url, { mediaDir, edge = DEFAULT_EDGE, maxBytes = MAX_BYTES, referer } = {}) {
  const raw = String(url ?? '').trim()
  if (!/^https?:\/\//i.test(raw)) throw new Error('只接受 http(s) 图片直链')

  const refererHeader = referer || refererFor(raw)
  const { buf, contentType } = await fetchBuffer(raw, {
    maxBytes,
    ...(refererHeader ? { headers: { referer: refererHeader } } : {}),
  })
  const sniff = sniffImage(buf)
  if (!sniff) {
    throw new Error(`这个链接不是图片(Content-Type: ${contentType || '未知'})——要图片直链,不是网页`)
  }

  let out = buf
  let ext = sniff.ext
  let width
  let height
  let resized = false
  let animated = false
  let note = ''

  const wantEdge = Math.max(0, Math.min(MAX_EDGE, Number.isFinite(Number(edge)) ? Number(edge) : DEFAULT_EDGE))
  const sharp = await loadSharp()
  if (!sharp) {
    note = '没找到 sharp,原图发出(webp 交给 qqbot_send_file 自己转)'
  } else if (sniff.ext === '.gif') {
    note = '动图原样发,不缩不转'
  } else {
    try {
      const image = sharp(buf, { animated: true })
      const meta = await image.metadata()
      width = meta.width
      height = meta.height
      animated = (meta.pages ?? 1) > 1
      if (animated) {
        note = '多帧动图原样发(转了只剩一帧)'
      } else {
        const needResize = wantEdge > 0 && Math.max(width ?? 0, height ?? 0) > wantEdge
        if (needResize || sniff.ext === '.webp') {
          const pipeline = needResize
            ? image.resize({ width: wantEdge, height: wantEdge, fit: 'inside', withoutEnlargement: true })
            : image
          const keepAlpha = meta.hasAlpha === true
          out = await (keepAlpha ? pipeline.png() : pipeline.jpeg({ quality: 92 })).toBuffer()
          ext = keepAlpha ? '.png' : '.jpg'
          resized = needResize
          if (needResize) {
            const after = await sharp(out).metadata()
            width = after.width
            height = after.height
          }
        }
      }
    } catch (error) {
      note = `转换失败(${error.message}),原图发出`
    }
  }

  const hash = createHash('sha1').update(`${raw}|${wantEdge}`).digest('hex').slice(0, 12)
  const path = join(mediaDir, `grab-${hash}${ext}`)
  writeFileSync(path, out)
  return { path, bytes: out.length, ext, width, height, resized, animated, contentType, note }
}
