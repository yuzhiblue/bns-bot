# bns-bot — 币安广场自动发帖

抓取币安行情异动 + 实时公告 → 生成带 `$币种` 的帖子 → 调广场 OpenAPI 发布。

## 文件

| 文件 | 说明 |
|---|---|
| `bot.js` | 主程序, 单文件, Node 18+ |
| `config.json` | 配置: Key、节奏、监控币种、敏感词 |
| `state.json` | 运行状态(自动维护, 别手动改) |
| `bot.log` | 日志(常驻模式输出到这) |
| `start.bat` | Windows 启动脚本 |
| `start.sh` | Linux 启动脚本 |

## 快速开始

```bash
# 1. 先跑一轮看看抓到的素材(不发帖)
node bot.js --once

# 2. 验证发帖链路(造一条假行情真发出去)
node bot.js --once --force

# 3. 确认帖子没问题后, 把 config.json 的 dryRun 改 false, 常驻跑
node bot.js
```

## 命令

```bash
node bot.js            # 常驻: 每 cycleMinutes 判一次节奏, 到 slot 才抓接口 + 挂公告 WS
node bot.js --once     # 单次: 判一次节奏, 到 slot 才抓一轮然后退出
node bot.js --force    # 没素材时用实时行情造一条(仍受时间线约束)
node bot.js --test     # 发一条测试帖, 只验接口
```

`--force` 和 `--once` 可组合: `node bot.js --once --force`。注意 `--force` 只在时间线
允许发帖时才生效, 不会绕过节奏。

## 节奏参数

`config.json` 里:

| 字段 | 说明 |
|---|---|
| `cycleMinutes` | 多久检查一次节奏(15 分钟一次); **没到发帖 slot 就不抓接口** |
| `postsPerDay` | 每天最多发几帖(非时间线模式用) |
| `minIntervalMinutes` | 两帖最小间隔(非时间线模式用) |
| `schedule.enabled` | `true` 走时间线排期 |
| `schedule.evenSpread` | **`true` = 全天 24 小时均分, 无静默期**; 详见下节 |
| `schedule.maxPerDay` | 一天几个 slot(均分间隔 = `1440 / maxPerDay`) |
| `schedule.startHour` / `intervalMinutes` / `quiet` | 仅 `evenSpread=false` 时生效 |
| `market.symbols` | 监控哪些币 |
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

常驻模式重定向到 `bot.log`。Windows 上跑 `start.bat` 会自动追加。

## 部署到 GitHub Actions（公开仓库）

本地电脑关机就停, 云端版用 GitHub Actions 每 15 分钟跑一轮 `node bot.js --once`。
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
   git add .gitignore README.md bot.js config.example.json .github/workflows/bot.yml state.json
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
   - Secret: 本地 `config.json` 的**完整内容**（含 `openApiKey`, 多行 JSON 直接粘贴）,
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
  `maxPerDay` 次/天（当前 15 次/天）; 代价是两次 slot 之间发生的异动要等到下个 slot 才看。
- **选帖**: 每轮最多发 1 条。多条素材按热度评分取最高的一条（行情看涨跌幅与量比、
  新币看上线新鲜度、公告看发布时间、情绪看指数极端程度, 全部叠加新鲜度加权）。
  日志会打印各候选分数; 没有素材就不发。
-   `state.json` 只在真正抓取过的轮次被 commit 回仓库, 用于持久化去重记录、当日发帖数、
  时间线进度和 `lastFetchAt`; 每天十几次 push 也足以保持仓库活动,
  避免公开仓库「60 天无活动自动禁用定时 workflow」。
- `TZ=Asia/Shanghai` 由 workflow 设置, 日志和「今天」的判定与本地一致。
- 单次模式**不挂 WebSocket**（长连接会让 job 挂到超时）, 公告走内置 HTTP 接口
  `www.binance.com/bapi/composite/v1/public/cms/article/list/query`（公开、无需 Key）:
  取 12 小时内的新公告, 首次运行把现有公告记为基线, 避免一次性补发旧公告。
  想换接口可在 `BNS_CONFIG` 的 `announcement.apiUrl` 里覆盖; 接口失效或结构变了会自动降级, 不影响其他素材。
- `refreshSymbols.js` 回写 `config.json`, 而云端配置在 Secret 里, 所以**不要在 Actions 里跑它**,
  要换监控币种直接编辑 `BNS_CONFIG` Secret。

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

上线顺序:

1. `Actions → bns-bot → Run workflow` 不勾选, 用 `dryRun: true` 跑一轮。
   注意**只有落在 slot 窗口内的轮次才会抓接口**; 其它轮次日志是
   「时间线: ... 本轮不抓接口也不发帖」, 属正常。到点的轮次应看到 `行情 XXX: 60min ...`
   而不是「拉取失败」, 以及 `公告: 首次运行, 把 N 条现有公告记为基线`。
2. （可选复验）`Actions → bns-bot → Run workflow` 勾选 **test_post**
   （执行 `node bot.js --test`）, 再真发一条测试帖;
3. 最后把 Secret `BNS_CONFIG` 里的 `dryRun` 改成 `false` 正式上线。

本地常驻模式不受影响: `node bot.js` 仍走原来的 WebSocket 公告订阅。
