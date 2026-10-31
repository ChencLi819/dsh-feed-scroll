// 网络小工具:统一 UA / 超时 / 重试,并把「风控页」这类非 JSON 响应变成可读错误。
//
// 为什么不用 pwsh 的 Invoke-WebRequest:某些 Windows 环境下 schannel 不可用(TLS SEC_E_NO_CREDENTIALS),
// 只有 Node 自带的 OpenSSL 能拉 HTTPS —— 插件跑在宿主进程里,所以一切抓取都走这里。

/** 桌面 Chrome 的 UA:B 站等站点对默认 undici UA 会返回风控页 */
export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

const BASE_HEADERS = {
  'user-agent': UA,
  accept: 'application/json, text/plain, */*',
  'accept-language': 'zh-CN,zh;q=0.9',
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 抓 JSON。失败重试 retries 次(默认 1 次,即最多两次尝试)。
 * @param {string} url
 * @param {{headers?: Record<string,string>, timeoutMs?: number, method?: string, body?: string, retries?: number}} [options]
 */
export async function fetchJson(url, options = {}) {
  const { headers = {}, timeoutMs = 15000, method = 'GET', body, retries = 1 } = options
  let lastError
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        method,
        body,
        headers: { ...BASE_HEADERS, ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const text = await res.text()
      try {
        return JSON.parse(text)
      } catch {
        // B 站风控返回 HTML;有些接口返回 JSONP;都要说人话
        const head = text.slice(0, 60).replace(/\s+/g, ' ')
        throw new Error(`返回的不是 JSON(多半被风控/反爬挡了): ${head}`)
      }
    } catch (error) {
      lastError = error
      if (attempt < retries) await sleep(500 * (attempt + 1))
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

/** 抓二进制(封面图用),带大小上限;返回 {buf, contentType} */
export async function fetchBuffer(url, options = {}) {
  const { headers = {}, timeoutMs = 20000, maxBytes = 4 * 1024 * 1024 } = options
  const res = await fetch(url, {
    headers: { ...BASE_HEADERS, accept: 'image/*,*/*;q=0.8', ...headers },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length === 0) throw new Error('空响应')
  if (buf.length > maxBytes) throw new Error(`图片太大(${(buf.length / 1048576).toFixed(1)}MB)`)
  return { buf, contentType: (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase() }
}

/**
 * 按魔数判断图片类型 —— 扩展名要跟真实字节一致,否则 QQ 侧会按错误类型分发。
 * 认不出来时返回 ''。
 */
export function sniffImage(buf) {
  if (!buf || buf.length < 12) return ''
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: '.jpg', mime: 'image/jpeg' }
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return { ext: '.png', mime: 'image/png' }
  if (buf.toString('latin1', 0, 6).startsWith('GIF8')) return { ext: '.gif', mime: 'image/gif' }
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return { ext: '.webp', mime: 'image/webp' }
  if (buf[0] === 0x42 && buf[1] === 0x4d) return { ext: '.bmp', mime: 'image/bmp' }
  return ''
}
