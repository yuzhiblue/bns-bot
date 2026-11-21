# bns-bot — 币安广场自动发帖（GitHub Actions 纯云端）

抓取行情异动 / 热搜榜 / 涨跌榜 / 资讯 RSS / 形态突破 / 币安合约涨跌榜 → 生成带 `$币种` 的帖子 → 调广场 OpenAPI 发布。
**只跑云端**: CNB 定时流水线每 3 小时 POST `workflow_dispatch`, 由 GitHub Actions
唤起一个短进程, 跑一轮就退出; 没有常驻服务、没有长连接, 本机不留启动脚本和计划任务。
**执行端留在 GitHub Actions**（CNB runner 实测连不上发帖域名, 见「外部定时器」一节）;
主触发是 CNB 定时器（每 3 小时 POST `workflow_dispatch`）; GitHub 自带 `schedule` 已移除（best-effort、时好时坏, 且与 CNB 节奏重叠纯属冗余）。`cron-job.org` 是可选的境外冗余（尚未配置）。
配置分两份: 仓库里的 `config.json`（入库的基准配置, 不含 OpenAPI Key, 所有可调参数都在这里）和 Secret `BNS_CONFIG`, 状态靠 `state.json` 持久化。

## 文件

| 文件 | 说明 |
|---|---|
| `.github/workflows/bot.yml` | 云端**执行端**: 由 CNB 定时器每 3 小时触发, 把 Secret 里的 Key 注入 config.json、跑一轮 bot、提交 `state.json` |
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
node bot.js --force    # 强制发一条(绕过时间线/节奏, 用于验证); 没素材时用实时行情造一条
node bot.js --test     # 发一条测试帖验发帖接口
node bot.js --test-image # 生成行情卡片图并带图发一条测试帖, 验图片链路(Actions 里勾 test_image)
```

日常不用手动执行, `Actions → bns-bot → Run workflow` 即可触发一轮。
`--force` 和 `--once` 可组合: `node bot.js --once --force`; `--force` 现在**绕过时间线静默期与节奏**直接发帖(用于随时手动验证), 同时也会绕过 `dryRun` 真发帖。线上 `dryRun=false`, 在 Actions 勾 `force` 即可立即发一条真实帖子验证整条链路。
本地调试别把 `--force` 当成「只生成不发送」——它会真发。

## 节奏参数

`config.json` 里（**轮次频率由外部定时器 CNB `crontab` 决定**, 不在配置里;
GitHub 自带 `schedule` 已移除, 仅 CNB 触发）:

| 字段 | 说明 |
|---|---|
| `postsPerDay` | 每天最多发几帖(非时间线模式用) |
| `minIntervalMinutes` | 两帖最小间隔(非时间线模式用) |
| `schedule.enabled` | `true` 走时间线排期 |
| `schedule.evenSpread` | **`true` = 全天 24 小时均分, 无静默期**; 详见下节 |
| `schedule.maxPerDay` | 一天几个 slot(均分间隔 = `1440 / maxPerDay`); 当前 `8` = 每 3 小时一条 |
| `schedule.startHour` / `intervalMinutes` / `quiet` | 仅 `evenSpread=false` 时生效 |
| `market.symbols` | 初始监控币种; **每天按成交额自动覆盖**(结果存 `state.json`) |
| `market.symbolPool` | 可选: 自动刷新的 `topN` / `minUsd` / `autoRefresh`; 不写用默认 16 个 / 3000 万 USDT |
| `market.priceChangePct` | N 分钟内涨跌多少算异动 |
| `market.volSpikeMultiple` | 成交量放大几倍才算(避免假异动) |
| `post.hashtags` | 追加到每条帖子的**全局通用**话题, 默认留空; 各类型帖子已自带贴切标签, 别填类型专属标签 |
| `post.disclaimer` | 帖子结尾追加的免责声明；当前**留空**（2026-11-18 移除，固定每帖同一句声明易被判机器模板、触发降权）；留空即不追加 |
| `post.take` | 是否在帖子里加**数据解读段**, 默认 `true`; 设 `false` 可一键退回纯短文案 |
| `post.cta` | 结尾**开放式提问**（"你们怎么看？"这类），默认 `false` 关闭（2026-11-18 移除：固定套路像尬聊、易判机器模板降权）；设 `true` 可恢复（含资讯帖的提问） |
| `news.cardFeeds` | 哪些资讯源**强制用自生成卡片**（避开第三方水印）；填 `news.feeds[].name` 的原值、大小写需一致（当前 `["Cointelegraph","PANews"]`，不是 URL）；其余源优先 RSS 自带配图，**无图 / 图格式不支持 / 下载失败时自动补一张资讯卡片** |
| `news.baseScore` | 资讯在热度排序里的基础分，默认 `25`（原先硬编码 40，已下调）；只有选题分 + 盘面锚点都高的资讯才会压过榜单，普通资讯沉底。数值越低资讯越少被选中 |
| `news.skipWords` | 资讯标题含这些强情绪 / 传言词（暴跌、崩盘、狂潮、据传、rumor…）时**直接跳过该条**，规避平台限流与「需核查」标记 |
| `news.skipPlatformNotices` | 默认 `true`：**过滤平台自身公告 / 公司动作**（上线交易对、下架、平台币、财报、牌照等），标题同时命中 `platformNames`（平台名）和 `platformActions`（动作词）才拦；行情、链上数据、机构产品、他方事件不受影响。设 `false` 可恢复。词表在两个同名数组里增删 |
| `news.skipLowValueTopics` | 默认 `true`：**过滤低价值题材**（协议技术细节、机构持仓披露、娱乐八卦、Anthropic 相关）。标题同时命中 `skipTopicRules` 某条规则的**全部词**才拦（规则间 OR，如 `["eip","草案"]`）；默认只查标题，写成 `{ "words": [...], "scope": "all" }` 可连摘要一起查（Anthropic 用这条，因为它常在摘要里出现）。设 `false` 可恢复 |
| `news.anchorRelevance` | 默认 `enabled:true`：**锚点加分要求交易相关**——资讯提到锚点币种时，标题 / 摘要命中 `tradeWords`（涨跌、突破、成交额、净流入、现货 / 合约…任一）才给满分，否则按 `noSignalFactor`（默认 `0.4`，即 10 分折成 4 分）打折；设 `enabled:false` 恢复旧行为，因子和词表都可改 |
| `llm` | 资讯 / 热搜榜 / 涨跌榜的解读由 LLM 生成（`enabled` / `baseURL` / `model` / `apiKeyEnv` / `apiKey`）；默认走 Agnes（`apiKeyEnv` 指向仓库 Secret `AGNES_API_KEY`，本地调试可在 `config.local.json` 的 `llm.apiKey` 填明文）；资讯失败时走 A 兜底，热搜 / 涨跌榜失败时回退 takes.js 规则推导 |

### 文案结构与字数

币安官方《新手指南》: **短帖上限 2,100 字符**（长文 80,000）。官方创作者学院
《How to Post for Better Reach》明确说 "word count isn't the point"，真正影响推荐的是
**有没有自己的判断**（建议至少 50 words）、开头 3 秒能否抓住人、以及不踩
「纯搬运 / 重复快讯刷屏 / 过度 emoji / BREAKING 式标题党」这些红线。

所以五类帖子统一按下面结构生成，不是靠灌水凑字数：

```
数据 / 事件（首行钩子）
↓
解读段（行情由 takes.js 推导；资讯 / 热搜榜 / 涨跌榜由 LLM 生成，见下，失败回退规则推导）
↓
收尾话术（templates.js 词库随机，陈述句）
↓
标签行

（可选层：结尾开放式提问 CTA，默认关闭，`post.cta=true` 才追加）
```

- 实际约 **150–350 字符**，远低于 2,100 上限；`buildPost` 里 950 的截断只是兜底。
- **资讯不设静默时段**（`news.quietHours=[]`，2026-11-18 起）：原先 `[0-7]` 让凌晨 8 个 slot 无资讯可发、
  而榜单类有 240min 冷却 + 确定性兜底源（trend）已移除，导致凌晨大量空轮、日发帖数掉到 14-18。
  清空后资讯 24h 均可参选（配合当前 `maxPerDay=8`）；代价是凌晨资讯帖互动较低（实测浏览 30-50），
  这是「发满数量」与「单帖质量」的取舍。若想恢复低谷过滤，把不想发的小时填回 `quietHours` 即可。
- **资讯标题翻译走三层降级链**：LLM（术语地道、语气中性、结果稳定）→ 免费 Google 机翻 → 英文 A 兜底。
  **只对英文源翻译**；中文源（`news.feeds[].lang="zh"`，当前 PANews / Odaily）正文已是中文，直接原文、不调 LLM/机翻
  （省额度且避免中文标题被「英译中」prompt 无意义改写）。**摘要维持 Google 机翻**（正文细节够用）。
  每轮 LLM 调用 = 英文标题 ≤8 + 解读 1 = ≤9，卡在 Agnes 10 RPM 内。**去重 id 用 RSS 原标题的 hash 而非译文**——
  翻译有轻微不确定性，两次抓取的中文措辞可能微变导致 hash 漂移、同一文章重复发；原标题来自 RSS 源，是文章的稳定身份。
- 翻译失败回退的英文资讯帖**不加解读段与收尾**（A 兜底，只发标题+摘要+标签），避免再叠加中文；同样，LLM 不可用 / 关闭 `post.take` 时也是 A 兜底，干净不公式化。CTA 已全局关闭，与是否兜底无关。
- 中文资讯帖由 **LLM 整帖改写**成口语化的个人分享帖（不再"标题+摘要"生硬拼接），降低被平台判"搬运"的风险。
  硬约束：事实只来自标题与摘要，关键数字（百分比/金额/具体数量）、人名、机构名原样保留；
  新闻发布时间（如"11月18日消息"）可口语化省略，但事件本身的日期必须保留；新闻人物观点须标注归属，禁止用"我"表达立场。
  **代码侧做一道确定性校验**：只抽取并校验「事实数字」（带 `%`/`亿`/`万`/`美元`/`个`/`枚` 等单位的数字），
  缺一个就判无效走 A 兜底；日期（11月18日）、时间（11:00）、时长（19个月/24小时）、代号（EWJB）里的数字先剥离再校验，
  比对时忽略数字与单位之间的空格（LLM 常写「5000 万美元」），但数字本身改错仍会拦截——
  否则公告类新闻数字密集、口语化后必然触发缺失，100% 走兜底发搬运帖（2026-11-18 实测两条币安公告 0/27 浏览的根因；
  11-19 又实测「19 个月」「24 小时」这类带空格写法把改写误杀成搬运）。
  改写帖**不加模板收尾与 CTA**（固定话术本身就是机器感来源），只附 `#加密资讯`；提示词引导
  每条最多一处自然口头语且位置换着来，防止口头语本身变成新模板。
  LLM 失败 / 超时 / 校验不过时降级为 A 方案（标题+摘要+标签）；`post.take=false` 才回到旧固定收尾。
- **热搜榜 / 涨跌榜 / 币安合约榜解读由 LLM 点评榜单结构**：点名具体币种与涨跌幅，并做能从数字核对的比较
  （领涨第一是否断层领先、涨跌两端谁更极端、是否单边），不用能套到任何一天的通用感想。同样约束：只用榜单给定数据、
  不猜具体原因、不给买卖建议；失败回退 takes.js 规则推导。合约榜原本只有固定文案、连续多条一字不差，现也走点评。
  **行情异动不用 LLM**——数字即信息，LLM 没有实时消息面，硬凑观点只会是套话或编造。
- `post.take=false` 时资讯帖仍**逐字回到改动前**的固定收尾，便于一键回退。
- 不显示文章来源平台名，不输出外链，配图/去重/发帖频率均不受影响。
- **平台公告不发**：交易所 / 平台自己的运营公告与公司动作（上线或下架交易对、平台币 / 积分、
  财报、牌照、融资收购等）看不懂也没流量，默认过滤；判定是标题同时命中平台名和动作词，
  行情 / 链上数据 / 机构产品（如富途家族信托）/ 他方事件（如币安黑客钱包转移）都保留。
- **低价值题材不发**：EIP / Gas 提案这类协议细节、13F / 增持股票这类机构持仓披露、
  影视剧评这类娱乐八卦，以及 Anthropic 相关（实测带该词的帖子几乎没流量），看不懂也
  没有交易抓手，默认过滤；判定是标题同时命中一条规则里的全部词（规则间 OR），避免误伤
  正常行情帖。规则在 `news.skipTopicRules`。
- **资讯优先选跟盘面相关的**：资讯热度分里加一项「盘面锚点」——新闻提到的币正好在本轮
  热搜榜 / 涨跌榜 / 合约榜或当日监控池里，每个 +10（最多 +20）。这样「BTC 跌破 7 万」
  这种读完能回去看盘的资讯会压过「沃勒加息」这种没有币种抓手的新闻；只认明确的币种符号
  和已知全称，不会被 CEO / ETF 之类误判。**但锚点分还要求交易相关**：提到币却通篇没有
  涨跌 / 资金 / 成交信号时按 `noSignalFactor`（默认 0.4）打折，避免「$BTC 挂在 120 万美元
  股票持仓」这类也拿满 20 分。
- RSS 里**没有新闻事实的栏目导语 / 引流话术**（如 Cointelegraph 每日汇总的
  "Need to know what happened in crypto today?"，翻译后就是"想了解…请点击文章查看详细内容"）
  会在解析阶段判为无摘要，**整条素材跳过**；不是在帖子里删掉那句话继续发——这类条目的标题
  也是日更栏目名，删完只剩空壳。每轮还有其它信源与素材类型的多条候选，跳过这一条不影响发帖频率。
- WordPress 类 RSS（如 BitcoinMagazine）会把**站点名、标题链接、署名尾巴和正文**塞进同一个
  `description`；解析时按块剥掉非正文内容，只留真正有事实的段落，避免因为"摘要里含标题"把整段连正文一起丢掉。
- **选题过滤**：资讯标题含强情绪 / 传言词（暴跌、崩盘、狂潮、据传、rumor… 见 `news.skipWords`）时跳过——
  这类内容平台易限流且常被打「需核查」标记，且本来也没增量信息。行情异动 / 涨跌榜由数据驱动，不在此列。
- **卡片小字**：自生成卡片底部只保留合规免责 `Not financial advice`，去掉暴露机器人身份的 `Auto-posted by bns-bot`
  和多余的 `Full summary in the post below`，以免向读者暴露是机器号。

### 24 小时均分排期（当前默认）

`schedule` 写成:

```json
"schedule": {
  "enabled": true,
  "evenSpread": true,
  "maxPerDay": 8,
  "timezone": "Asia/Shanghai"
}
```

间隔 = `1440 / maxPerDay` 分钟。当前 8 帖即 **180 分钟一个 slot**（每 3 小时一条）,
从本地 0:00 铺到 24:00。**没有静默期**; 改 `maxPerDay` 会自动重算间隔, 不用手动改别处。
把 `evenSpread` 设成 `false` 就回到旧的 `startHour` + `intervalMinutes` + `quiet` 写法。

> 配置分两份: 仓库里的 **`config.json`** 是入库的基准配置（不含 Key, 所有可调参数如 market 阈值、
> imageCard、发帖节奏都在这里, 改了提交即生效）; **`BNS_CONFIG`** 这个 Secret **只存 OpenAPI Key**
> （一个字符串, 不再存整份 JSON）, 运行时由 workflow 注入到 `config.json` 的 `openApiKey`。
> 想改参数直接改 `config.json` 提交即可。

## 限流

币安广场官方上限 100 帖/天。当前默认走 `schedule.evenSpread` 时间线模式,
实际每日上限是 **`schedule.maxPerDay`**（当前 8）; `postsPerDay` / `minIntervalMinutes`
只在 `schedule.enabled=false` 的非时间线模式下生效。
新号建议把 `maxPerDay` 降到 10 起步, 一周没被限流再往 15-20 提。

## 风控错误码

| code | 含义 | 处理 |
|---|---|---|
| 20002 / 20022 | 敏感词 | 检查帖子内容、调整词库（当前不加免责声明，固定话术同样易触发机器判定） |
| 220009 | 当日限额 | 停到明天 |
| 30008 | 违规禁言 | 去币安 App 申诉 |
| 220004 | Key 过期 | 重新生成 Key 后更新 Secret BNS_CONFIG（本地调试则改 config.local.json） |

## 日志

在 `Actions → bns-bot → 对应运行记录 → cycle` 里看, 公开仓库的日志含帖子全文。
本地不产生 `bot.log`。

## 图片帖（卡片配图）

行情异动、热搜榜、涨跌榜、形态突破、币安合约涨跌榜，以及 `news.cardFeeds` 列出的资讯源，会自动各配一张**卡片图**，提升广场曝光：

| 素材 | 卡片内容 |
|---|---|
| 行情异动 | 币种 + 涨跌幅 + 现价 + 量比 + 时间（绿涨红跌） |
| 热搜榜 | CoinGecko 24h 热搜 Top6：排名 + 币种 + 24h 涨跌幅 |
| 涨跌榜 | 全市场 24h 领涨 / 领跌各 Top5，双列展示 |
| 形态突破 | 币种 + 20 日新高/新低 + 现价 |
| 币安合约涨跌榜 | 币安永续领涨 / 领跌各 Top5（仅 binance-perp，无 OKX 等竞品） |
| 资讯（Cointelegraph） | RSS **英文原标题**折行 + CST 时间；不出现来源媒体名 |

以上卡片共用同一套视觉规格（1080×1080 深色底、绿涨红跌、CST 时间、底部免责条）。
`news.cardFeeds` 里的源（当前 Cointelegraph / PANews）用自生成卡片，不再下载第三方封面——
其封面左上角有半透明媒体 logo，抹掉别家水印比带水印转载更不合适；
其余资讯源仍优先用 RSS 自带 jpg/png 配图。**RSS 无图（如 Odaily）、图格式不支持或下载上传失败时，
自动补一张同样的资讯卡片**，不再裸奔发纯文本；只有卡片生成/上传本身失败才降级纯文本。
若以后发现其它源封面有水印，把该源在 `news.feeds[].name` 里的名字（大小写一致）加进 `news.cardFeeds` 即可，不用改代码。

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
- **额度**：币安广场每日上传限额 400 次，本项目最多 24 帖/天，余量充足。
- **字体**：卡片只用英文 / 数字，避免中文字体依赖；资讯卡片放的是 RSS 翻译前的英文原标题，
  中文标题与摘要仍放在文字帖正文。Actions 已确保安装 `fonts-dejavu-core`，
  本地若缺失字会渲染不出（不影响纯文本帖）。

## 部署到 GitHub Actions（公开仓库）

CNB 定时器每 3 小时触发一次, GitHub Actions 才跑一轮 `node bot.js --once`
（`--once` 只是兼容参数, 不写也是跑一轮就退出）; `bot.yml` 由 CNB 定时器每 3 小时触发（手动 Run workflow 亦可）。
**仓库必须是 Public**: 公开仓库的标准 runner 免费且不限分钟数, 不消耗私有库每月 2000 分钟额度;
私有库按这个频率约 **240 次运行/月**（8 次/天 × 30 天）, 即便每轮只有几十秒,
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
`bot.yml` 的 `on.schedule` 整段已删除; 主触发是 CNB 定时流水线每 3 小时 POST
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
| 频率 | 每 3 小时, `:08`（0/3/6/9/12/15/18/21 点, 与 CNB `crontab` 分钟对齐） |

`inputs.source` 只用于辨识来源: 运行列表标题分别是
`cycle · cnb`（CNB 定时器）、`cycle · cron-job.org`（境外冗余）、
`cycle · manual`（手动跑）。
不传 `test_post`（默认 `false`）, 走 `node bot.js --once`。

外部每 3 小时敲一次门与 bot 内部 `evenSpread` / `maxPerDay=8` 的 slot 对齐:
到点才抓接口发帖, 万一触发提前/延迟, bot 内部仍会判断, 不会超额发帖。

### 3. 落地 CNB 触发器（主方案, 2026-11-12 已配置并验证）

`.cnb.yml` 与 `trigger-workflow.mjs` 已在仓库里: `crontab: 8 */3 * * *` 按
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

**④ 执行计划**: 选自定义 schedule, 分钟填 `8`; 小时选 `0,3,6,9,12,15,18,21`,
日 / 月 / 星期选「每天 / 每月 / 每天」,
与 CNB `crontab: 8 */3 * * *` 对齐。

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

- 主触发是 **CNB 定时流水线** POST `workflow_dispatch`（每 3 小时, 见上节）;
  GitHub 自带 `schedule` 已移除（best-effort、时好时坏且与 CNB 重叠）。
  定时调度常延迟甚至整段漏跑, 时间线排期的「只追发最近 1 个 slot」逻辑能容错。
- **抓取节奏**: bot 先判断时间线 slot, 没到点就**零请求退出、不改 `state.json`、不产生 commit**;
  只有每个 slot 才抓一次接口, 并用 `state.lastFetchAt` 的时间冷却（一个间隔减 20 分钟余量）保证
  同一 slot 不重复抓、连续没素材也会按周期继续尝试。接口调用量约从 96 次/天降到
  `maxPerDay` 次/天（当前 8 次/天, 币种池刷新另加 1 次/天）; 代价是两次 slot 之间发生的异动要等到下个 slot 才看。
- **选帖**: 每轮最多发 1 条。多条素材按热度评分取最高的一条（行情看涨跌幅与量比,
  热搜榜 / 涨跌榜 / 资讯 / 形态突破 / 合约榜按类型给基础分, 全部叠加新鲜度加权）。
  **类型优先级**: 行情异动 > 热搜榜 > 涨跌榜 > 资讯。资讯内部**中文加权 +10**（中文走 LLM 整帖改写、
  质量高于英文机翻, 同轮中文资讯优先于英文; 实测中文资讯 70 分 vs 英文 60 分, 均高于各自英文/基准）。
  资讯选题价值分（交易相关 +8/词、政治监管 -12/词）也直接叠加, 高的能压过热搜榜。
  **类型冷却**（`post.kindCooldownMinutes`，默认热搜/涨跌榜 240 分钟）：榜单类素材每轮重抓、新鲜度加成
  恒定拿满，不节流会来回刷屏、挤掉新闻。发帖成功后按类型记时间戳，冷却期内该类不参选，新闻自然填充；
  冷却结束但榜单没变化时该类无候选，内容驱动不硬凑。行情异动 / 资讯 / 形态突破 / 合约榜不冷却。全部候选都在冷却中
  且无新闻时本轮空转；`--force` 忽略冷却。
  **相邻两条不能同类**: 上一条发了某类, 本轮自动改发次高分的其它类; 只剩该类可选时仍发它(避免空轮)。
  各类一天可发多条, 靠素材 id 内容签名去重: 热搜/涨跌榜按当天上榜币种列表签名, 榜单有变才算新内容;
  资讯按文章 id, 每条只发一次。
  日志会打印各候选分数与冷却状态; 没有素材就不发。
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
`symbols` / `symbolsUpdatedAt`, 抓取时用 `state.symbols` 覆盖
`config.market.symbols`; 因为 `state.json` 每轮 commit 回仓库, 新 runner 能接着用。

- **不需要改 config.json、不需要新 workflow**; 每天只多 1 次请求, 空转轮次仍然零请求。
- 刷新失败会沿用上次的池子（没有则沿用 Secret 初始值）, **不阻断发帖**, 下个 slot 再试;
  日志分别显示 `币种池: 今日首次刷新…` / `今日已刷新, 沿用…` / `刷新失败…`。
- 想调参数: 在 `config.json` 的 `market` 里加
  `"symbolPool": { "topN": 16, "minUsd": 30000000 }`; 加 `"autoRefresh": false` 可关掉。
  不写这些字段也能正常工作（用默认值, 或复用 `_symbolsAuto` 里记录的上次参数）。
- 筛选规则集中在 `symbolPool.js`, 写成纯函数便于离线验证; 没有第二套本地刷新脚本。

### 451 地区封锁排查（GitHub runner, 2026-11-17 复测）

> 这是 **GitHub runner 出口**的地区封锁结论, 与「CNB 能不能跑 bot」是两回事:
> 2026-11-12 的 CNB 探测结论见「外部定时器」一节（CNB 连发帖域名都连不上, 只能当触发器）。

GitHub runner 的出口 IP 在美国, `api.binance.com` / `api1.binance.com` / `fapi.binance.com`
全部返回 **HTTP 451**。早期抓取函数把失败 `catch` 掉了, 所以全 451 时 job 依然是绿色
（假绿）, 只刷「拉取失败: HTTP 451」。

`Actions → probe-binance → Run workflow` 是只读探针（不发帖、不读 Secret、不改 `state.json`）。
2026-11-17 23:57 UTC 复测（run `44203830893`, CloudFront IAD61 出口）结果:

| 域名 | 状态 | 处理 |
|---|---|---|
| `api.binance.com` / `api1.binance.com` | 451 | 现货行情统一走官方镜像 `data-api.binance.vision`（200） |
| `fapi.binance.com` | 451 | 无等价镜像（vision 的 `/fapi/...`、`/futures/data/...` 均 404）; 相关素材源已全部移除 |
| `www.binance.com/bapi`（发帖） | 400 + JSON 业务错误 | ✅ 没被地区封锁, 可以发帖 |
| OKX / Bybit | ERR / 403 | 也不通, 不作备选 |

代理方案也已评估并排除: 公共 CORS 代理（allorigins / corsproxy.io / codetabs / r.jina.ai）要么被
CloudFront 拦截, 要么自己出口也被币安 451; 币安测试网 `testnet.binancefuture.com` 虽返回真实结构,
但那是模拟盘费率, 不能当实盘数据发; Coinglass 需 API key; CoinGecko `/derivatives` 只有交易所级
汇总、无单币费率且免费版频繁 429。自建非美区代理是唯一确定可行的方案, 但要引入新基础设施,
与本项目「零成本 + 不占现有账号额度」的约束冲突, 不采用。

现货行情（K线 / exchangeInfo / ticker）统一走 `data-api.binance.vision`。

**币安合约涨跌榜（binanceMovers）走第三方聚合**: 因 `fapi.binance.com` 451 无镜像,
该源改为拉 `https://info.qianyuwing.com/api/tickers?type=crypto`, 且**只取
`exchange === "binance-perp"` 的交易对**, 严格排除 okx / bybit / bitget / mexc / gate 等其他所
（社区准则禁止推广竞品交易所）。字段等价原 fapi 的 `/fapi/v1/ticker/24hr`。
2026-11-18 probe 实测 GitHub runner 出口访问该接口返回 **200**（run `44218267823`），云端可用已确认。

**当前实际会有内容的素材源**: 行情异动、热搜榜、涨跌榜、形态突破、币安合约涨跌榜、资讯 RSS
（2026-11-18 已开启, 4 个英文源 Cointelegraph / Decrypt / CoinDesk / BitcoinMagazine + 2 个中文源:
PANews `/rss.xml?lang=zh&type=NEWS`、Odaily `rss.odaily.news/rss/newsflash`（官方 RSS, 本身无配图,
会自动补一张资讯卡片, 云端 probe 实测 200）, `perFeed=2`）、Foresight News 快讯。

**Foresight News 源**: 走官方 API `api.foresightnews.pro/v1/news`（免 key, 云端 probe 实测 200,
run `44230729367`）。数据用 **base64 + zlib 压缩**——`fetchForesight()` 里
`response.data.list` → base64 decode → `zlib.inflateSync` → `JSON.parse` 解密（Node 自带 zlib, 无新增依赖）。
产出与 RSS 资讯同构（`kind:"news"`/`lang:"zh"`, 中文正文现成无需翻译）, 复用发帖/卡片/去重链路;
按官方 id 去重, `is_important` 快讯加权。竞品交易所/煽动词过滤与 RSS 资讯一致。配置在 `config.json` 的
`foresight`（enabled / api / perFetch）。

资金费率 / 持仓量 OI / 多空比 / 趋势快照 / 新币五个源因 451、低流量或字段失效已全部移除。
新币源移除原因: `data-api.binance.vision` 的 `exchangeInfo` 不含 `onboardDate` 字段（0/3743），
7 天内上线筛选永远为 false；币安公告接口虽可用但只有标题没有正文，内容撑不起一条帖子。

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
