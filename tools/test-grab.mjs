// grab_image 的实测:一个本地 HTTP 服务(可控)+ 几条真实网图直链(会过期,失败只报告不算挂)。
//
// 用法: node feed-scroll/tools/test-grab.mjs
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { grabImage } from '../lib/grab.js'
import { loadSharp } from '../lib/card.js'

const mediaDir = mkdtempSync(join(tmpdir(), 'grab-test-'))
let failed = 0
const ok = (label, extra = '') => console.log(`  PASS  ${label}${extra ? ` — ${extra}` : ''}`)
const bad = (label, extra = '') => { failed++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`) }

function check(name, cond, detail = '') {
  if (cond) ok(name, detail)
  else bad(name, detail)
}

console.log(`mediaDir: ${mediaDir}\n`)

// ── 1. 本地服务:800×600 的 PNG,缩到 300 长边 ──────────────────────────────
const sharp = await loadSharp()
if (!sharp) {
  bad('sharp 可用', 'profile 里找不到 sharp,后面的缩图断言没法做')
} else {
  const big = await sharp({ create: { width: 800, height: 600, channels: 3, background: { r: 20, g: 80, b: 200 } } }).png().toBuffer()
  const webp = await sharp({ create: { width: 640, height: 480, channels: 4, background: { r: 200, g: 60, b: 60, alpha: 0.5 } } }).webp().toBuffer()
  let hits = 0
  const server = createServer((req, res) => {
    hits++
    if (req.url === '/big.png') { res.writeHead(200, { 'content-type': 'image/png' }); res.end(big); return }
    if (req.url === '/plain.webp') { res.writeHead(200, { 'content-type': 'image/webp' }); res.end(webp); return }
    if (req.url === '/page.html') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html>nope</html>'); return }
    res.writeHead(404); res.end('nope')
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`

  try {
    const got = await grabImage(`${base}/big.png`, { mediaDir, edge: 300 })
    check('大图缩到 300', existsSync(got.path) && Math.max(got.width, got.height) === 300 && got.resized,
      `${got.width}×${got.height} ${got.ext} ${Math.round(got.bytes / 1024)}KB`)
    check('落在 mediaDir 里', got.path.startsWith(mediaDir))
    check('扩展名跟真实字节一致', got.ext === '.jpg' || got.ext === '.png', got.ext)

    const noEdge = await grabImage(`${base}/big.png`, { mediaDir, edge: 0 })
    check('edge=0 不缩', Math.max(noEdge.width, noEdge.height) === 800 && !noEdge.resized, `${noEdge.width}×${noEdge.height}`)

    const fromWebp = await grabImage(`${base}/plain.webp`, { mediaDir, edge: 300 })
    check('webp 转码 + 透明通道走 png', fromWebp.ext === '.png' && Math.max(fromWebp.width, fromWebp.height) === 300,
      `${fromWebp.width}×${fromWebp.height} ${fromWebp.ext}`)

    let htmlError = ''
    try { await grabImage(`${base}/page.html`, { mediaDir }) } catch (error) { htmlError = error.message }
    check('网页链接报错(不是图片)', htmlError.includes('不是图片'), htmlError.slice(0, 60))

    let badUrl = ''
    try { await grabImage('ftp://example.com/a.jpg', { mediaDir }) } catch (error) { badUrl = error.message }
    check('非 http(s) 拒绝', badUrl.includes('http(s)'), badUrl.slice(0, 40))
  } finally {
    server.close()
  }
  check('本地服务收到请求', hits >= 3, `${hits} 次`)
}

// ── 2. 真实网图(image_search 给的直链,会过期)──────────────────────────────
const REAL = [
  ['GIF 动图', 'https://imgs.qiubiaoqing.com/qiubiaoqing/imgs/685d7e3a66fecBGx.gif'],
  ['新浪图床 jpg', 'https://n.sinaimg.cn/sinakd20260127ac/533/w480h853/20260127/4bb5-1fd78571541a1e856869072bbb0946aa.jpg'],
  ['爱画世界 png', 'http://img-work2.elfartworld.com/1777995028132_378297.png-work.w650'],
]
console.log('\n真实网图(带 Referer 下载):')
let realOk = 0
for (const [label, url] of REAL) {
  try {
    const got = await grabImage(url, { mediaDir, edge: 300 })
    realOk++
    console.log(`  ok    ${label} — ${got.width}×${got.height} ${got.ext} ${Math.round(got.bytes / 1024)}KB` +
      `${got.resized ? ' (缩过)' : ''}${got.note ? ` · ${got.note}` : ''}`)
    if (statSync(got.path).size !== got.bytes) bad(`${label} 落盘字节数对不上`)
  } catch (error) {
    console.log(`  skip  ${label} — ${error.message}(链接可能过期,不算失败)`)
  }
}
if (realOk === 0) bad('至少抓到一条真实网图', '三条都失败:多半是断网/图床挂了')

console.log(`\n${failed === 0 ? 'ALL PASS' : `${failed} FAILED`}`)
process.exit(failed === 0 ? 0 : 1)
