// CNB 出口网络只读探针（第二轮: GitHub API 连测采样）
// 在 CNB runner 上执行, 不读 Secret、不发帖、不写 state.json。
// 用 Node 20 内置 fetch, 不依赖容器里是否装有 curl。
const TIMEOUT_MS = 12000;
const GITHUB_ROUNDS = 5;
const GAP_MS = 1000;
const GITHUB_URL = "https://api.github.com/repos/yuzhiblue/bns-bot";

async function probe(label, url, { showBody = false } = {}) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { "User-Agent": "bns-bot-network-probe" },
    });
    const ms = Date.now() - t0;
    let body = "";
    if (showBody) {
      body = ` body=${(await res.text()).trim().replace(/\s+/g, " ").slice(0, 200)}`;
    }
    console.log(`OK   ${label} status=${res.status} ${ms}ms${body}`);
    return { ok: true, status: res.status, ms };
  } catch (e) {
    const cause = e.cause?.code ? ` / ${e.cause.code}` : "";
    console.log(`FAIL ${label} ${Date.now() - t0}ms ${e.name}: ${e.message}${cause}`);
    return { ok: false, status: null, ms: Date.now() - t0 };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log(`探针开始: ${new Date().toISOString()} (UTC) node=${process.version}`);
console.log(`配置: 单次超时 ${TIMEOUT_MS}ms, 连测 ${GITHUB_ROUNDS} 次, 间隔 ${GAP_MS}ms\n`);

// 先确认出口身份没变（第一轮实测: 45.40.228.119 / warp=off / loc=CN）
await probe("出口IP(cf-trace)", "https://www.cloudflare.com/cdn-cgi/trace", { showBody: true });

const samples = [];
for (let i = 1; i <= GITHUB_ROUNDS; i++) {
  samples.push(await probe(`GitHub API #${i}`, GITHUB_URL));
  if (i < GITHUB_ROUNDS) await sleep(GAP_MS);
}

const okCount = samples.filter((s) => s.ok).length;
const sorted = samples.map((s) => s.ms).sort((a, b) => a - b);
const avg = Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length);
console.log(
  `\n汇总 GitHub API: ${okCount}/${GITHUB_ROUNDS} 成功 | ` +
  `耗时 min=${sorted[0]}ms median=${sorted[Math.floor(sorted.length / 2)]}ms ` +
  `avg=${avg}ms max=${sorted[sorted.length - 1]}ms`
);
console.log(`逐次: ${samples.map((s, i) => `#${i + 1}=${s.status ?? "FAIL"}(${s.ms}ms)`).join(" ")}`);

console.log("\n判定: 拿到 status 即网络层可达; FAIL/超时才是连不上。");
console.log("注意: 这 5 次只覆盖几秒钟, 测的是短时抖动, 不能证明几小时后仍稳定;");
console.log("      要测长期稳定性, 需在不同时间点多次触发本探针, 或临时加低频 crontab 观察一天。");
