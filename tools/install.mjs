// 把 dsh-feed-scroll 装进 DSH profile(幂等,可重复执行)。
//
// 做三件事:
//   1. pnpm add link:<本包目录>  —— link 协议 = 软链,改工作区里的代码即改插件,不用重装;
//   2. profile package.json 的 dsh.profile.bundles 里加上 dsh-feed-scroll(插件的 cordis.patch.yml 负责插行);
//   3. 把 im-qqbot 的 sessionIdleTimeout 调大(默认 30 分钟)—— QQ 会话被回收后
//      dsh-qqbot 会删掉会话记录,出站路由查不到记录,主动推送的回复会静默丢掉。
//      定时刷默认每 80 分钟一次,所以这里给到 12 小时。
//
// 用法: node feed-scroll/tools/install.mjs [--profile-dir <path>] [--no-pnpm] [--check]
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGE_NAME = 'dsh-feed-scroll'
const IDLE_TIMEOUT_MS = 12 * 3600 * 1000

const args = process.argv.slice(2)
const argOf = (name, def) => {
  const i = args.indexOf('--' + name)
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def
}
const PROFILE_DIR = resolve(argOf('profile-dir', process.env.DSH_PROFILE_DIR || join(homedir(), '.dsh', 'profiles', 'desktop')))
const CHECK_ONLY = args.includes('--check')
const SKIP_PNPM = args.includes('--no-pnpm')

const pkgJsonPath = join(PROFILE_DIR, 'package.json')
const patchPath = join(PROFILE_DIR, 'cordis.patch.yml')
if (!existsSync(pkgJsonPath)) {
  console.error(`找不到 ${pkgJsonPath} —— 用 --profile-dir 指定 DSH profile 目录`)
  process.exit(1)
}

/** 1) 依赖:pnpm add link:<包目录> */
function ensureDependency() {
  const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'))
  const current = pkg.dependencies?.[PACKAGE_NAME] ?? ''
  const wanted = `link:${PACKAGE_DIR}`
  if (current === wanted) return `已装(=${wanted})`
  if (CHECK_ONLY) return current ? `依赖是 ${current},期望 ${wanted}` : '未安装'
  if (SKIP_PNPM) return '跳过 pnpm(--no-pnpm)'
  const result = spawnSync('pnpm', ['add', wanted], { cwd: PROFILE_DIR, encoding: 'utf8', shell: true })
  if (result.status !== 0) {
    console.error('pnpm add 失败:\n' + (result.stdout ?? '') + (result.stderr ?? ''))
    process.exit(2)
  }
  return `已安装(${wanted})`
}

/** 2) bundles 列表:加上包名 */
function ensureBundle() {
  const raw = readFileSync(pkgJsonPath, 'utf8')
  const pkg = JSON.parse(raw)
  pkg.dsh = pkg.dsh ?? {}
  pkg.dsh.profile = pkg.dsh.profile ?? {}
  const bundles = Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : []
  if (bundles.includes(PACKAGE_NAME)) return '已在 bundles 里'
  if (CHECK_ONLY) return 'bundles 里没有它'
  bundles.push(PACKAGE_NAME)
  pkg.dsh.profile.bundles = bundles
  if (!CHECK_ONLY) copyFileSync(pkgJsonPath, pkgJsonPath + '.pre-feed-scroll.bak')
  writeFileSync(pkgJsonPath, JSON.stringify(pkg, null, 2) + '\n')
  return '已加入 bundles(原文件备份 .pre-feed-scroll.bak)'
}

/**
 * 3) im-qqbot 的 sessionIdleTimeout。
 * 只动 `- id: im-qqbot` 那一行的 config 块内部,不重写整个 YAML。
 */
function ensureIdleTimeout() {
  if (!existsSync(patchPath)) return '没有 cordis.patch.yml,跳过'
  const lines = readFileSync(patchPath, 'utf8').split('\n')
  const rowIdx = lines.findIndex((line) => /^-\s*id:\s*im-qqbot\s*$/.test(line))
  if (rowIdx < 0) return 'cordis.patch.yml 里没有 im-qqbot 行,跳过'
  let cfgIdx = -1
  for (let i = rowIdx + 1; i < lines.length; i++) {
    if (/^\S/.test(lines[i])) break
    if (/^\s{2}config:\s*$/.test(lines[i])) { cfgIdx = i; break }
  }
  if (cfgIdx < 0) return 'im-qqbot 没有 config 块,跳过'
  for (let i = cfgIdx + 1; i < lines.length; i++) {
    if (/^\S/.test(lines[i])) break
    if (/^\s{0,3}\S/.test(lines[i])) break
    const hit = /^(\s+)sessionIdleTimeout:\s*(\d+)\s*$/.exec(lines[i])
    if (hit) {
      if (Number(hit[2]) >= IDLE_TIMEOUT_MS) return `已经是 ${hit[2]}(>= ${IDLE_TIMEOUT_MS}),不动`
      if (CHECK_ONLY) return `现在是 ${hit[2]},建议改成 ${IDLE_TIMEOUT_MS}`
      lines[i] = `${hit[1]}sessionIdleTimeout: ${IDLE_TIMEOUT_MS}`
      copyFileSync(patchPath, patchPath + '.pre-feed-scroll.bak')
      writeFileSync(patchPath, lines.join('\n'))
      return `已从 ${hit[2]} 改成 ${IDLE_TIMEOUT_MS}(原文件备份 .pre-feed-scroll.bak)`
    }
  }
  if (CHECK_ONLY) return `没写 sessionIdleTimeout(默认 30 分钟,建议 ${IDLE_TIMEOUT_MS})`
  lines.splice(cfgIdx + 1, 0, `    sessionIdleTimeout: ${IDLE_TIMEOUT_MS}`)
  copyFileSync(patchPath, patchPath + '.pre-feed-scroll.bak')
  writeFileSync(patchPath, lines.join('\n'))
  return `已补上 sessionIdleTimeout: ${IDLE_TIMEOUT_MS}(原文件备份 .pre-feed-scroll.bak)`
}

console.log(`profile : ${PROFILE_DIR}`)
console.log(`插件包  : ${PACKAGE_DIR}`)
console.log(`1. 依赖  : ${ensureDependency()}`)
console.log(`2. bundle: ${ensureBundle()}`)
console.log(`3. 会话保活: ${ensureIdleTimeout()}`)
if (CHECK_ONLY) {
  console.log('\n(--check 只检查,不改动)')
} else {
  console.log('\n下一步:')
  console.log('  · 重启 DSH(或等热重载)后,新会话里会出现 feed_scroll / feed_share / feed_history / feed_watch;')
  console.log('  · 用 node feed-scroll/tools/probe-tools.mjs 读会话日志确认工具真的加载了;')
  console.log('  · 在群里说「刷点好玩的」就能试;想关掉定时刷:feed_watch action=pause。')
}
