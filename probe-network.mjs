// CNB 出口网络只读探针（第三轮: 发帖域名连测 + 等价 host 探测）
// 在 CNB runner 上执行, 不读 Secret、不发帖、不写 state.json。
// 用 Node 20 内置 fetch, 不依赖容器里是否装有 curl。
const TIMEOUT_MS = 12000;
const ROUNDS = 5;
const GAP_MS = 1000;

const GITHUB_URL = "https://api.github.com/repos/yuzhiblue/bns-bot";
// bot.js 的 BAPI 与公告 URL 用的是同一个 host: www.binance.com
const BAPI_URL =
  "https://www.binance.com/bapi/composite/v1/public/cms/article/list/query?type=1&pageNo=1&pageSize=5";

async function probe(label, url, { showBody = false, timeout = TIMEOUT_MS, noRedirect = false } = {}) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeout),
      redirect: noRedirect ? "manual" : "follow",
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

async function sampleSeries(label, url) {
  console.log(`\n--- ${label} 连测 ${ROUNDS} 次 ---`);
  const samples = [];
  for (let i = 1; i <= ROUNDS; i++) {
    samples.push(await probe(`${label} #${i}`, url));
    if (i < ROUNDS) await sleep(GAP_MS);
  }
  const okCount = samples.filter((s) => s.ok).length;
  const sorted = samples.map((s) => s.ms).sort((a, b) => a - b);
  const avg = Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length);
  console.log(
    `汇总 ${label}: ${okCount}/${ROUNDS} 成功 | ` +
    `耗时 min=${sorted[0]}ms median=${sorted[Math.floor(sorted.length / 2)]}ms ` +
    `avg=${avg}ms max=${sorted[sorted.length - 1]}ms`
  );
  console.log(`逐次: ${samples.map((s, i) => `#${i + 1}=${s.status ?? "FAIL"}(${s.ms}ms)`).join(" ")}`);
  return okCount;
}

console.log(`探针开始: ${new Date().toISOString()} (UTC) node=${process.version}`);
console.log(`配置: 单次超时 ${TIMEOUT_MS}ms, 每组连测 ${ROUNDS} 次, 间隔 ${GAP_MS}ms`);

// 确认出口身份没变（第一轮实测: 45.40.228.119 / warp=off / loc=CN）
await probe("出口IP(cf-trace)", "https://www.cloudflare.com/cdn-cgi/trace", { showBody: true });

const githubOk = await sampleSeries("GitHub API", GITHUB_URL);
const bapiOk = await sampleSeries("发帖域名 www.binance.com", BAPI_URL);

console.log("\n--- 候选等价 host 各测 1 次(超时 8s) ---");
await probe(
  "binance.com(无 www, 不跟随跳转)",
  "https://binance.com/bapi/composite/v1/public/cms/article/list/query?type=1&pageNo=1&pageSize=5",
  { timeout: 8000, noRedirect: true }
);
await probe("api.binance.com", "https://api.binance.com/api/v3/ping", { timeout: 8000 });
await probe("data-api.binance.vision(对照)", "https://data-api.binance.vision/api/v3/ping", { timeout: 8000 });

console.log(`\n结论: GitHub API ${githubOk}/${ROUNDS} 可达; 发帖域名 ${bapiOk}/${ROUNDS} 可达。`);
console.log("判定: 拿到 status 即网络层可达(400/403/451 属业务或风控); FAIL/超时才是连不上。");
console.log("      发帖域名 0/5 且候选 host 也无 status => CNB 直接跑 bot 不可行, 执行端须留在 GitHub runner。");
console.log("注意: 每组只覆盖几秒钟, 测的是短时抖动; 长期稳定性仍需在不同时间点多次触发。");
