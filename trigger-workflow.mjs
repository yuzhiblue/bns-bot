// CNB 定时触发器: POST GitHub workflow_dispatch, 带重试与明确失败。
// PAT 由 CNB 密钥仓库经 imports 注入为 BNS_DISPATCH_TOKEN。
// 绝不把 token 打进日志（密钥仓库文档明确提醒过流水线内泄漏风险）。
const TOKEN = process.env.BNS_DISPATCH_TOKEN;
const URL =
  "https://api.github.com/repos/yuzhiblue/bns-bot/actions/workflows/bot.yml/dispatches";
const ROUNDS = 3;
const RETRY_GAP_MS = 5000;
const TIMEOUT_MS = 12000;

if (!TOKEN) {
  console.error("BNS_DISPATCH_TOKEN 未注入: 检查 .cnb.yml 的 imports 与密钥仓库文件");
  process.exit(1);
}

const body = JSON.stringify({ ref: "main", inputs: { source: "cnb" } });

for (let i = 1; i <= ROUNDS; i++) {
  const t0 = Date.now();
  try {
    const res = await fetch(URL, {
      method: "POST",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "bns-bot-cnb-trigger",
      },
      body,
    });
    const ms = Date.now() - t0;
    if (res.ok) {
      console.log(`第 ${i} 次: HTTP ${res.status} ${ms}ms — 触发成功`);
      process.exit(0);
    }
    const detail = (await res.text().catch(() => "")).slice(0, 300);
    console.error(`第 ${i} 次: HTTP ${res.status} ${ms}ms ${detail}`);
    // 4xx 是 token / 分支 / workflow 配置问题, 重试无意义
    if (res.status >= 400 && res.status < 500) process.exit(1);
  } catch (e) {
    const cause = e.cause?.code ? ` / ${e.cause.code}` : "";
    console.error(`第 ${i} 次网络失败 ${Date.now() - t0}ms: ${e.name}: ${e.message}${cause}`);
  }
  if (i < ROUNDS) await new Promise((r) => setTimeout(r, RETRY_GAP_MS));
}

console.error(`${ROUNDS} 次均失败, 构建标红以便告警`);
process.exit(1);
