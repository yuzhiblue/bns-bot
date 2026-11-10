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
node bot.js            # 常驻: 每 cycleMinutes 跑一轮 + 挂公告 WS
node bot.js --once     # 单次: 跑一轮就退出
node bot.js --force    # 强制发(忽略节奏, 没素材就造一条)
node bot.js --test     # 发一条测试帖, 只验接口
```

`--force` 和 `--once` 可组合: `node bot.js --once --force`

## 节奏参数

`config.json` 里:

| 字段 | 说明 |
|---|---|
| `cycleMinutes` | 多久抓一轮素材(15 分钟一次, 行情数据实时算) |
| `postsPerDay` | 每天最多发几帖 |
| `minIntervalMinutes` | 两帖最小间隔 |
| `market.symbols` | 监控哪些币 |
| `market.priceChangePct` | N 分钟内涨跌多少算异动 |
| `market.volSpikeMultiple` | 成交量放大几倍才算(避免假异动) |
| `post.hashtags` | 帖子结尾自动带的话题 |
| `post.disclaimer` | 帖子结尾追加的免责声明 |

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

2. `Settings → Secrets and variables → Actions → New repository secret`:
   名称 `BNS_CONFIG`, 值 = 本地 `config.json` 的**完整内容**（含 `openApiKey`）。
   想先验证就把 `dryRun` 设为 `true`, 确认真发再改成 `false`。
   改配置只需更新这个 Secret, 不用重新提交代码。

3. `Settings → Actions → General → Workflow permissions` 选 **Read and write permissions**
   （workflow 需要把 `state.json` 推回仓库）。

4. `Actions → bns-bot → Run workflow` 手动跑一次, 看日志是否正常、
   仓库是否多了一条 `persist bot state` 提交。

### 运行机制

- `.github/workflows/bot.yml` 用 UTC cron `8,23,38,53 * * * *`（每 15 分钟, 故意错开整点减少排队）。
  GitHub 定时调度常延迟 5~30 分钟, 时间线排期的「只追发最近 1 个 slot」逻辑能容错。
- `state.json` 每轮被 commit 回仓库, 用于持久化去重记录、当日发帖数和时间线进度;
  同时保证仓库持续有 push 活动, 避免公开仓库「60 天无活动自动禁用定时 workflow」。
- `TZ=Asia/Shanghai` 由 workflow 设置, 日志和「今天」的判定与本地一致。
- 单次模式**不挂 WebSocket**（长连接会让 job 挂到超时）, 公告改走 `announcement.apiUrl`:
  在 `BNS_CONFIG` 的 `announcement` 里加 `apiUrl` 指向一个币安公告列表 JSON 接口才会启用;
  不配就跳过公告, 其余行情/费率/多空比/新币/情绪素材照常。接口失效或结构变了会自动降级, 不影响发帖。
- `refreshSymbols.js` 回写 `config.json`, 而云端配置在 Secret 里, 所以**不要在 Actions 里跑它**,
  要换监控币种直接编辑 `BNS_CONFIG` Secret。

### 上线前必做

GitHub runner 是美国机房 IP, 币安对部分机房 IP 会返回 **451 / 风控**（错误码 2000002）。
先用 `dryRun: true` 手动跑几轮, 确认行情接口能拉到数据、发帖链路没有地域限制, 再改成 `false` 真发。

本地常驻模式不受影响: `node bot.js` 仍走原来的 WebSocket 公告订阅。
