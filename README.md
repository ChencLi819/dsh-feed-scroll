# dsh-feed-scroll

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.13.0-brightgreen.svg)](package.json)
[![DSH Plugin](https://img.shields.io/badge/DSH-plugin-5b6cff.svg)](https://github.com/topics/dsh-plugin)

DeepSeek Harness（DSH）插件。为 agent 提供内容聚合与分享能力：从 Bilibili、知乎、掘金、贴吧、
Hacker News、少数派、IT之家、GitHub 拉取条目，读取正文、热评、字幕与视频关键帧，
并将选定条目以「封面图 + 链接」的形式发送至会话；支持按计划自动执行。

插件负责内容获取、素材准备与状态维护。**分享文案由模型生成**，插件不预设表达方式。

---

## 目录

- [1. 功能](#1-功能)
- [2. 兼容性与依赖](#2-兼容性与依赖)
- [3. 安装](#3-安装)
- [4. 工具参考](#4-工具参考)
- [5. 配置](#5-配置)
- [6. 工作原理](#6-工作原理)
- [7. 运维与故障排查](#7-运维与故障排查)
- [8. 安全与隐私](#8-安全与隐私)
- [9. 已知限制](#9-已知限制)
- [10. 开发](#10-开发)
- [11. 许可证](#11-许可证)
- [English Overview](#english-overview)

---

## 1. 功能

| 能力 | 说明 |
| --- | --- |
| 内容聚合 | 11 个内容源，覆盖热门、排行、搜索、热搜、推荐流；`auto` 模式混合拉取并按兴趣权重排序 |
| 内容读取 | 读取正文、热评、字幕；Bilibili 支持获取视频关键帧雪碧图（10×10，供视觉模型分析） |
| 分享素材准备 | 下载封面图并落盘至 QQ 发送白名单目录，返回可发送的本地路径 |
| 图片处理 | 任意图片直链落盘：按来源附加 Referer、按文件头识别格式、WebP 转码、等比缩放 |
| 去重与排序 | 记录已读条目；分享记录的标题关键词累积为兴趣画像，用于后续排序加权 |
| 计划任务 | 按间隔自动唤起会话执行拉取（默认每 80 分钟，10:00–23:00，每日上限 9 次） |
| 会话保活 | 安装脚本调整 `im-qqbot` 会话超时，并提供会话恢复能力，避免推送静默失败 |

---

## 2. 兼容性与依赖

| 项目 | 要求 | 说明 |
| --- | --- | --- |
| DSH | `>= 0.1.7-rc.1` | 见 `package.json` 的 `dsh.engines.dsh` |
| Node.js | `>= 22.13.0` | 使用内置 `fetch`、`node:zlib` 等 |
| 宿主服务 | `tools` | 插件声明 `inject: ['tools']`，缺失时插件不生效 |
| `@tencent-connect/dsh-qqbot` | `>= 0.5.0`（可选） | 分享链路依赖其 `qqbot_send_file`；计划任务依赖其会话管理器 |
| `sharp` | 可选 | 用于 WebP 转码；未安装时回退为将直链交由 `qqbot_send_file` 处理 |

---

## 3. 安装

### 3.1 通过 DSH CLI 安装（推荐）

```bash
dsh plugin --profile web add github:ChencLi819/dsh-feed-scroll

# Desktop 版
dsh plugin --profile desktop add github:ChencLi819/dsh-feed-scroll
```

安装完成后重启 DSH，或在 profile 的 `cordis.patch.yml` 中修改任一配置值以触发重载。

### 3.2 通过仓库脚本安装

```powershell
node tools/install.mjs
```

脚本为幂等操作，依次执行：

1. `pnpm add link:<包目录>`，以软链方式装入 profile；
2. 在 profile 的 `dsh.profile.bundles` 中登记 `dsh-feed-scroll`；
3. 将 `im-qqbot.config.sessionIdleTimeout` 由默认 30 分钟调整为 12 小时。

> 第 3 步为计划任务的必要前置条件。`dsh-qqbot` 在会话闲置超时后删除会话记录，
> 出站路由查询不到记录时会静默丢弃消息，导致主动推送失效。

```powershell
node tools/install.mjs --check                 # 检查安装状态与配置项
node tools/install.mjs --profile-dir <path>    # 指定 profile（默认 ~/.dsh/profiles/desktop）
```

### 3.3 手动安装

在 profile 中安装包，并在 `cordis.patch.yml` 中注册插件：

```yaml
- insert:
    - id: feed-scroll
      name: dsh-feed-scroll
```

### 3.4 升级与卸载

| 操作 | 步骤 |
| --- | --- |
| 升级 | 重新执行 CLI 安装命令；`link:` 方式安装时更新源码后重启 DSH |
| 卸载 | 从 profile 的 `dsh.profile.bundles` 中移除 `dsh-feed-scroll`，并卸载依赖 |

---

## 4. 工具参考

插件注册 6 个工具。所有工具的输出均为 `{ text: string }`。

### 4.1 `feed_scroll`

拉取内容条目，自动跳过已读项，并按兴趣权重排序。

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `source` | string | `auto` | 内容源 ID，取值见 [6.2](#62-内容源) |
| `query` | string | — | 关键词或作者名；`source=bilibili-search` 时必填 |
| `count` | number | `6` | 返回条数，上限 10 |
| `sort` | string | `totalrank` | 仅 `bilibili-search` 生效：`totalrank` / `new` / `hot` |
| `mood` | string | — | 空格分隔的关键词，用于结果加权 |
| `include_seen` | boolean | `false` | 为 `true` 时包含已读条目 |

### 4.2 `feed_read`

读取单条内容的详情。

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `id` | string | — | `feed_scroll` 返回的条目 ID，或任意 http(s) 链接 |
| `parts` | string | 全部 | 逗号分隔：`text` / `comments` / `subtitles` / `frames` |
| `max_chars` | number | `1200` | 正文读取上限，最大 4000 |

### 4.3 `feed_share`

准备分享素材：下载封面图并记录分享状态。

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `id` | string | — | 条目 ID 或 http(s) 链接 |
| `comment` | string | — | 拟配文案，仅写入账本，不参与发送 |
| `send_image` | boolean | `true` | 为 `false` 时不下载封面，仅返回文本信息 |

返回结果包含封面图本地路径。发送动作由模型调用 `qqbot_send_file` 完成。

### 4.4 `grab_image`

将图片直链处理为可直接发送的本地文件。

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `url` | string | — | 图片直链（http/https） |
| `edge` | number | `300` | 长边目标像素；`0` 表示不缩放 |
| `referer` | string | 自动推断 | 覆盖默认 Referer（按来源域名推断） |

处理流程：按来源附加 Referer → 按文件头识别真实格式 → WebP 转 JPG/PNG（含透明通道转 PNG）→ 等比缩放 → 落盘至 `mediaDir`。

### 4.5 `feed_history`

查询近期浏览与分享记录。

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `limit` | number | `8` | 返回条数 |
| `only_shared` | boolean | `false` | 为 `true` 时仅返回已分享条目 |

### 4.6 `feed_watch`

管理计划任务。

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `action` | string | `list` | `add` / `list` / `pause` / `resume` / `remove` / `diag` / `recover` |
| `source` | string | `auto` | 计划任务使用的内容源 |
| `query` | string | — | 配合 `source=bilibili-search` 使用的关键词 |
| `every_minutes` | number | `80` | 执行间隔（分钟），最小 30 |

`diag` 输出会话服务可见性、agent 状态、会话记录与重建可行性；`recover` 按代价由低到高尝试恢复会话。

---

## 5. 配置

默认值定义于 `index.js` 的 `DEFAULTS`。在 profile 的 `cordis.patch.yml` 中按需覆盖，配置为深合并：

```yaml
- id: feed-scroll
  config:
    proactive:
      maxPerDay: 5
      defaultEveryMinutes: 120
      quietFrom: 9
    promptEnabled: true
```

| 配置项 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `stateDir` | string | `~/.dsh/feed-scroll` | 状态目录 |
| `mediaDir` | string | `~/.dsh-qqbot/media` | 封面与图片落盘目录，须位于 qqbot 发送白名单内 |
| `proactive.enabled` | boolean | `true` | 计划任务总开关 |
| `proactive.quietFrom` | number | `10` | 允许执行的起始小时 |
| `proactive.quietTo` | number | `23` | 允许执行的结束小时 |
| `proactive.maxPerDay` | number | `9` | 每目标每日唤醒上限 |
| `proactive.minGapMinutes` | number | `60` | 两次唤醒的最小间隔（分钟） |
| `proactive.defaultEveryMinutes` | number | `80` | 默认执行间隔（分钟） |
| `proactive.defaultSource` | string | `auto` | 默认内容源 |
| `proactive.allGroups` | boolean | `true` | 是否自动登记 qqbot 已知的全部群会话为目标 |
| `promptEnabled` | boolean | `true` | 是否注入内置提示词段（`order: 9500`） |
| `promptText` | string | 空 | 覆盖内置提示词段 |

---

## 6. 工作原理

### 6.1 数据流

```
触发（会话请求 / 计划任务）
  └─ feed_scroll   拉取条目 → 去重 → 排序
       └─ feed_read    读取正文 / 热评 / 字幕 / 关键帧
            └─ feed_share   下载封面 → 落盘 → 返回本地路径
                 └─ qqbot_send_file   发送图片消息
                      └─ 模型生成分享文案与链接
```

### 6.2 内容源

| 源 ID | 说明 |
| --- | --- |
| `bilibili-hot` | Bilibili 热门 |
| `bilibili-rank` | Bilibili 排行榜 |
| `bilibili-search` | Bilibili 搜索（配合 `query` 与 `sort`） |
| `bilibili-trending` | Bilibili 热搜词 |
| `zhihu-hot` | 知乎热榜 |
| `juejin` | 掘金推荐流 |
| `tieba-hot` | 贴吧热议 |
| `hackernews` | Hacker News 头条 |
| `sspai` | 少数派 |
| `ithome` | IT之家快讯 |
| `github` | GitHub 近期新建项目 |
| `auto` | 混合拉取并重新排序（默认） |

Bilibili 各接口的风控策略不一致（部分接口要求 Referer，部分接口附带 Referer 会返回错误码）。
实现上按多组请求头依次尝试，采用首个返回 `code=0` 的结果。

### 6.3 内容读取能力

| 站点 | 可读取内容 | 接口 |
| --- | --- | --- |
| Bilibili | 简介、作者、统计、分P、标签、热评、关键帧图、字幕 | `view`、`/x/v2/reply`、`/x/player/videoshot`、`/x/player/v2` |
| 少数派 | 摘要、正文 | `/api/v1/article/info/get` |
| Hacker News | 正文、评论 | Firebase `/v0/item/<id>.json` |
| 掘金 / IT之家 / 贴吧 | 正文 | HTML 正文抽取 |
| GitHub | README | `/repos/{owner}/{repo}/readme` |
| 其他网页 | 正文 | HTML 正文抽取 |
| 知乎 | 不支持 | 未登录访问返回 403，插件如实返回失败原因 |

Bilibili 关键帧接口返回 10×10 雪碧图（按时间顺序排列）。插件返回图片地址，由模型调用视觉工具分析；
多数视频的字幕需登录态，未获取到时返回明确说明。

### 6.4 计划任务与会话保活

- **目标登记**：当 agent 在某个 QQ 会话中首次使用本插件工具时，将该会话登记为推送目标。
  判定依据为宿主存在 `qqbot_send_file` 且最后一条用户消息不含 `rpcId`（Web 与桌面客户端消息含 `rpcId`），
  以此排除非 QQ 会话。登记时记录 `scope`、`peerId` 与 `replyTarget`。
- **会话恢复**：会话被回收或宿主重启后，通过 `qqbot-sessions` 服务调用 `manager.getOrCreate()` 从历史恢复会话。
  该服务由 `tools/patch-dsh-qqbot-manager.mjs` 对 `dsh-qqbot` 打补丁后提供；
  同时保留 `globalThis[Symbol.for('dsh.qqbot-sessions')]` 作为备用访问路径。
- **会话去重**：会话 `/new` 后会产生新的 session ID，账本按 peer 合并，避免同一目标重复唤醒。
- **唤醒消息**：使用 `agent.followup({ role: 'user', id, content, source })`。
  `role` 与 `id` 为必填字段，缺失会导致会话日志结构不合法，后续恢复失败。

### 6.5 状态与文件

| 路径 | 内容 |
| --- | --- |
| `~/.dsh/feed-scroll/state.json` | 账本：已读、近期、已分享、兴趣画像、推送目标 |
| `<mediaDir>/feed-*.jpg` | 封面图缓存 |
| `<mediaDir>/grab-*.jpg` | `grab_image` 落盘图片 |
| `~/.dsh-qqbot/model-prefs.json` | 只读：`qqbot:<appId>:<scope>:<peerId>` 与会话 ID 的映射 |
| `~/.dsh/qqbot-sessions.log` | 只读：补丁加载标记 |

---

## 7. 运维与故障排查

```powershell
node tools/fake-host.mjs        # 端到端自检（模拟宿主，覆盖全部工具）
node tools/smoke.mjs --cover    # 内容源连通性与封面下载
node tools/test-grab.mjs        # 图片处理链路
node tools/probe-tools.mjs      # 校验运行中的宿主是否已加载插件
node tools/install.mjs --check  # 安装状态与配置项检查
```

| 现象 | 可能原因 | 处理 |
| --- | --- | --- |
| 工具未出现在工具表中 | 插件未安装或未重载 | 检查 profile 的 `bundles` 与 `cordis.patch.yml`，重启 DSH |
| 计划任务未触发 | 会话已被回收；补丁未加载 | 执行 `feed_watch action=diag` 定位；`action=recover` 修复；确认补丁脚本已执行 |
| 分享无封面图 | 目标站点无封面或下载失败 | 预期降级，仅发送文本与链接 |
| 图片发送失败 | `mediaDir` 不在 qqbot 发送白名单内 | 将 `mediaDir` 指向白名单目录 |
| WebP 未转码 | profile 未安装 `sharp` | 安装 `sharp`，或接受回退至 `qqbot_send_file` 处理 |
| 内容源请求超时 | 当前网络环境不可达 | 更换 `source`；部分站点在特定网络环境下不可用 |
| 修改源码后未生效 | 热重载存在延迟；ESM 模块缓存 | 重启 DSH；`feed_watch action=diag` 输出 `rev` 可用于确认运行版本 |

会话日志结构异常时（缺少 `id`/`role` 的消息事件），可使用 `tools/repair-session-log.mjs` 修复：

```powershell
node tools/repair-session-log.mjs <session.v4.jsonl.zstd>          # 预演
node tools/repair-session-log.mjs <session.v4.jsonl.zstd> --apply  # 写回（自动备份）
```

---

## 8. 安全与隐私

- **网络访问**：仅访问上述站点的公开接口。不向第三方服务发送本地文件、会话内容或凭据。
- **凭据**：本插件不使用任何 API Key。
- **数据落盘**：状态文件与图片缓存；账本不记录会话正文。
- **本地读取**：为确定推送目标，读取 `dsh-qqbot` 的会话记录与映射文件，不修改其内容。
- **主动消息**：向群会话主动发送消息受 QQ 平台权限控制，需群管理员开启机器人主动发言权限。

---

## 9. 已知限制

- 知乎正文读取不可用（需登录态），插件返回明确失败信息而非占位内容。
- 不提供视频与音频下载及语音识别能力。
- 计划任务依赖 `dsh-qqbot` 的会话保活机制与配套补丁；该补丁在 `dsh-qqbot` 升级后需重新执行。
- 部分站点（V2EX、Reddit、RSSHub、linux.do 等）在部分网络环境下不可达，未纳入默认内容源。
- 微博接口返回 403；Bilibili 作者空间接口受 WBI 风控限制，作者更新通过搜索接口的 `sort=new` 实现。

---

## 10. 开发

### 10.1 目录结构

```
index.js                插件入口：工具注册、提示词段、计划任务
lib/sources.js          内容源、混合拉取、兴趣加权、链接反查
lib/read.js             内容读取与正文抽取
lib/store.js            账本读写（原子写入）
lib/card.js             封面图下载与落盘
lib/grab.js             图片处理（Referer、格式识别、转码、缩放）
lib/http.js             HTTP 封装（UA、超时、重试、风控页识别）
lib/text.js             文本处理（去标签、截断、格式化、关键词提取）
tools/                  安装、补丁、自检与诊断脚本
locale/{zh,en}.json     插件市场展示信息
```

### 10.2 本地验证

```powershell
node tools/fake-host.mjs --no-network   # 不依赖网络的接线验证
node tools/smoke.mjs --cover            # 内容源与封面链路
node tools/test-grab.mjs                # 图片处理链路
```

提交前请确保上述脚本通过。

---

## 11. 许可证

[MIT](LICENSE)

---

## English Overview

**dsh-feed-scroll** is a DeepSeek Harness plugin that aggregates content from Bilibili, Zhihu, Juejin,
Tieba, Hacker News, SSPAI, ITHome and GitHub, and shares selected items to a chat session as a cover
image plus link. The plugin prepares media and maintains state; the accompanying text is generated by
the model.

It registers six tools — `feed_scroll`, `feed_read`, `feed_share`, `grab_image`, `feed_history` and
`feed_watch` — and supports scheduled execution (default: every 80 minutes, 10:00–23:00, up to 9 runs
per day). Requirements: DSH `>= 0.1.7-rc.1`, Node.js `>= 22.13.0`, and optionally
`@tencent-connect/dsh-qqbot` `>= 0.5.0` for the sharing path.

```bash
dsh plugin --profile web add github:ChencLi819/dsh-feed-scroll
```

Licensed under the MIT License.
