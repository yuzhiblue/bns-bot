# bns-bot — 币安广场自动发帖（GitHub Actions 纯云端）

抓取币安行情异动 + 公告 → 生成带 `$币种` 的帖子 → 调广场 OpenAPI 发布。
**只跑云端**: workflow 每 15 分钟唤起一个短进程, 跑一轮就退出; 没有常驻服务、没有长连接,
本机不留启动脚本和计划任务。配置在 Secret `BNS_CONFIG`, 状态靠 `state.json` 持久化。

## 文件

| 文件 | 说明 |
|---|---|
| `.github/workflows/bot.yml` | 云端定时调度、注入 Secret、提交 `state.json` |
| `bot.js` | 主程序, 跑一轮即退出 |
| `templates.js` | 帖子词库 |
| `symbolPool.js` | 按 24h 成交额筛选币种池 |
| `config.example.json` | 配置示例(仅参考, 不影响线上) |
| `config.json` | 运行时由 Secret 生成; 本地若保留, `.gitignore` 已排除, 不入库 |
| `state.json` | 运行状态(自动维护, 别手动改); 当日币种池也存在这里 |

## 命令

本地跑需要先有一份 `config.json`（可从 `config.example.json` 复制并填入 Key）;
云端由 workflow 从 Secret 自动生成, 不需要这一步。

```bash
node bot.js            # 跑一轮: 判节奏 → 到点才抓接口 → 抓完就发 → 退出
node bot.js --once     # 同上, --once 只是兼容 workflow 写法的参数
node bot.js --force    # 没素材时用实时行情造一条(仍受时间线约束)
node bot.js --test     # 发一条测试帖验发帖接口
```

日常不用手动执行, `Actions → bns-bot → Run workflow` 即可触发一轮。
`--force` 和 `--once` 可组合: `node bot.js --once --force`; 注意 `--force` 只在时间线
允许发帖时才生效, 不会绕过节奏。

## 节奏参数

`config.json` 里（轮询频率由 workflow 的 cron 决定, 不在配置里）:

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
| `post.hashtags` | 帖子结尾自动带的话题 |
| `post.disclaimer` | 帖子结尾追加的免责声明 |

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

> GitHub Actions 版的配置在 Secret 里: `Settings → Secrets and variables → Actions` →
> 停在 **Secrets** 标签 → 下半部分 `Repository secrets` → 点 `BNS_CONFIG` 更新整份 JSON。
> 只改仓库里的 `config.example.json` **不会影响线上**。

## 限流

币安广场官方上限 100 帖/天, 我们设了 `postsPerDay` 远低于上限。
如果账号是新号, 建议 `postsPerDay` 从 10 起步, 一周没被限流再往 15-20 提。

## 风控错误码

| code | 含义 | 处理 |
|---|---|---|
| 20002 / 20022 | 敏感词 | 检查帖子内容, 加 `post.disclaimer` 或改词库 |
| 220009 | 当日限额 | 停到明天 |
| 30008 | 违规禁言 | 去币安 App 申诉 |
| 220004 | Key 过期 | 重新生成 Key 填进 config |

## 日志

在 `Actions → bns-bot → 对应运行记录 → cycle` 里看, 公开仓库的日志含帖子全文。
本地不产生 `bot.log`。

## 部署到 GitHub Actions（公开仓库）

GitHub Actions 每 15 分钟跑一轮 `node bot.js --once`（`--once` 现在只是兼容参数,
不写也是跑一轮就退出）。
**仓库必须是 Public**: 公开仓库的标准 runner 免费且不限分钟数, 不消耗私有库每月 2000 分钟额度;
私有库跑这个频率约 2880 分钟/月, 会直接把额度打爆并拖停其他 workflow。

> ⚠️ 公开仓库里**代码、`templates.js` 词库、`state.json`、运行日志（含帖子全文）全部公开**。
> `config.json` 和里面的 OpenAPI Key 不入库（`.gitignore` 已排除）, 只放在 Secret 里。
> 推送前执行 `git ls-files` 确认输出里没有 `config.json`; 若历史上曾提交过含 Key 的文件,
> 先去币安重新生成 Key 并清理历史。

### 步骤

1. 先提交本次改动, 在 GitHub 新建一个**公开**空仓库并推上去
   （现有 `origin` 是 cnb.cool, 另加一个远程; 推到 `main` 以对齐 GitHub 新仓库的默认分支）:

   ```bash
   git add .gitignore README.md bot.js templates.js symbolPool.js config.example.json .github/workflows/bot.yml state.json
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
   - Secret: **完整配置 JSON**（含 `openApiKey`, 多行直接粘贴; 可在 `config.example.json` 基础上改）,
     先把 `dryRun` 改成 `true`, 确认接口通了再改成 `false`
   - 点 **Add secret**。Secret 保存后不能再查看, 以后改配置只能整份覆盖粘贴,
     不用重新提交代码。粘贴不完整时 workflow 里的 `require('./config.json')` 会直接报错。

3. `Settings → Actions → General → Workflow permissions` 选 **Read and write permissions**
   （workflow 需要把 `state.json` 推回仓库）。

4. `Actions → bns-bot → Run workflow` 手动跑一次, 看日志是否正常、
   仓库是否多了一条 `persist bot state` 提交。

### 运行机制

- `.github/workflows/bot.yml` 用 UTC cron `8,23,38,53 * * * *`（每 15 分钟, 故意错开整点减少排队）。
  GitHub 定时调度常延迟 5~30 分钟, 时间线排期的「只追发最近 1 个 slot」逻辑能容错。
- **抓取节奏**: bot 先判断时间线 slot, 没到点就**零请求退出、不改 `state.json`、不产生 commit**;
  只有每个 slot 才抓一次接口, 并用 `state.lastFetchAt` 的时间冷却（一个间隔减 20 分钟余量）保证
  同一 slot 不重复抓、连续没素材也会按周期继续尝试。接口调用量约从 96 次/天降到
  `maxPerDay` 次/天（当前 15 次/天, 币种池刷新另加 1 次/天）; 代价是两次 slot 之间发生的异动要等到下个 slot 才看。
- **选帖**: 每轮最多发 1 条。多条素材按热度评分取最高的一条（行情看涨跌幅与量比、
  新币看上线新鲜度、公告看发布时间、情绪看指数极端程度, 全部叠加新鲜度加权）。
  日志会打印各候选分数; 没有素材就不发。
-   `state.json` 只在真正抓取过的轮次被 commit 回仓库, 用于持久化去重记录、当日发帖数、
  时间线进度、`lastFetchAt` 和当日币种池; 每天十几次 push 也足以保持仓库活动,
  避免公开仓库「60 天无活动自动禁用定时 workflow」。
- `TZ=Asia/Shanghai` 由 workflow 设置, 日志和「今天」的判定与本地一致。
- **无常驻进程、无长连接**: 公告走内置 HTTP 接口
  `www.binance.com/bapi/composite/v1/public/cms/article/list/query`（公开、无需 Key）:
  取 12 小时内的新公告, 首次运行把现有公告记为基线, 避免一次性补发旧公告。
  想换接口可在 `BNS_CONFIG` 的 `announcement.apiUrl` 里覆盖; 接口失效或结构变了会自动降级, 不影响其他素材。

### 监控币种池自动刷新

GitHub Actions 每次新建 runner, Secret `BNS_CONFIG` 里的 `market.symbols` 只是**初始快照**。
bot 在**每天第一次到点轮次**拉一次全所 `ticker/24hr`, 按 24h 成交额取前 `topN`
（默认 16）个成交额 ≥ `minUsd`（默认 3000 万 USDT）的 USDT 交易对,
排除稳定币包装 / ETF 股票包装 / 代币化黄金 / 跨链桥等壳币。结果写进 `state.json` 的
`symbols` / `symbolsUpdatedAt` / `symbolsMeta`, 抓取时用 `state.symbols` 覆盖
`config.market.symbols`; 因为 `state.json` 每轮 commit 回仓库, 新 runner 能接着用。

- **不需要改 Secret、不需要新 workflow**; 每天只多 1 次请求, 空转轮次仍然零请求。
- 刷新失败会沿用上次的池子（没有则沿用 Secret 初始值）, **不阻断发帖**, 下个 slot 再试;
  日志分别显示 `币种池: 今日首次刷新…` / `今日已刷新, 沿用…` / `刷新失败…`。
- 想调参数: 在 `BNS_CONFIG` 的 `market` 里加
  `"symbolPool": { "topN": 16, "minUsd": 30000000 }`; 加 `"autoRefresh": false` 可关掉。
  不写这些字段也能正常工作（用默认值, 或复用 `_symbolsAuto` 里记录的上次参数）。
- 筛选规则集中在 `symbolPool.js`, 写成纯函数便于离线验证; 没有第二套本地刷新脚本。

### 451 地区封锁排查（2026-11-11 已实测）

GitHub runner 的出口 IP 在美国, `api.binance.com` 与 `fapi.binance.com` 全部返回
**HTTP 451**。各抓取函数把失败 `catch` 掉了, 所以**所有接口 451 时 job 依然是绿色**
（假绿）, 只会刷「拉取失败: HTTP 451」, 靠 `alternative.me` 的恐惧贪婪指数撑着。

`Actions → probe-binance → Run workflow` 是只读探针（不发帖、不读 Secret、不改 `state.json`）。
实测结果与代码里的处理:

| 域名 | 状态 | 处理 |
|---|---|---|
| `api.binance.com`（K线 / exchangeInfo） | 451 | 统一改用官方镜像 `data-api.binance.vision`（探针实测 200） |
| `fapi.binance.com`（资金费率 / 多空比） | 451 | 没有等价镜像（`/fapi/...` 在 vision 上 404）, **默认禁用** |
| `www.binance.com/bapi`（发帖） | 400 + JSON 业务错误 | ✅ 没被地区封锁, 可以发帖 |
| OKX / Bybit | ERR / 403 | 也不通, 不作备选 |

现货行情（K线 / exchangeInfo / ticker）已统一走 `data-api.binance.vision`;
`fundingRate` / `whale` 只有在 config 里显式填了 `baseUrl` 才会请求, 留空（默认）即静默跳过,
不再每轮刷屏 451。现有素材源: 行情异动、新币、恐惧贪婪、公告（已内置）。

**发帖链路已验证通过**: 2026-11-11 用 `test_post` 跑 `node bot.js --test` 真发成功
（`id=386976997232534`）, 说明 OpenAPI Key 有效、发帖域名没被封、无设备风控。

当前状态与验证方式（2026-11-11 已正式上线, Secret `BNS_CONFIG` 里 `dryRun=false`）:

1. `Actions → bns-bot → Run workflow` 不勾选 **test_post**, 手动跑一轮看日志。
   注意**只有落在 slot 窗口内的轮次才会抓接口**; 其它轮次日志是
   「时间线: ... 本轮不抓接口也不发帖」, 属正常。到点的轮次应看到 `行情 XXX: 60min ...`
   而不是「拉取失败」。
2. （可选复验）`Actions → bns-bot → Run workflow` 勾选 **test_post**
   （执行 `node bot.js --test`）, 真发一条测试帖验 Key 与风控。
3. 判断链路是否通要看具体日志行（`行情` / `素材` / `✅ 发帖成功` / `chore: persist bot state`）;
   所有抓取失败都被 catch 吞掉, **job 绿色不等于链路通**。
