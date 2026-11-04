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
