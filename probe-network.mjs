// CNB 出口网络只读探针 —— 在 CNB runner 上执行，不读 Secret、不发帖、不写 state.json。
// 用 Node 20 内置 fetch，不依赖容器里是否装有 curl。
const TIMEOUT_MS = 12000;

const targets = [
  { label: "出口IP(ipify)", url: "https://api.ipify.org?format=json", showBody: true },
  { label: "出口IP(cf-trace)", url: "https://www.cloudflare.com/cdn-cgi/trace", showBody: true },
  { label: "GitHub API", url: "https://api.github.com/repos/yuzhiblue/bns-bot" },
  { label: "币安行情镜像", url: "https://data-api.binance.vision/api/v3/ping" },
  { label: "币安公告/发帖域名", url: "https://www.binance.com/bapi/composite/v1/public/cms/article/list/query" },
];

console.log(`探针开始: ${new Date().toISOString()} (UTC)`);

for (const t of targets) {
  const t0 = Date.now();
  try {
    const res = await fetch(t.url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { "User-Agent": "bns-bot-network-probe" },
    });
    const ms = Date.now() - t0;
    let body = "";
    if (t.showBody) {
      const text = (await res.text()).trim().replace(/\s+/g, " ").slice(0, 200);
      body = ` body=${text}`;
    }
    console.log(`OK   ${t.label} status=${res.status} ${ms}ms${body}`);
  } catch (e) {
    const cause = e.cause?.code ? ` / ${e.cause.code}` : "";
    console.log(`FAIL ${t.label} ${Date.now() - t0}ms ${e.name}: ${e.message}${cause}`);
  }
}

console.log("\n判定: 拿到 status 即网络层可达; 400/403/451 属业务错误或地区风控(域名通); FAIL/超时才是连不上。");
