# 鱼食 · dsh-feed-scroll

> **让 agent 自己刷内容，把好东西分享进群。**
> 逛 B站 / 知乎 / 掘金 / 贴吧 / HackerNews / 少数派 / IT之家 / GitHub，
> 刷到有意思的视频或贴文 → 封面图 + 一句自己的话 + 链接，发进群；闲着的时候还会按点自己刷一轮。

一个 [DeepSeek Harness](https://deepseek.com/harness/)（DSH）插件。它不改模型、不改宿主，
只做三件事：**拉内容**、**读内容**、**把内容变成群里能发的一条消息**。

```
群里有人喊「刷点好玩的」        定时器到点自己叫醒会话
        │                              │
        └──────────┬───────────────────┘
                   ▼
   feed_scroll   拉一批新内容（跳过刷过的，按兴趣画像排序）
                   ▼
   feed_read     想聊哪条就读哪条：正文 / 热评 / 字幕 / B站关键帧图
                   ▼
   feed_share    挑中一条 → 下封面图 → 返回本地路径 + 分享文案
                   ▼
   qqbot_send_file(封面路径)      QQ 原生图片消息
                   ▼
   正文：模型自己写的一两句话 + 链接
```

**说什么话由模型自己写**，插件只负责把图准备好、把账记上——语气不会被插件写死。

---

## 目录

- [特性](#特性)
- [安装](#安装)
- [六个工具](#六个工具)
- [内容源](#内容源)
- [读一层：feed_read](#读一层feed_read)
- [抓网图：grab_image](#抓网图grab_image)
- [定时刷（主动分享）](#定时刷主动分享)
- [配置](#配置)
- [目录结构](#目录结构)
- [自测](#自测)
- [已知限制](#已知限制)
- [English](#english)

---

## 特性

| | |
|---|---|
| **11 个内容源** | B站（热门/排行/搜索/热搜）、知乎热榜、掘金、贴吧热议、HackerNews、少数派、IT之家、GitHub 新项目，`auto` 混着刷 |
| **读过再聊** | `feed_read` 能读正文、热评、字幕，B站还能拿到**关键帧雪碧图**——交给视觉模型就能「看见」视频画面 |
| **会记性** | 账本记住刷过什么、分享过什么；分享过的标题关键词累积成兴趣画像，下次刷的时候加权 |
| **会自己刷** | 定时器到点叫醒群会话（默认每 80 分钟看一眼，10:00–23:00，每天最多 9 次），不用等人开口 |
| **网图也能发** | `grab_image` 把任意图片直链抓成本地可发文件：按图床带 Referer、按魔数认格式、webp 转码、缩到表情包尺寸 |
| **只发得出手的** | 提示词里写死了节制：一次最多一条，群里没人搭理时更克制，没意思就别发 |

## 安装

### 方式一：装进 DSH profile（推荐）

```powershell
# 从插件目录（或 npm 包目录）里跑，幂等，可重复执行
node tools/install.mjs
```

它会做三件事：

1. `pnpm add link:<本包目录>` —— link 协议是软链，改代码即改插件；
2. 往 profile 的 `dsh.profile.bundles` 里加上 `dsh-feed-scroll`；
3. 把 `im-qqbot` 的 `sessionIdleTimeout` 调大（默认 30 分钟 → 12 小时）——
   QQ 会话被回收后 `dsh-qqbot` 会删掉会话记录，出站路由查不到记录，**主动推送的回复会被静默丢掉**。

```powershell
node tools/install.mjs --check                    # 只看装没装、要不要改会话保活
node tools/install.mjs --profile-dir <path>       # 指定 profile（默认 ~/.dsh/profiles/desktop）
```

### 方式二：手动装

在 profile 里 `pnpm add dsh-feed-scroll`（或 `link:` 到本地目录），然后让 `cordis.patch.yml` 插一行：

```yaml
- insert:
    - id: feed-scroll
      name: dsh-feed-scroll
```

改完**重启 DSH**（或动一下 profile 的 `cordis.patch.yml` 触发重载）。

### 依赖

| 依赖 | 必需？ | 说明 |
|---|---|---|
| DSH（带 `tools` 服务） | 必需 | 插件 `inject: ['tools']`，没有工具注册表它没有任何意义 |
| [`@tencent-connect/dsh-qqbot`](https://github.com/tencent-connect/dsh-qqbot) | 分享链路必需 | 发图走 `qqbot_send_file`；定时刷还依赖它的会话管理器把被回收的会话叫回来 |
| `sharp`（在 profile 里） | 可选 | webp 转码用。找不到就退回直链，交给 `qqbot_send_file` 自己处理 |

## 六个工具

| 工具 | 做什么 |
|---|---|
| `feed_scroll` | 拉一批新内容（`source` 不填 = 混着刷；给 `query` 就是搜某个话题/UP 主，`sort=new` 追更） |
| `feed_read` | 把一条内容读进去：正文 / 热评 / 字幕 / B站关键帧图 |
| `feed_share` | 把挑中的一条准备成「可发」的：下封面图 → 返回本地路径 + 分享文案（`id` 也可以直接给一条 http(s) 链接） |
| `grab_image` | 网上的一张图 → 本地可发文件（带 Referer、转码、缩图） |
| `feed_history` | 最近刷过/分享过什么 |
| `feed_watch` | 定时刷开关：`add` / `list` / `pause` / `resume` / `remove` / `diag` / `recover` |

**不只有刷出来的能分享**：`feed_share` 的 `id` 直接给链接也行——B站链接走官方 `view` 接口取标题/封面/UP主，
HN 走 firebase 接口，其它站点抓 HTML 头部的 `og:title` / `og:image`。自己搜到的、别人丢群里的链接都能发。

## 内容源

| 源 id | 说明 |
|---|---|
| `bilibili-hot` | B站热门 |
| `bilibili-rank` | B站排行榜 |
| `bilibili-search` | B站搜索（`query` + `sort=new` 就是追更某个 UP 主） |
| `bilibili-trending` | B站热搜词 |
| `zhihu-hot` | 知乎热榜（`api.zhihu.com`，不需要登录） |
| `juejin` | 掘金推荐流 |
| `tieba-hot` | 贴吧热议 |
| `hackernews` | HN 头条 |
| `sspai` | 少数派 |
| `ithome` | IT之家快讯 |
| `github` | GitHub 近三周新项目 |
| `auto` | 上面几个混着刷，再按兴趣重排（默认） |

**没接的**：V2EX / Reddit / RSSHub / linux.do 在不少网络环境下直接 `UND_ERR_CONNECT_TIMEOUT`（连不上，不是代码问题）；
微博 403；B站 UP 主空间接口 412（WBI 风控），所以「追某个 UP 主」走搜索接口的 `sort=new`，不硬刚风控。

**B站请求头是个坑**：风控口味按接口分——`popular`/`search` 要带 Referer，`ranking/v2` 带了 Referer 反而回 `-352`，
`view` 只给 Referer 不给 Origin 会回 412 的 HTML。所以统一走 `biliJson()`：按几套头档位依次试，谁给出 `code=0` 用谁。

## 读一层：feed_read

`feed_scroll` 只给标题/简介/数据——够「刷」，不够「聊」。`feed_read` 是往里面读一层：

| 站点 | 能读到 | 走什么 |
|---|---|---|
| B站 | 简介、UP主、时长/播放/点赞/收藏、分P、标签、**热评**（带赞数）、**关键帧图**、字幕（若有） | `view` + legacy `/x/v2/reply` + `/x/player/videoshot` + `/x/player/v2` |
| 少数派 | 摘要 + 正文全文 | `/api/v1/article/info/get?id=` |
| Hacker News | 正文（外链帖会告诉你正文在原文）+ 前几条评论 | firebase `/v0/item/<id>.json` |
| 掘金 / IT之家 / 贴吧 | 正文（HTML 抽取，可能带点导航残留） | 抓页面 → `extractReadable()` |
| GitHub | README 全文 | `/repos/<slug>/readme` |
| 任意网页 | 正文（兜底抽取） | 抓页面 → `extractReadable()` |
| 知乎 | **读不到**（403，不登录不给正文） | 如实说，不编 |

**「看视频」是怎么实现的**

- **画面**：`videoshot` 给一张 10×10 的**关键帧雪碧图**（典型 42 帧、单帧 480×270），按时间从左到右、从上到下排。
  `feed_read` 把链接给出来，模型再把链接交给 `qqbot_describe_image` —— 视觉模型能真的看懂（角色、Logo、画面文字、风格）。
- **字幕**：`/x/player/v2` 的字幕列表。多数视频不登录是空的（AI 字幕要账号），拿不到就明说。
- **没做的**：下视频/音频做 ASR。playurl 要登录才给高码率，音频还得先解码，收益不抵成本。

## 抓网图：grab_image

库里的图不够用的时候，agent 可以自己上网找：

```
image_search(关键词带上「表情包」「梗图」)   → 一批图片直链(不是网页)
   → grab_image(url)                      → 本地可发文件 + 路径
   → qqbot_send_file(路径)                 → 原生图片消息
```

`grab_image` 复用分享封面那套（`lib/card.js` + `lib/http.js`），多做三件事：

- **按图床带 Referer**（贴吧/B站/知乎/掘金… 不给就 403）；
- **按魔数认格式**，webp 转 jpg/png（带透明通道走 png），扩展名跟真实字节一致；
- **缩到 300px 长边**（和常见「QQ 发图尺寸」同一档）：网图动辄 1000px+，发出去会被拉成一张大图，不像表情包。

落盘到 `~/.dsh-qqbot/media`（本就在 qqbot 的发送白名单里，受 24h 清理）。`edge=0` 不缩（发照片用），`edge=1000` 缩到大图档。

## 定时刷（主动分享）

- agent **第一次在某个群里用刷帖工具**时，插件自动把这个会话登记成推送目标。
  判据：宿主装了 `qqbot_send_file` **且最后一条用户消息没有 rpcId** ——
  QQ 机器人的入站消息没有 rpcId，Web/桌面客户端发来的有，所以 Web 会话不会被登记。
  登记时顺手记下「往哪发」（`scope` / `peerId` / `replyTarget`），问 qqbot 的会话记录要；
  问不到就翻 `~/.dsh-qqbot/model-prefs.json`（那里有 `qqbot:<appId>:<scope>:<peerId>` → sessionId 的映射）。
- 同一个群 `/new` 之后会换 sessionId，账本里会留下新旧两条目标 —— `dedupeTargets()` 按群合并，否则同一个群会被叫醒两次。
- 默认每 **80 分钟**看一眼，只在 **10:00–23:00** 之间，每天最多 **9** 次，两次之间至少隔 60 分钟。
- 到点后用 `agent.followup()` 塞一句「到点刷帖了」；**会话要是已经被回收、或宿主重启过**，
  插件会通过 `qqbot-sessions` 服务 `manager.getOrCreate()` 按历史把会话 resume 回来再叫醒。
- `feed_watch action=diag` 是运行时的体检：`qqbot-sessions` 服务可不可见、agent 还在不在、
  manager 里有没有记录、能不能把会话重建出来，一次看全；`action=recover` 按代价从小到大修。

### 叫不醒怎么查、怎么修

`action=recover` 试三条路：① 直接重建；② 清掉 `model-prefs.json` 里的 sessionId 映射，**退回这个群更早的那个会话**（旧历史还在）；
③ `manager.remove()` 换一个全新会话（这个群的上下文就没了）。

**唤醒消息必须是「带标识的 user 消息」**：`agent.followup({ role: 'user', id: <uuid>, content, source })`。
少了 `role`/`id` 会被原样写进会话日志，之后每次 resume 都在 `assertMessageEventShape` 上炸
（`session event at seq N lacks an identified message`）。真发生了用：

```powershell
node tools/repair-session-log.mjs <session.v4.jsonl.zstd>          # dry-run，先看要改哪几条
node tools/repair-session-log.mjs <session.v4.jsonl.zstd> --apply  # 写回（自动备份 .pre-repair.bak）
```

### 为什么要动 dsh-qqbot 的三个地方

QQ 会话是**内存记录**：闲置超时会被 IdleEvictor 直接删掉，出站路由按会话 id 查不到记录就**静默丢弃**回复；
宿主重启后记录也没了（只剩磁盘上的历史）。只靠「会话还活着」的话，群里安静半小时后「自己刷一轮发群里」就再也不会发生。

1. `tools/install.mjs` —— 把 profile 里 `im-qqbot` 的 `sessionIdleTimeout` 从默认 30 分钟调到 12 小时；
2. `tools/patch-dsh-qqbot-manager.mjs` —— 把 `SessionManager` 挂成 Cordis 服务 `qqbot-sessions`，
   **并额外留一个 `globalThis[Symbol.for('dsh.qqbot-sessions')]` 后门**：跨插件 `ctx.get('qqbot-sessions')`
   在插件重载前后并不总是看得见，两条路都试才稳；这块补丁还会往 `~/.dsh/qqbot-sessions.log` 追加一行 ——
   **只有这行出现，才说明补丁真的被加载了**（改 `node_modules` 里的文件后，Node 的 ESM 缓存会让重载仍然跑旧代码）；
3. `index.js` 的唤醒消息形状（`role` + `id`，见上）。

排障：`state.json` 里 `targets.<会话>.lastMissedAt` 有值 = 那次没叫醒；`lastWakeAt` + `dayCount` 有值 = 叫醒了；
`lastError` 会写明原因。`node tools/probe-activity.mjs` 能一眼看完。

## 配置

默认值写在 `index.js` 的 `DEFAULTS` 里，`proactive` 是**深合并**的，所以在 profile 的 `cordis.patch.yml` 里补一行就能调：

```yaml
- id: feed-scroll
  config:
    proactive:
      maxPerDay: 5            # 每天最多叫醒几次
      defaultEveryMinutes: 120
      quietFrom: 9
      quietTo: 23
      allGroups: true         # 把 qqbot 知道的每个群都登记成目标
    promptEnabled: true       # false = 不注入「刷帖规则」，就不会主动刷
    promptText: ''            # 覆盖内置提示词段
    stateDir: ''              # 空 = ~/.dsh/feed-scroll
    mediaDir: ''              # 空 = ~/.dsh-qqbot/media
```

| 配置 | 默认 | 说明 |
|---|---|---|
| `proactive.enabled` | `true` | 定时刷总开关 |
| `proactive.quietFrom` / `quietTo` | `10` / `23` | 只在这个时段叫醒 |
| `proactive.maxPerDay` | `9` | 每个目标每天最多叫醒几次 |
| `proactive.minGapMinutes` | `60` | 两次之间至少隔多久 |
| `proactive.defaultEveryMinutes` | `80` | 默认间隔（分钟） |
| `proactive.allGroups` | `true` | 自动把 qqbot 知道的所有群登记成推送目标 |
| `promptEnabled` | `true` | 是否注入「刷帖规则」提示词段（`order: 9500`） |
| `stateDir` | `~/.dsh/feed-scroll` | 账本目录 |
| `mediaDir` | `~/.dsh-qqbot/media` | 封面图/网图落盘目录（要在 qqbot 发送白名单里） |

## 目录结构

```
dsh-feed-scroll/
├── index.js              插件本体：六个工具 + 提示词段 + 定时刷
├── lib/
│   ├── sources.js        11 个内容源 + auto 混刷 + 兴趣加权排序 + 链接反查条目
│   ├── read.js           看内容：各站正文/热评/字幕/关键帧 + HTML 正文抽取
│   ├── store.js          账本（seen/recent/shared/taste/targets，原子写）
│   ├── card.js           封面图下载（按平台带 Referer）→ 落到发送白名单目录
│   ├── grab.js           网图直链 → 本地可发文件（Referer + 转码 + 缩图）
│   ├── http.js           fetch 封装（UA/超时/重试/风控页识别/图片嗅探）
│   └── text.js           去标签、截断、数量/时长格式化、关键词提取
├── tools/
│   ├── install.mjs       装进 profile（幂等：pnpm add link + bundles + 会话保活）
│   ├── patch-dsh-qqbot-manager.mjs  把 qqbot 的会话管理器挂成服务（定时刷叫醒用）
│   ├── smoke.mjs         离线冒烟：11 个源 + 账本 + 封面下载
│   ├── test-grab.mjs     grab_image：本地服务(缩图/转码/报错) + 真实网图直链
│   ├── fake-host.mjs     假宿主自测：工具全流程 + 定时刷 tick + QQ/Web 判定
│   ├── probe-tools.mjs   读会话日志确认工具/提示词已加载
│   ├── probe-activity.mjs 看定时刷叫醒了几次、真调过哪些 feed_* 工具
│   └── repair-session-log.mjs 修会话日志里「缺 id/role」的消息事件
├── locale/{zh,en}.json   插件市场里的标题/说明
└── icon.svg
```

## 自测

```powershell
node tools/fake-host.mjs         # 不重启 DSH 的端到端自测（假宿主跑全部工具）
node tools/smoke.mjs --cover     # 抓一遍所有源 + 封面下载
node tools/test-grab.mjs         # 网图抓取（本地服务 + 真实直链）
node tools/probe-tools.mjs       # 运行中的宿主到底加载没加载
node tools/install.mjs --check   # 装没装、要不要改会话保活
```

## 已知限制

- **抓取全在宿主进程里用 Node fetch 做**，不依赖 `curl`/`Invoke-WebRequest`——某些 Windows 环境下 schannel 不可用（`SEC_E_NO_CREDENTIALS`）。
- **图片别直接丢直链给 `qqbot_send_file`**：B站/贴吧/知乎的图床对没有 Referer 的请求 403。
  插件自己按平台带 Referer 下载、按魔数定扩展名、缩图，落盘再发；下载失败才退回直链。
- **webp 图**用 profile 里的 `sharp` 转 jpg/png。插件若是 `link:` 装的，从工作区路径 `import('sharp')` 解析不到，
  所以用 `createRequire(profileDir)` 找；找不到就退回直链。
- **热重载有延迟**：改源码会重载，但可能是几十秒到十几分钟，别拿它当立即生效。
  想立刻生效就动一下 profile 的 `cordis.patch.yml`（改一个真实配置值，只改注释不算），或者重启 DSH。
  `feed_watch action=diag` 会打出 `rev` 号，用来确认跑的是哪一版。
- **改了 `node_modules` 里的插件代码不一定生效**：加载器按 URL import，走 ESM 缓存，重载后仍可能是旧代码——
  所以补丁往 `~/.dsh/qqbot-sessions.log` 写一行当作「补丁真的加载了」的证据。
  `cordis.patch.yml` 是 GUI 管的文件，注释会被重写抹掉，别往里面写注释当文档。
- **账本别手改**：`state.json` 里 `seen` 决定「什么算刷过」，删了会让同一批内容重复出现。
- 分享是有节制的：提示词里写了「一次最多一条、群里没人搭理时更克制」，定时刷本身也限了每天 9 次叫醒。

## 给 agent 的约定

- 刷内容用 `feed_scroll`，读内容用 `feed_read`（想聊一条之前先读，别只凭标题下结论），
  分享用 `feed_share` + `qqbot_send_file`，**路径只交给工具**，不要写进回复正文。
- 想发网图：`image_search` 拿直链 → `grab_image` 落盘 → `qqbot_send_file`；
  一张不行就换一张（图床会 403/过期），别把网页链接当表情包贴进群里。
- 想看视频画面：把 `feed_read` 给出的关键帧图链接交给 `qqbot_describe_image`，别把链接贴进群里。
- 只发 `feed_scroll` 返回过的链接，别自己编 URL；不确定就说不确定。
- 想追某个 UP 主 / 话题：`feed_scroll(source="bilibili-search", query="…", sort="new")`。

## English

**dsh-feed-scroll — let your agent scroll the feeds and share the good stuff.**

A [DeepSeek Harness](https://deepseek.com/harness/) plugin. It gives the agent six tools:
`feed_scroll` (pull fresh items from Bilibili / Zhihu / Juejin / Tieba / Hacker News / SSPAI / ITHome / GitHub),
`feed_read` (full text, top comments, subtitles, and Bilibili keyframe spritesheets),
`feed_share` (download the cover into the QQ send whitelist and return a local path),
`grab_image` (turn any image URL into a sendable local file: per-host Referer, magic-number format detection,
webp transcoding, resize), `feed_history` and `feed_watch` (scheduled rounds).

The plugin only prepares images and keeps the ledger — **the post itself is written by the model**, so the voice stays its own.
Scheduled rounds wake the group session (default: every 80 minutes, 10:00–23:00, max 9/day) and resume sessions that
`dsh-qqbot` already evicted.

```powershell
node tools/install.mjs   # idempotent: pnpm add link + profile bundle + session keep-alive
```

Requires DSH (with the `tools` service) and, for the sharing path, `@tencent-connect/dsh-qqbot`. MIT licensed.

## License

MIT
