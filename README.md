# bns-bot — 币安广场自动发帖（GitHub Actions 纯云端）

抓取行情异动 / 新币 / 热搜榜 / 涨跌榜 / 资讯 RSS → 生成带 `$币种` 的帖子 → 调广场 OpenAPI 发布。
**只跑云端**: CNB 定时流水线每小时 POST `workflow_dispatch`, 由 GitHub Actions
唤起一个短进程, 跑一轮就退出; 没有常驻服务、没有长连接, 本机不留启动脚本和计划任务。
**执行端留在 GitHub Actions**（CNB runner 实测连不上发帖域名, 见「外部定时器」一节）;
主触发是 CNB 定时器（每小时 POST `workflow_dispatch`）; GitHub 自带 `schedule` 已移除（best-effort、时好时坏, 且与 CNB 节奏重叠纯属冗余）。`cron-job.org` 是可选的境外冗余（尚未配置）。
配置分两份: 仓库里的 `config.json`（入库的基准配置, 不含 OpenAPI Key, 所有可调参数都在这里）和 Secret `BNS_CONFIG`, 状态靠 `state.json` 持久化。

## 文件

| 文件 | 说明 |
|---|---|
| `.github/workflows/bot.yml` | 云端**执行端**: 由 CNB 定时器每小时触发, 把 Secret 里的 Key 注入 config.json、跑一轮 bot、提交 `state.json` |
| `.cnb.yml` | CNB 触发器配置: `crontab` 定时 + `web_trigger` 手动触发 |
| `trigger-workflow.mjs` | CNB 流水线执行的脚本: POST `workflow_dispatch`, 带重试与失败标红 |
| `.github/workflows/probe.yml` | `probe-binance` 只读网络诊断(手动触发, 不发帖) |
| `bot.js` | 主程序, 跑一轮即退出 |
| `templates.js` | 帖子词库 |
| `symbolPool.js` | 按 24h 成交额筛选币种池 |
| `config.json` | **入库的基准配置**(不含 OpenAPI Key, 所有可调参数在此); CI 由 workflow 注入 Key |
| `config.local.json` | 本地调试用(含 Key, `.gitignore` 排除, 不入库); `bot.js` 优先读它 |
| `state.json` | 运行状态(自动维护, 别手动改); 当日币种池也存在这里 |
| `imageCard.js` | 用 `@napi-rs/canvas` 生成行情卡片 PNG |
| `squareMedia.js` | 币安广场图片上传(presignedUrl → S3 PUT → imageStatus 轮询) |
| `package.json` | 声明 `@napi-rs/canvas` 运行时依赖, Actions 里 `npm install` |

## 命令

本地调试: 放一份 `config.local.json`（含你的 OpenAPI Key, 与 `config.json` 同结构, 仅 `openApiKey` 填真值）;
`bot.js` 会优先读它, 且它已被 `.gitignore` 排除, 不会入库泄露。云端由 workflow 注入 Key, 不用这一步。

```bash
node bot.js            # 跑一轮: 判节奏 → 到点才抓接口 → 抓完就发 → 退出
node bot.js --once     # 同上, --once 只是兼容 workflow 写法的参数
node bot.js --force    # 没素材时用实时行情造一条(仍受时间线约束)
node bot.js --test     # 发一条测试帖验发帖接口
node bot.js --test-image # 生成行情卡片图并带图发一条测试帖, 验图片链路(Actions 里勾 test_image)
```

日常不用手动执行, `Actions → bns-bot → Run workflow` 即可触发一轮。
`--force` 和 `--once` 可组合: `node bot.js --once --force`; `--force` 只在时间线
允许发帖时才生效, 不会绕过节奏, **但会绕过 `dryRun` 真发帖**（判断是
`if (config.dryRun && !forceMode)`）。线上 `dryRun=false` 用不到这个区别,
本地调试别把 `--force` 当成「只生成不发送」。

## 节奏参数

`config.json` 里（**轮次频率由外部定时器 CNB `crontab` 决定**, 不在配置里;
GitHub 自带 `schedule` 已移除, 仅 CNB 触发）:

| 字段 | 说明 |
|---|---|
| `postsPerDay` | 每天最多发几帖(非时间线模式用) |
| `minIntervalMinutes` | 两帖最小间隔(非时间线模式用) |
| `schedule.enabled` | `true` 走时间线排期 |
| `schedule.evenSpread` | **`true` = 全天 24 小时均分, 无静默期**; 详见下节 |
| `schedule.maxPerDay` | 一天几个 slot(均分间隔 = `1440 / maxPerDay`) |
| `schedule.startHour` / `intervalMinutes` / `quiet` | 仅 `evenSpread=false` 时生效 |
| `market.symbols` | 初始监控币种; **每天按成交额自动覆盖**(结果存 `state.json`) |
| `market.symbolPool` | 可选: 自动刷新的 `topN` / `minUsd` / `autoRefresh`; 不写用默认 16 个 / 3000 万 USDT |
| `market.priceChangePct` | N 分钟内涨跌多少算异动 |
| `market.volSpikeMultiple` | 成交量放大几倍才算(避免假异动) |
| `post.hashtags` | 追加到每条帖子的**全局通用**话题, 默认留空; 各类型帖子已自带贴切标签, 别填类型专属标签 |
| `post.disclaimer` | 帖子结尾追加的免责声明 |
| `post.take` | 是否在帖子里加**数据解读段 + 开放式提问**, 默认 `true`; 设 `false` 可一键退回纯短文案 |

### 文案结构与字数

币安官方《新手指南》: **短帖上限 2,100 字符**（长文 80,000）。官方创作者学院
《How to Post for Better Reach》明确说 "word count isn't the point"，真正影响推荐的是
**有没有自己的判断**（建议至少 50 words）、开头 3 秒能否抓住人、以及不踩
「纯搬运 / 重复快讯刷屏 / 过度 emoji / BREAKING 式标题党」这些红线。

所以五类帖子统一按下面结构生成，不是靠灌水凑字数：

```
数据 / 事件（首行钩子）
↓
解读段（takes.js：只从素材已有字段推导，不编造数据、不给买卖建议）
↓
收尾话术（templates.js 词库随机）
↓
开放式提问 CTA（收尾本身已是问句时不叠加）
↓
标签行
```

- 实际约 **150–350 字符**，远低于 2,100 上限；`buildPost` 里 950 的截断只是兜底。
- 翻译失败回退的英文资讯帖**不加中文解读段和 CTA**，避免再叠加中文；原有的中文收尾话术与标签保持不变（与改动前一致）。
- 不显示文章来源平台名，不输出外链，配图/去重/发帖频率均不受影响。

### 24 小时均分排期（当前默认）

`schedule` 写成:

```json
"schedule": {
  "enabled": true,
  "evenSpread": true,
  "maxPerDay": 15,
  "timezone": "Asia/Shanghai"
}
```

间隔 = `1440 / maxPerDay` 分钟。当前 15 帖即 **96 分钟一个 slot**, 从本地 0:00 铺到 24:00:
`0:00 / 1:36 / 3:12 / 4:48 / 6:24 / 8:00 / 9:36 / 11:12 / 12:48 / 14:24 / 16:00 / 17:36 / 19:12 / 20:48 / 22:24`。
**没有静默期**; 改 `maxPerDay` 会自动重算间隔, 不用手动改别处。
把 `evenSpread` 设成 `false` 就回到旧的 `startHour` + `intervalMinutes` + `quiet` 写法。

> 配置分两份: 仓库里的 **`config.json`** 是入库的基准配置（不含 Key, 所有可调参数如 market 阈值、
> imageCard、发帖节奏都在这里, 改了提交即生效）; **`BNS_CONFIG`** 这个 Secret **只存 OpenAPI Key**
> （一个字符串, 不再存整份 JSON）, 运行时由 workflow 注入到 `config.json` 的 `openApiKey`。
> 想改参数直接改 `config.json` 提交即可。

## 限流

币安广场官方上限 100 帖/天。当前默认走 `schedule.evenSpread` 时间线模式,
实际每日上限是 **`schedule.maxPerDay`**（默认 15）; `postsPerDay` / `minIntervalMinutes`
只在 `schedule.enabled=false` 的非时间线模式下生效。
新号建议把 `maxPerDay` 降到 10 起步, 一周没被限流再往 15-20 提。

## 风控错误码

| code | 含义 | 处理 |
|---|---|---|
| 20002 / 20022 | 敏感词 | 检查帖子内容, 加 `post.disclaimer` 或改词库 |
| 220009 | 当日限额 | 停到明天 |
| 30008 | 违规禁言 | 去币安 App 申诉 |
| 220004 | Key 过期 | 重新生成 Key 后更新 Secret BNS_CONFIG（本地调试则改 config.local.json） |

## 日志

在 `Actions → bns-bot → 对应运行记录 → cycle` 里看, 公开仓库的日志含帖子全文。
本地不产生 `bot.log`。

## 图片帖（卡片配图）

行情异动、热搜榜、涨跌榜、新币四类素材会自动各配一张**卡片图**，提升广场曝光：

| 素材 | 卡片内容 |
|---|---|
| 行情异动 | 币种 + 涨跌幅 + 现价 + 量比 + 时间（绿涨红跌） |
| 热搜榜 | CoinGecko 24h 热搜 Top6：排名 + 币种 + 24h 涨跌幅 |
| 涨跌榜 | 全市场 24h 领涨 / 领跌各 Top5，双列展示 |
| 新币 | 币种 + 交易对 + 上线天数 |

四张卡片共用同一套视觉规格（1080×1080 深色底、绿涨红跌、CST 时间、底部免责条）。
资讯帖不生成卡片，但若 RSS 自带 jpg/png 配图则下载后随帖发一张；都不满足时发纯文本。

- **图从哪来**：在 GitHub Actions runner 本地用 `@napi-rs/canvas` 生成 PNG，再走币安自己的
  接口上传，**不依赖图床、不占 Cloudflare / GitHub 私有库额度、不新增账号**，也不消耗发帖额度。
- **上传流程**（参数来自官方 `binance-skills-hub` 的 `square-post` 源码）：
  1. `POST …/composite/v2/…/image/presignedUrl` 拿一次性 `presignedUrl` + `fileTicket`；
  2. `PUT` 二进制直接传到该 S3 地址；
  3. `POST …/v2/…/image/imageStatus` 轮询（最多 10 次、间隔 3 秒）拿到 `imageUrl`；
  4. 发帖走 `…/v1/…/content/add`，图片短帖为 `contentType:1` + `imageList:[url]`（最多 4 张）。
- **失败降级**：卡片生成、上传或发布任一步失败，自动回退为纯文本发帖，不影响发帖链路；
  日志打印 `配图失败, 降级纯文本: …`。`--test` 只发纯文本测试帖，`--test-image` 专门验证图片链路。
- **开关**：`config.post.imageCard`（默认 `true`）。只想发纯文本就设 `false`。
- **额度**：币安广场每日上传限额 400 次，本项目最多 15 帖/天，余量充足。
- **字体**：卡片只用英文 / 数字，避免中文字体依赖；完整中文免责声明仍放在文字帖正文。
  Actions 已确保安装 `fonts-dejavu-core`，本地若缺失字会渲染不出（不影响纯文本帖）。

## 部署到 GitHub Actions（公开仓库）

CNB 定时器每小时触发一次, GitHub Actions 才跑一轮 `node bot.js --once`
（`--once` 只是兼容参数, 不写也是跑一轮就退出）; `bot.yml` 由 CNB 定时器每小时触发（手动 Run workflow 亦可）。
**仓库必须是 Public**: 公开仓库的标准 runner 免费且不限分钟数, 不消耗私有库每月 2000 分钟额度;
私有库按这个频率约 **2880 次运行/月**（96 次/天 × 30 天）, 即便每轮只有几十秒,
累计也很容易打爆额度并拖停其他 workflow。

> ⚠️ 公开仓库里**代码、`templates.js` 词库、`state.json`、运行日志（含帖子全文）、`config.json`
> （基准配置, **不含 Key**）全部公开**。真正的 OpenAPI Key 只在 Secret `BNS_CONFIG`（一个字符串）,
> 以及你本地的 `config.local.json`（`.gitignore` 已排除, 不入库）。
> 推送前 `git ls-files` 确认没有 `config.local.json`; 若历史上曾提交过含 Key 的文件, 先去币安重新生成 Key。

### 步骤

1. 先提交本次改动, 在 GitHub 新建一个**公开**空仓库并推上去
   （现有 `origin` 是 cnb.cool, 另加一个远程; 推到 `main` 以对齐 GitHub 新仓库的默认分支）:

   ```bash
   git add .gitignore README.md bot.js templates.js symbolPool.js config.json .github/workflows/bot.yml .github/workflows/probe.yml .cnb.yml trigger-workflow.mjs state.json
   git commit -m "chore: GitHub Actions 部署"
   git remote add github https://github.com/<你的用户名>/<仓库名>.git
   git push github master:main
   ```

   推完确认默认分支（`Settings → Branches`）上能看到 `.github/workflows/bot.yml`
   —— **定时调度只在默认分支生效**。`state.json` 建议一起提交以保留去重记录;
   想从零开始就先删掉它再提交。

2. `Settings → Secrets and variables → Actions`, 停在 **Secrets** 标签页
   （**不要切到 Variables**: 变量是明文, 公开仓库会把 Key 暴露, 且 workflow 读的是
   `secrets.BNS_CONFIG` 而不是 `vars.*`）。

   在页面下半部分的 **Repository secrets** 区块点绿色 **New repository secret**
   （**不要点上面的 Manage environment secrets**: 环境级 Secret 需要 job 里声明
   `environment:` 才会注入, 本 workflow 没有配, 填那里读不到）。

   - Name: `BNS_CONFIG`（区分大小写, 对应 workflow 里的 `secrets.BNS_CONFIG`）
   - Secret: **只填你的 OpenAPI Key 字符串**（不再存整份 JSON）; 所有可调参数都在仓库的
     `config.json` 里, 改完提交即生效, 不用改 Secret。
   - 点 **Add secret**。Secret 保存后不能再查看; 以后换 Key 时把这里覆盖成新 Key 即可。

3. `Settings → Actions → General → Workflow permissions` 选 **Read and write permissions**
   （workflow 需要把 `state.json` 推回仓库）。

4. `Actions → bns-bot → Run workflow` 手动跑一次, 看日志是否正常。
   只有落在 slot 窗口内、且 `state.json` 真有变化的轮次才会多一条
   `persist bot state` 提交; 空转轮次没有 commit 属正常。

## 外部定时器（主触发, 已上线）

GitHub 自带的 `schedule` 是 best-effort 投递: 2026-11-11 曾连续 9 小时不触发、恢复时成批补发,
11-12 又断了 5 小时 41 分; 官方文档也明确「高负载时可能延迟甚至丢弃」。
`bot.yml` 的 `on.schedule` 整段已删除; 主触发是 CNB 定时流水线每小时 POST
`workflow_dispatch`（2026-11-12 已验证: CNB 日志 `HTTP 204`, GitHub Actions 约 9 秒后起跑）。
`cron-job.org` 是**可选的境外冗余, 目前尚未配置**, 配置清单见第 5 节。

> **执行端仍在 GitHub Actions**: 2026-11-12 在 CNB runner 实测, `www.binance.com/bapi`
> 五次连测全部 `UND_ERR_CONNECT_TIMEOUT`(约 10.49s, 耗时高度一致), `binance.com` 与
> `api.binance.com` 也超时; 而 `api.github.com` 5/5 200(median 47ms)。
> `data-api.binance.vision` 可达, 但它只是现货行情镜像, 不能替代发帖 BAPI。
> 发帖接口在 `www.binance.com` 上, 所以 CNB **只能当触发器, 不能跑 bot**。

### 1. 创建 fine-grained PAT

右上角头像 → **Settings** → 左侧栏最底部 **Developer settings** →
**Personal access tokens** → **Fine-grained tokens** → **Generate new token**:

- **Token name**: 如 `bns-bot-external-cron`
- **Expiration**: 选 90 天, **不要选 No expiration**; 到期前重新生成并替换定时器里的值
- **Resource owner**: `yuzhiblue`
- **Repository access**: 选 **Only select repositories** → 只勾 `bns-bot`
  （**不要选 All repositories**）
- **Permissions** → 展开 **Repository permissions** → **Actions** 设为 **Read and write**;
  其余全部保持 No access（**不要勾 Contents / Administration**）
- 点 **Generate token**, 复制 `github_pat_...` 整串（只显示一次）

> 官方 REST 文档: `POST /actions/workflows/{id}/dispatches` 只需 `Actions: write`。
> 该 token 只能触发 workflow, 不能改代码、读 Secret、发 Issue。
> 它要存进 CNB 密钥仓库(或第三方定时器服务), 所以务必单仓库 + 短有效期 + 定期轮换。

### 2. 定时器配置

| 项 | 值 |
|---|---|
| URL | `https://api.github.com/repos/yuzhiblue/bns-bot/actions/workflows/bot.yml/dispatches` |
| Method | `POST` |
| Header `Authorization` | `Bearer github_pat_...` |
| Header `Accept` | `application/vnd.github+json` |
| Header `Content-Type` | `application/json` |
| Body | `{"ref":"main","inputs":{"source":"cnb"}}`（`cron-job.org` 那条填 `cron-job.org`） |
| 频率 | 每小时, `:08`（与 CNB `crontab` 分钟对齐） |

`inputs.source` 只用于辨识来源: 运行列表标题分别是
`cycle · cnb`（CNB 定时器）、`cycle · cron-job.org`（境外冗余）、
`cycle · manual`（手动跑）。
不传 `test_post`（默认 `false`）, 走 `node bot.js --once`。

外部每小时敲一次门是安全的: bot 内部 `evenSpread` / `maxPerDay=24` 自己判断到不到发帖 slot,
没到点就零请求退出, 重复或提前触发都不会超额发帖。

### 3. 落地 CNB 触发器（主方案, 2026-11-12 已配置并验证）

`.cnb.yml` 与 `trigger-workflow.mjs` 已在仓库里: `crontab: 8 * * * *` 按
`Asia/Shanghai` 触发, 脚本带 3 次重试、4xx 快速失败、失败 `exit 1` 让构建标红。
**这套链路已跑通**: CNB 日志 `HTTP 204`（约 1.9s）, `Actions → bns-bot` 随即出现
`cycle · cnb` 并执行 `node bot.js --once`。以下是已完成的配置, 供重建 / 排障对照。

**① 密钥仓库**: `https://cnb.cool/yuzhiblue/bns-bot-secrets`, 类型是 **密钥仓库**
（**不是普通仓库**; 密钥仓库禁止本地 clone / push, 只能 Web 端编辑, 带动态水印与审计日志）。

**② 密钥文件**: 在密钥仓库 Web 端建 `dispatch.yml`（默认分支 `main`、文件名已确认）, 内容:

```yaml
BNS_DISPATCH_TOKEN: "github_pat_..."
```

> 默认只有密钥仓库的**管理员 / 负责人**成员触发的流水线能引用该文件。
> CNB `crontab` 以「最后修改该配置的用户」身份触发, 所以让创建密钥仓库的账号去推
> `.cnb.yml` 即可满足; 若以后换账号改 crontab, 需在密钥文件里配 `allow_slugs` 等授权。
> 脚本不会把 token 打进日志。

**③ `.cnb.yml` 两处 `imports`** 已指向
`https://cnb.cool/yuzhiblue/bns-bot-secrets/-/blob/main/dispatch.yml`。
密钥仓库按设计禁止 git clone / ls-remote, 只能在 Web 端确认。

手动验证: 在 CNB 仓库页面用 **手动触发 / 自定义按钮** 选 `web_trigger` 跑一次,
到 `Actions → bns-bot` 看是否出现 `cycle · cnb`。

> ⚠️ `HTTP 204` / 「触发成功」只代表 **workflow 被唤起**, 不代表这一轮发了帖。
> 没到时间线 slot 的轮次打印「时间线 slot ... 未到, 本轮不抓接口也不发帖」属正常;
> 判断发帖链路要看 GitHub Actions 里 bot 的具体日志（见文末「当前状态与验证方式」）。

**仍待办**: 在 CNB 仓库设置里开启**构建失败通知**（钉钉 / 企业微信 / 邮件, 入口以页面为准）——
脚本失败会让构建标红, 不会像 GitHub schedule 那样静默丢; 另观察 `crontab` 一两天,
确认 `:08` 都按时触发。

CNB 与可选的 cron-job.org 分钟数对齐, 同时打也安全: bot 内部 slot 判断 +
`concurrency` 保证不重复发帖。

### 4. 免费定时器候选

| 服务 | 免费 | 最小间隔 | 自定义 Header | POST + Body | 备注 |
|---|---|---|---|---|---|
| **CNB 定时流水线** | 已有 `cnb.cool` 仓库和账号 | 5 分钟 | 不需要(密钥仓库 `imports` 注入) | ✅ | **主方案, 已配置并验证**; 实测到 `api.github.com` 5/5 200(median 47ms); 时区 `Asia/Shanghai`; PAT 存密钥仓库不交第三方 |
| **cron-job.org** | 完全免费, 无需信用卡 | 1 分钟(每 job ≤ 60 次/小时) | ✅ 任意(`User-Agent`/`Connection` 会被忽略) | ✅ | **可选境外冗余, 尚未配置**; job 数不限, 失败邮件告警, 连续失败超过 25 次可能自动停用 |
| Cloudflare Workers Cron | 免费 10 万次/天 | 1 分钟 | ✅ | ✅ | 占 CF 账号额度、每账号仅 5 个 Cron, 本项目不优先 |
| Upstash QStash / FastCron / EasyCron | 有免费层 | 1 分钟 | ✅ | ✅ | 需注册新账号, 额度按消息数, 免费政策未逐一核实 |
| UptimeRobot / Better Stack / Healthchecks.io | 免费层 | 5 分钟起 | ❌ | ❌ | 监控型, 免费层只发 GET/HEAD, **带不了 `Authorization`, 直接排除** |
| Vercel Cron / Google Cloud Scheduler / AWS EventBridge | 有免费层 | — | ✅ | ✅ | 免费版定时粒度按天或需绑信用卡 + 云项目, 不满足本场景 |

> cron-job.org 单次请求超时 30 秒、响应上限 64 KB; GitHub dispatches 接口几乎瞬时返回, 不构成问题。
> 它同样不承诺准点（高峰期可能延迟）, 但比 GitHub schedule 的整段停摆可控得多。
> 其 FAQ 只公布**当前** executor 出口 IP 列表, **不保证固定、可能变化**, 不是可靠的白名单依据;
> CNB 出口 IP 实测也是**动态的**（两次探针分别是 `45.40.228.119` / `42.193.175.155`）,
> 别指望靠白名单解决问题; `crontab` 最小间隔 5 分钟, 触发身份是「最后修改该配置的用户」,
> 该用户被移出仓库会导致任务失败。

### 5. 可选境外冗余: cron-job.org 配置清单（尚未配置）

如要在 CNB 主触发之外**再**加一个境外出口的第二触发源, 可按本节配置;
目前**尚未创建这个 job**。服务完全免费、无需信用卡,
最小间隔 1 分钟、支持任意自定义 Header 与 POST body。

**① 单独建一个 PAT**（不要复用 CNB 那个, 方便单独吊销）: 按第 1 节步骤,
Token name 填 `bns-bot-cron-job-org`, 其余相同（只勾 `bns-bot`、`Actions: Read and write`、90 天）。

**② 注册并登录** `https://cron-job.org` → 点 **Create Cronjob**。

**③ 基本信息**:

| 字段 | 值 |
|---|---|
| Title | `bns-bot dispatch` |
| URL | `https://api.github.com/repos/yuzhiblue/bns-bot/actions/workflows/bot.yml/dispatches` |

**④ 执行计划**: 选自定义 schedule, 分钟填 `8, 23, 38, 53`; 小时 / 日 / 月 / 星期都选
「每小时 / 每天 / 每月 / 每天」（REST API 里即 `hours: [-1]` 等）,
与 CNB `crontab` 的分钟对齐。

**⑤ 展开 Advanced（高级）**, 填:

| 字段 | 值 |
|---|---|
| Request method | `POST` |
| Time zone | `Asia/Shanghai` |
| Request headers | 加三行: `Authorization` = `Bearer github_pat_...`、`Accept` = `application/vnd.github+json`、`Content-Type` = `application/json` |
| Request body | `{"ref":"main","inputs":{"source":"cron-job.org"}}` |

> 页面字段标签可能略有差异, 以你看到的为准; 关键是 **Request method / Time zone / headers / body**
> 这四项都在 Advanced 区块里。`User-Agent` 与 `Connection` 即使填了也会被忽略
> （官方 FAQ 原文: will be ignored）, 我们也不需要。
> **不要用 GET**、不要把它建成「监控 / 健康检查」类型, 也不要改用 classic token（权限更大）。

**⑥ 开启失败通知**: 在 job 设置里打开 `onFailure`（失败时邮件通知）。
官方 FAQ 说「连续失败超过 25 次」的 job 可能被自动停用（subsequently fails more than 25 times）,
该事件也可邮件通知; 别让它长期静默失败。

**⑦ 保存后手动执行一次**（列表里的执行按钮）, 去 `Actions → bns-bot` 看有没有
`cycle · cron-job.org` 的运行。

> 单次请求超时 30 秒、响应上限 64 KB, GitHub dispatches 几乎瞬时返回, 不构成问题。
> 它同样不承诺准点（高峰期可能延迟）, 但出口在境外, 与 CNB 的国内出口互为备份;
> 执行历史保留最近 50 次详情, 响应 headers / bodies 另存 2 天, 便于事后核对哪一次漏了。

### 6. 验证与收尾

- CNB 主触发已验证（见第 3 节）。若之后配了 `cron-job.org`, 等 15~20 分钟看
  `Actions → bns-bot` 有没有 `cycle · cron-job.org`, 点进去看 `Trigger info` 打印的
  `event=workflow_dispatch`。
- 确认外部定时器稳定跑一两天后, GitHub 自带 `schedule` 已移除(`bot.yml` 的 `on.schedule` 整段已删除),
  避免兜底 cron 与外部触发源叠加; 主触发仅 CNB, 可选境外冗余 `cron-job.org` 未配置。

### 运行机制

- 主触发是 **CNB 定时流水线** POST `workflow_dispatch`（每小时, 见上节）;
  GitHub 自带 `schedule` 已移除（best-effort、时好时坏且与 CNB 重叠）。
  定时调度常延迟甚至整段漏跑, 时间线排期的「只追发最近 1 个 slot」逻辑能容错。
- **抓取节奏**: bot 先判断时间线 slot, 没到点就**零请求退出、不改 `state.json`、不产生 commit**;
  只有每个 slot 才抓一次接口, 并用 `state.lastFetchAt` 的时间冷却（一个间隔减 20 分钟余量）保证
  同一 slot 不重复抓、连续没素材也会按周期继续尝试。接口调用量约从 96 次/天降到
  `maxPerDay` 次/天（当前 15 次/天, 币种池刷新另加 1 次/天）; 代价是两次 slot 之间发生的异动要等到下个 slot 才看。
- **选帖**: 每轮最多发 1 条。多条素材按热度评分取最高的一条（行情看涨跌幅与量比、
  新币看上线新鲜度, 热搜榜 / 涨跌榜 / 资讯按类型给基础分, 全部叠加新鲜度加权）。
  日志会打印各候选分数; 没有素材就不发。
- `state.json` 只在真正抓取过的轮次被 commit 回仓库, 用于持久化去重记录、当日发帖数、
  时间线进度、`lastFetchAt` 和当日币种池; 每天十几次 push 也足以保持仓库活动,
  避免公开仓库「60 天无活动自动禁用定时 workflow」。
- `TZ=Asia/Shanghai` 由 workflow 设置, 日志和「今天」的判定与本地一致。
- **无常驻进程、无长连接**: 每轮一次性拉取所需接口与 RSS, 跑完当轮即退出;
  单个信源失败会自动降级为空, 不影响其他素材。

### 监控币种池自动刷新

GitHub Actions 每次新建 runner, config.json 里的 `market.symbols` 只是**初始快照**。
bot 在**每天第一次到点轮次**拉一次全所 `ticker/24hr`, 按 24h 成交额取前 `topN`
（默认 16）个成交额 ≥ `minUsd`（默认 3000 万 USDT）的 USDT 交易对,
排除稳定币包装 / ETF 股票包装 / 代币化黄金 / 跨链桥等壳币。结果写进 `state.json` 的
`symbols` / `symbolsUpdatedAt` / `symbolsMeta`, 抓取时用 `state.symbols` 覆盖
`config.market.symbols`; 因为 `state.json` 每轮 commit 回仓库, 新 runner 能接着用。

- **不需要改 config.json、不需要新 workflow**; 每天只多 1 次请求, 空转轮次仍然零请求。
- 刷新失败会沿用上次的池子（没有则沿用 Secret 初始值）, **不阻断发帖**, 下个 slot 再试;
  日志分别显示 `币种池: 今日首次刷新…` / `今日已刷新, 沿用…` / `刷新失败…`。
- 想调参数: 在 `config.json` 的 `market` 里加
  `"symbolPool": { "topN": 16, "minUsd": 30000000 }`; 加 `"autoRefresh": false` 可关掉。
  不写这些字段也能正常工作（用默认值, 或复用 `_symbolsAuto` 里记录的上次参数）。
- 筛选规则集中在 `symbolPool.js`, 写成纯函数便于离线验证; 没有第二套本地刷新脚本。

### 451 地区封锁排查（GitHub runner, 2026-11-11 已实测）

> 这是 **GitHub runner 出口**的地区封锁结论, 与「CNB 能不能跑 bot」是两回事:
> 2026-11-12 的 CNB 探测结论见「外部定时器」一节（CNB 连发帖域名都连不上, 只能当触发器）。

GitHub runner 的出口 IP 在美国, `api.binance.com` 与 `fapi.binance.com` 全部返回
**HTTP 451**。各抓取函数把失败 `catch` 掉了, 所以**所有接口 451 时 job 依然是绿色**
（假绿）, 当时只会刷「拉取失败: HTTP 451」, 彼时靠 `alternative.me` 的恐惧贪婪指数撑发帖量。

`Actions → probe-binance → Run workflow` 是只读探针（不发帖、不读 Secret、不改 `state.json`）。
实测结果与当时的处理:

| 域名 | 状态 | 处理 |
|---|---|---|
| `api.binance.com`（K线 / exchangeInfo） | 451 | 统一改用官方镜像 `data-api.binance.vision`（探针实测 200） |
| `fapi.binance.com`（资金费率 / 多空比） | 451 | 没有等价镜像（`/fapi/...` 在 vision 上 404）; 这两个素材源现已移除 |
| `www.binance.com/bapi`（发帖） | 400 + JSON 业务错误 | ✅ 没被地区封锁, 可以发帖 |
| OKX / Bybit | ERR / 403 | 也不通, 不作备选 |

以上是 2026-11-11 的历史排查结论。现货行情（K线 / exchangeInfo / ticker）
现已统一走 `data-api.binance.vision`; 资金费率 / 多空比 / 恐惧贪婪 / 公告
四个素材源此后已全部移除（代码与配置中均无对应项）。
**当前实际会有内容的素材源**: 行情异动、新币、热搜榜、涨跌榜、资讯 RSS。

**发帖链路已验证通过**: 2026-11-11 用 `test_post` 跑 `node bot.js --test` 真发成功
（`id=386976997232534`）, 说明 OpenAPI Key 有效、发帖域名没被封、无设备风控。

当前状态与验证方式（2026-11-11 正式上线, config.json 里 `dryRun=false`;
2026-11-12 起主触发改为 CNB 定时流水线, 链路已验证）:

1. `Actions → bns-bot → Run workflow` 不勾选 **test_post**, 手动跑一轮看日志。
   注意**只有落在 slot 窗口内的轮次才会抓接口**; 其它轮次日志是
   「时间线: ... 本轮不抓接口也不发帖」, 属正常。到点的轮次应看到 `行情 XXX: 60min ...`
   而不是「拉取失败」。
2. （可选复验）`Actions → bns-bot → Run workflow` 勾选 **test_post**
   （执行 `node bot.js --test`）, 真发一条测试帖验 Key 与风控。
3. 判断链路是否通要看具体日志行（`行情` / `素材` / `✅ 发帖成功` / `chore: persist bot state`）;
   所有抓取失败都被 catch 吞掉, **job 绿色不等于链路通**。
4. **CNB 触发成功 ≠ 发帖成功**: CNB 日志的 `HTTP 204` 只说明 `workflow_dispatch` 被接受,
   要确认真的抓了接口 / 发了帖, 必须看对应 GitHub Actions 运行里 `Run one cycle` 的日志。
   空转轮次（「时间线 slot ... 未到」）不发任何请求, 属预期行为。
