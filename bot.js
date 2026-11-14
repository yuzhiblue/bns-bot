#!/usr/bin/env node
/**
 * bns-bot — 币安广场自动发帖机器人（GitHub Actions 纯云端单次模式）
 * 抓取行情异动 / 新币 / 热搜榜 / 涨跌榜 / 资讯 RSS → 生成带 $币种 的帖子 → 调官方 OpenAPI 发布
 *
 * 每次运行只跑一轮就退出, 由 workflow 的 cron 定时唤起; 状态靠 state.json 持久化,
 * 配置: 仓库 config.json 为基准(不含 Key), 云端由 workflow 把 Secret 里的 openApiKey 注入;
 * 本地可放 config.local.json(含 Key, gitignore, 优先)。没有常驻进程、没有长连接。
 *
 * 用法:
 *   node bot.js            跑一轮(workflow 里写作 node bot.js --once, --once 为兼容参数)
 *   node bot.js --force    没素材时用实时行情造一条(仍受时间线约束)
 *   node bot.js --test     发一条测试帖验发帖接口
 */

const fs = require("fs");
const path = require("path");
const TPL = require("./templates");
const { buildTake } = require("./takes");
const { fetchSymbolPool, DEFAULT_TOP_N, DEFAULT_MIN_USD } = require("./symbolPool");
const { uploadImage } = require("./squareMedia");
const { makeMarketCard, makeTrendingCard, makeMoversCard, makeNewCoinCard, makeNewsCard } = require("./imageCard");

const ROOT = __dirname;
// 本地若有 config.local.json(含 Key, gitignore)则优先; 否则用仓库 config.json(CI 已注入 Key)
const configFile = fs.existsSync(path.join(ROOT, "config.local.json"))
  ? "config.local.json"
  : "config.json";
const config = JSON.parse(fs.readFileSync(path.join(ROOT, configFile), "utf8"));
const STATE_FILE = path.join(ROOT, "state.json");

// 现货行情走币安官方公开数据镜像: api.binance.com 对美国出口 IP 返回 451,
// data-api.binance.vision 是同一套现货公开数据, 不执行该地域封锁。
// 注意: 该镜像只有现货接口, 没有 fapi 合约接口(已探测返回 404)。
const BINANCE_API = "https://data-api.binance.vision";
const BAPI = "https://www.binance.com/bapi";

// ---------- 工具 ----------
function log(...args) {
  const ts = new Date().toLocaleString("zh-CN", { hour12: false });
  console.log(`[${ts}]`, ...args);
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {
      postedMaterialIds: [],   // 已发过的素材 id
      lastMarketSnap: {},      // symbol -> { price, ts }
      lastPostAt: 0,
      todayPosted: 0,
      todayKey: "",
      postHistory: [],         // 最近发帖记录
    };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function isSameDay(ts, now = new Date()) {
  const d = new Date(ts);
  return d.toDateString() === now.toDateString();
}

// 简易防重复:素材 id 去重
function markUsed(state, id) {
  state.postedMaterialIds.push(id);
  state.postedMaterialIds = state.postedMaterialIds.slice(-200);
}

async function fetchJson(url, opts = {}, timeoutMs = 10000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ---------- 素材抓取 ----------

// 行情异动:对比 N 分钟前的价格 + 成交量放大(各币种并行拉)
async function fetchMarketMove(cfg) {
  const { symbols, priceChangePct, windowMinutes, volSpikeMultiple } = cfg.market;
  const moves = [];

  await Promise.all(
    symbols.map(async (symbol) => {
      try {
        const t0 = Date.now() - windowMinutes * 60000;
        const data = await fetchJson(
          `${BINANCE_API}/api/v3/klines?symbol=${symbol}&interval=1m&limit=${Math.min(windowMinutes, 1000)}`
        );
        if (!Array.isArray(data) || data.length < 30) return;

        // 窗口内最早一根 vs 最新一根
        const base = data[0];
        const last = data[data.length - 1];
        const openPrice = parseFloat(base[1]);
        const closePrice = parseFloat(last[4]);
        const pct = ((closePrice - openPrice) / openPrice) * 100;

        // 成交量:最近 5 分钟均量 vs 之前均量
        const volAll = data.map((k) => parseFloat(k[5]));
        const recentVol = volAll.slice(-5);
        const priorVol = volAll.slice(0, -5);
        const avgRecent = recentVol.reduce((a, b) => a + b, 0) / recentVol.length;
        const avgPrior = priorVol.length
          ? priorVol.reduce((a, b) => a + b, 0) / priorVol.length
          : avgRecent;
        const volMultiple = avgPrior > 0 ? avgRecent / avgPrior : 1;

        if (Math.abs(pct) >= priceChangePct && volMultiple >= volSpikeMultiple) {
          moves.push({
            id: `market_${symbol}_${new Date(t0).toISOString().slice(0, 10)}`,
            kind: "market",
            symbol,
            baseSymbol: symbol.replace("USDT", ""),
            pct,
            price: closePrice,
            volMultiple: Math.round(volMultiple * 10) / 10,
            windowMinutes,
            ts: Date.now(),
          });
        }
        log(`  行情 ${symbol}: ${windowMinutes}min ${pct >= 0 ? "+" : ""}${pct.toFixed(2)}% 量比 ${volMultiple.toFixed(1)}x ${Math.abs(pct) >= priceChangePct ? "★异动" : ""}`);
      } catch (e) {
        log(`  行情 ${symbol} 拉取失败: ${e.message}`);
      }
    })
  );
  return moves;
}

// ---------- 新币 ----------

async function fetchNewCoins(cfg, state) {
  if (!cfg.newCoin?.enabled) return [];
  try {
    const info = await fetchJson(`${BINANCE_API}/api/v3/exchangeInfo`, {}, 30000);
    const now = Date.now();
    const fresh = (info.symbols ?? [])
      .filter((s) => s.status === "TRADING" && s.onboardDate && now - s.onboardDate < 7 * 86400000)
      .filter((s) => !["USDT", "BUSD", "FDUSD", "USDC"].includes(s.baseAsset));
    const seen = new Set(state.newCoinIds ?? []);
    const news = fresh
      .filter((s) => !seen.has(s.baseAsset))
      .map((s) => ({
        id: `newcoin_${s.baseAsset}_${Math.floor(s.onboardDate / 86400000)}`,
        kind: "newCoin",
        baseAsset: s.baseAsset,
        symbol: s.symbol,
        onboardDate: s.onboardDate,
        ts: now,
      }));
    state.newCoinIds = [...new Set([...(state.newCoinIds ?? []), ...fresh.map((s) => s.baseAsset)])].slice(-50);
    if (news.length) log(`  新币: 发现 ${news.length} 个 7 天内上线的币`);
    return news;
  } catch (e) {
    log(`  新币拉取失败: ${e.message}`);
    return [];
  }
}

// ---------- 热门信源: CoinGecko 热搜 / 全市场涨跌榜 / RSS 资讯 / CryptoPanic ----------
// 全部第三方、零 key(除 CryptoPanic 需免费 key); 失败一律 return [], 不影响其它素材。

function decodeEntities(s) {
  return (s || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&nbsp;/gi, " ")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/\s+/g, " ").trim();
}
function hashStr(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
// 资讯标题/链接归一化: 小写 + 去标点空白, 用于跨信源去重(同一条新闻不同来源标题一致即判重)
function normalizeText(s) {
  return (s || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}
// 把 RSS 摘要里的 HTML/CDATA/裸链接清成纯文本, 供资讯帖正文使用
function stripHtml(s) {
  const raw = (s || "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  const noTag = (x) => x
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ");
  return noTag(decodeEntities(noTag(raw)))
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
// RSS 里有两类 description 不是新闻摘要:
//   1) 每日汇总栏目的固定导语(Cointelegraph "Here's what happened in crypto today":
//      "Need to know what happened in crypto today? Here is the latest news on ...");
//   2) 纯引流话术("请点击文章查看详细内容" / "Read more" / "Follow us")。
// 翻译后就是"想了解最新的加密货币资讯？…点击文章查看详细内容"这类空壳。
// 判为无摘要后交给上层已有的 `if (!summary) continue` 跳过整条: 这类条目的标题
// 同样是日更栏目名, 只删句子会发出一个没有事实、还带解读段的空壳帖。
const PROMO_SUMMARY_START = [
  /^(?:want|need|looking) to (?:know|learn|read|get|stay|catch up|see|find out)\b/i,
  /^need to know what happened\b/i,
  /^here(?:'|’)?s?\b.{0,20}\b(?:what happened|latest news|roundup|recap)\b/i,
  /^(?:click|tap|read|follow|subscribe|visit|check out|learn more|read more|for more|full story)\b/i,
  /^(?:想了解|想知道|想获取|关注比特币交易|关注我们|请点击|点击|阅读全文|详情请|更多(?:详情|内容|资讯))/,
];
// 短文本里出现明确引流动作、基本没有事实, 也按空壳处理
const PROMO_SUMMARY_ANY = /(?:请点击(?:文章|链接|这里|原文)|点击查看详细|关注比特币交易|click here|read more|follow us)/i;
function isPromoSummary(s) {
  const t = (s || "").trim();
  if (!t) return true;
  if (PROMO_SUMMARY_START.some((re) => re.test(t))) return true;
  return t.length < 80 && PROMO_SUMMARY_ANY.test(t);
}

// WordPress / 聚合站常把站点名、标题链接、"This post first appeared on..." 署名尾巴
// 连同正文一起塞进 <description>。按块拆开逐块丢掉非正文内容, 只留有事实的段落。
// 例: BitcoinMagazine = [Bitcoin Magazine] + [标题] + [正文] + [版权尾巴];
// 旧逻辑用 includes(title) 判"摘要等于标题", 会把正文一起置空, 该源一条素材都发不出。
function summaryBlocks(html, title) {
  const titleNorm = normalizeText(title);
  const blocks = (html || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\/\s*(?:p|div|li|h[1-6])\s*>/gi, "\n")
    .split("\n")
    .map(stripHtml)
    .filter(Boolean);
  return blocks.filter((b) => {
    const n = normalizeText(b);
    if (!n) return false; // CDATA 残留 / 纯符号
    // 标题链接块(以及"标题 + 少量尾巴"), 不再误伤后面的正文段
    if (titleNorm && (n === titleNorm || (n.includes(titleNorm) && n.length < titleNorm.length + 40))) return false;
    if (/^(?:this|the) post\b[\s\S]*\bfirst appeared on\b/i.test(b)) return false; // 署名尾巴
    if (n.length < 24 && !/[.!?。！？]/.test(b)) return false; // 站点名 / 导航短块
    return true;
  }).join(" ").trim();
}

// 简易 RSS 2.0(<item>) 与 Atom(<entry>) 解析, 不引依赖。
// 从 RSS/Atom item 提取一张文章配图: 媒体缩略图优先, 其次正文内 <img>
function extractRssImage(blk) {
  let m;
  if ((m = blk.match(/<media:content[^>]*url="([^"]+)"/i))) return m[1];
  if ((m = blk.match(/<media:thumbnail[^>]*url="([^"]+)"/i))) return m[1];
  if ((m = blk.match(/<enclosure[^>]*type="image[^"]*"[^>]*url="([^"]+)"/i))) return m[1];
  if ((m = blk.match(/<enclosure[^>]*url="([^"]+)"[^>]*type="image[^"]*"/i))) return m[1];
  const desc = blk.match(/<description[^>]*>([\s\S]*?)<\/description>/i) ||
    blk.match(/<content:encoded[^>]*>([\s\S]*?)<\/content:encoded>/i);
  if (desc && (m = desc[1].match(/<img[^>]*src="([^"]+)"/i))) return m[1];
  return "";
}

function parseRss(xml, limit) {
  const blocks = [];
  let m;
  const itemRe = /<item[\s>]([\s\S]*?)<\/item>/gi;
  while ((m = itemRe.exec(xml))) blocks.push(m[1]);
  const entryRe = /<entry[\s>]([\s\S]*?)<\/entry>/gi;
  while ((m = entryRe.exec(xml))) blocks.push(m[1]);
  const out = [];
  for (const blk of blocks.slice(0, limit)) {
    const title = decodeEntities((blk.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]);
    let link = "";
    const linkM = blk.match(/<link[^>]*>([\s\S]*?)<\/link>/i);
    if (linkM) link = decodeEntities(linkM[1]).trim();
    if (!link) { const l2 = blk.match(/<link[^>]*href="([^"]+)"/i); if (l2) link = l2[1]; }
    const image = extractRssImage(blk);
    const descRaw =
      blk.match(/<description[^>]*>([\s\S]*?)<\/description>/i) ||
      blk.match(/<content:encoded[^>]*>([\s\S]*?)<\/content:encoded>/i) ||
      blk.match(/<summary[^>]*>([\s\S]*?)<\/summary>/i);
    let summary = descRaw ? summaryBlocks(descRaw[1], title) : "";
    // 栏目导语/引流话术里没有事实, 置空后上层会跳过整条(不发只剩空壳标题的帖)
    if (isPromoSummary(summary)) summary = "";
    // 纯标题壳(Google News 把标题包进 <a>)已在 summaryBlocks 里逐块丢掉, 结果为空同样跳过;
    // 不再用 includes(title) 整段置空, 否则会连正文一起丢。
    summary = summary.slice(0, 240);
    let ts = 0;
    const pd = blk.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i) ||
      blk.match(/<updated[^>]*>([\s\S]*?)<\/updated>/i) ||
      blk.match(/<published[^>]*>([\s\S]*?)<\/published>/i);
    if (pd) ts = Date.parse(pd[1].trim());
    if (title) out.push({ title, link, image, summary, ts: ts || Date.now() });
  }
  return out;
}

async function fetchTrending(cfg, state) {
  if (!cfg.trending?.enabled) return [];
  const today = todayStrTZ(cfg.schedule?.timezone);
  try {
    const j = await fetchJson("https://api.coingecko.com/api/v3/search/trending", {}, 15000);
    const coins = j?.coins ?? [];
    if (!coins.length) return [];
    const items = coins.slice(0, cfg.trending?.topN ?? 6).map((c) => {
      const item = c.item ?? {};
      return {
        sym: (item.symbol ?? "").toUpperCase(),
        name: item.name ?? (item.symbol ?? "").toUpperCase(),
        rank: c.market_cap_rank ?? item.market_cap_rank ?? "",
        data: item.data ?? {},
      };
    }).filter((x) => x.sym);
    log(`  热搜: ${items.length} 个热搜币`);
    // id 按当天币种列表签名: 列表没变 → 同 id 被去重不再发; 列表有变 → 新内容可再发(一天可多条)。
    return [{ id: `trending_${today}_${items.map((x) => x.sym).join("_")}`, kind: "trending", items, ts: Date.now() }];
  } catch (e) {
    log(`  热搜拉取失败: ${e.message}`);
    return [];
  }
}

async function fetchMovers(cfg, state) {
  if (!cfg.movers?.enabled) return [];
  const today = todayStrTZ(cfg.schedule?.timezone);
  const topN = cfg.movers?.topN ?? 6;
  const minAbsPct = cfg.movers?.minAbsPct ?? 4;
  try {
    const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_change_percentage_24h_desc&per_page=${topN * 3}&page=1&sparkline=false`;
    const arr = await fetchJson(url, {}, 15000);
    if (!Array.isArray(arr) || !arr.length) return [];
    const gainers = [...arr].sort((a, b) => b.price_change_percentage_24h - a.price_change_percentage_24h).slice(0, topN);
    const losers = [...arr].sort((a, b) => a.price_change_percentage_24h - b.price_change_percentage_24h).slice(0, topN);
    const filtered = [...gainers, ...losers].filter((c) => Math.abs(c.price_change_percentage_24h ?? 0) >= minAbsPct);
    if (!filtered.length) { log(`  涨跌榜: 24h 波动均 < ${minAbsPct}%, 跳过`); return []; }
    const items = filtered.map((c) => ({
      sym: (c.symbol || "").toUpperCase(), name: c.name,
      pct: c.price_change_percentage_24h ?? 0, price: c.current_price,
    }));
    log(`  涨跌榜: ${items.length} 个涨跌币(≥${minAbsPct}%)`);
    // 同热搜: id 按当天上榜币种签名, 榜单有变才算新内容。
    return [{ id: `movers_${today}_${items.map((x) => x.sym).join("_")}`, kind: "movers", items, ts: Date.now() }];
  } catch (e) {
    log(`  涨跌榜拉取失败: ${e.message}`);
    return [];
  }
}

// 竞品交易所关键词: 币安广场社区准则禁止"链接/推广其他交易平台", 保守过滤含竞品名的资讯帖
const COMPETITOR_NAMES = [
  "okx", "欧易", "okex",
  "huobi", "火币", "htx",
  "bybit", "币必",
  "gate.io", "gateio", "芝麻开门",
  "bitget",
  "upbit",
  "coinbase",
  "kraken",
  "kucoin", "库币",
  "mexc", "抹茶", "mxc",
  "bingx",
  "phemex",
  "deribit",
  "crypto.com", "gemini", "bitfinex", "bitstamp",
];
const COMPETITOR_DOMAINS = [
  "okx.com", "huobi.com", "htx.com", "bybit.com", "gate.io", "bitget.com",
  "upbit.com", "coinbase.com", "kraken.com", "kucoin.com", "mexc.com",
  "bingx.com", "phemex.com", "deribit.com", "crypto.com", "gemini.com",
  "bitfinex.com", "bitstamp.com",
];
function mentionsCompetitor(text, link) {
  const t = (text || "").toLowerCase();
  for (const c of COMPETITOR_NAMES) if (t.includes(c)) return true;
  if (link) {
    try {
      const host = new URL(link).hostname.toLowerCase();
      for (const d of COMPETITOR_DOMAINS) if (host === d || host.endsWith("." + d)) return true;
    } catch (e) {}
  }
  return false;
}
// 免费 Google 翻译端点(无需 key); 失败回退原文
async function translateText(text, to = "zh-CN") {
  const q = (text || "").trim();
  if (!q) return "";
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${to}&dt=t&q=${encodeURIComponent(q)}`;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": "Mozilla/5.0" } });
    clearTimeout(t);
    if (!r.ok) return text;
    const j = await r.json();
    const zh = (j[0] || []).map((x) => x[0]).join("");
    return zh || text;
  } catch (e) { return text; }
}

// LLM 翻译新闻标题: 质量优于机翻(术语地道、语气中性化), 且结果更稳定。
// 每轮 ≤8 个调用, 与解读 1 次合计 ≤9, 控制在 Agnes 10 RPM 内; 分批(每批 4 个)并发。
// 单条失败 / 无 key / 返回非中文 → 回退 Google 机翻, 再失败英文 A 兜底(三层链)。
async function translateTitlesWithLlm(raw, cfg) {
  const results = new Array(raw.length).fill("");
  const llm = cfg.llm;
  if (llm?.enabled) {
    const key = process.env[llm.apiKeyEnv || "GITHUB_TOKEN"] || llm.apiKey;
    if (key) {
      const system = "你是专业的加密行业新闻编辑。把英文标题翻译成简体中文: 用地道的行业用语, 语气中性, 去掉夸大词和感叹号。只输出译文本身, 不加任何解释、引号或前后缀。";
      const translateOne = async (i) => {
        try {
          const ctrl = new AbortController();
          const t = setTimeout(() => ctrl.abort(), llm.timeoutMs ?? 15000);
          const r = await fetch(`${llm.baseURL}/chat/completions`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
            body: JSON.stringify({
              model: llm.model,
              messages: [{ role: "system", content: system }, { role: "user", content: (raw[i].title || "").trim() }],
              temperature: 0.2,
            }),
            signal: ctrl.signal,
          });
          clearTimeout(t);
          if (!r.ok) return;
          const j = await r.json();
          const text = (j?.choices?.[0]?.message?.content ?? "").trim()
            .replace(/^["'「『]+/, "").replace(/["'」』]+$/, "");
          // 防 LLM 偷懒原样返回: 译文必须含中文字符且不等于原文才算成功
          if (text && /[\u4e00-\u9fff]/.test(text) && text !== (raw[i].title || "").trim()) results[i] = text;
        } catch { /* 回退机翻 */ }
      };
      for (let start = 0; start < raw.length; start += 4) {
        await Promise.all(raw.slice(start, start + 4).map((_, k) => translateOne(start + k)));
      }
    }
  }
  // LLM 没覆盖到的(无 key / 超时 / 校验不过)逐条回退 Google 机翻
  await Promise.all(raw.map(async (r, i) => {
    if (!results[i]) results[i] = await translateText(r.title);
  }));
  return results;
}

// 资讯解读: 用 LLM 针对单条新闻生成有具体指向的中文短评。
// 失败 / 超时 / 未配置 → 返回 null, 由 genNewsPost 走 A 兜底(不加解读与 CTA), 绝不回退到规则套话。
// LLM 解读: 资讯按标题/摘要点评, 热搜/涨跌榜点评榜单结构。
// 硬约束: 只用给定数据, 不编造事实、不猜具体原因、不给买卖建议; 失败返回 null,
// 热搜/涨跌榜回退 takes.js 规则推导, 资讯走 A 兜底。
async function genTake(m, cfg) {
  const llm = cfg.llm;
  if (!llm?.enabled) { log("  LLM 未启用, 走规则推导/兜底"); return null; }
  const key = process.env[llm.apiKeyEnv || "GITHUB_TOKEN"] || llm.apiKey;
  if (!key) { log(`  LLM 跳过: 未找到 API key(${llm.apiKeyEnv || "GITHUB_TOKEN"})`); return null; }
  const system = [
    "你是币安广场一个加密资讯号的运营, 写有观点但不煽动的中文短评。",
    "只用给定的数据, 不编造新事实、不猜具体原因、不预测具体价格、不给买卖建议。",
    "不要用'暴跌/崩盘/狂潮'等煽动词; 控制在 3 句以内; 不要以问号结尾; 不要用'解读:'这类前缀, 直接给正文。",
  ].join("");
  let user;
  if (m.kind === "news") {
    user = `标题: ${m.title}\n摘要: ${m.summary}\n\n写一句有具体指向的点评: 例如这条对哪类参与者影响最大、市场为何这么反应、或接下来该看哪个信号。不要泛泛而谈"等后续数据"。`;
  } else if (m.kind === "trending") {
    const list = m.items.map((x, i) => {
      const chg = x.data?.price_change_percentage_24h?.usd;
      const pct = (typeof chg === "number") ? ` 24h${chg >= 0 ? "+" : ""}${chg.toFixed(1)}%` : "";
      return `${i + 1}. ${x.name}(${x.sym})${pct}`;
    }).join("\n");
    user = `CoinGecko 当前热搜榜:\n${list}\n\n点评这个榜单的结构: 例如哪类板块/主题占主导、榜单反映的市场关注点(只基于榜单数据, 不猜具体原因)。`;
  } else if (m.kind === "movers") {
    const list = m.items.map((x) => `${x.name}(${x.sym}) 24h ${x.pct >= 0 ? "+" : ""}${(x.pct ?? 0).toFixed(1)}%`).join("\n");
    user = `24h 领涨/领跌榜(波动≥4%):\n${list}\n\n点评榜单结构: 例如领涨和领跌各集中在哪类资产、多空两边力量对比(只基于榜单数据, 不猜原因)。`;
  } else {
    return null;
  }
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), llm.timeoutMs ?? 15000);
    const r = await fetch(`${llm.baseURL}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: llm.model,
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
        temperature: 0.6,
        max_tokens: 200,
      }),
      signal: ctrl.signal,
    });
    clearTimeout(t);
    log(`  LLM 请求 ${llm.baseURL}/chat/completions → HTTP ${r.status}`);
    if (!r.ok) { log(`  LLM 解读失败 HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`); return null; }
    const j = await r.json();
    const text = (j?.choices?.[0]?.message?.content ?? "").trim().replace(/\s+/g, " ");
    if (!text) { log(`  LLM 返回空 content(choices=${j?.choices?.length}), 走 A 兜底`); return null; }
    log(`  LLM 解读 OK(${text.length}字)`);
    return text.slice(0, llm.maxChars ?? 130);
  } catch (e) {
    log(`  LLM 解读异常 ${e.message}`);
    return null;
  }
}

async function fetchRssNews(cfg, state) {
  if (!cfg.news?.enabled) return [];
  const feeds = cfg.news?.feeds ?? [];
  if (!feeds.length) return [];
  const limit = cfg.news?.perFeed ?? 2;
  // 选题过滤: 资讯标题含强煽动词 / 未证实传闻时跳过。平台对这类内容限流且易被打"需核查"标;
  // 行情异动 / 涨跌榜由数据驱动, 不在此列。词表可在 config.news.skipWords 增删。
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const skipWords = cfg.news?.skipWords ?? [];
  const skipRe = skipWords.length ? new RegExp(skipWords.map(escapeRe).join("|")) : null;
  const raw = [];
  await Promise.all(feeds.map(async (feed) => {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 12000);
      const res = await fetch(feed.url, {
        signal: ctrl.signal,
        headers: { "User-Agent": "Mozilla/5.0 (compatible; bns-bot/1.0)" },
        redirect: "follow",
      });
      clearTimeout(t);
      if (!res.ok) { log(`  RSS ${feed.name}: HTTP ${res.status}`); return; }
      const xml = await res.text();
      for (const it of parseRss(xml, limit)) {
        const link = it.link || "";
        const text = `${it.title || ""} ${it.summary || ""}`;
        // 币安广场禁止链接/推广其他交易平台, 保守过滤含竞品交易所名的条目
        if (mentionsCompetitor(text, link)) { log(`  过滤竞品帖: ${(it.title || "").slice(0, 30)}`); continue; }
        if (!it.summary) continue; // 无正文摘要的空壳帖不发
        raw.push({ source: feed.name, title: it.title, link, image: it.image, summary: it.summary, ts: it.ts });
      }
    } catch (e) {
      log(`  RSS ${feed.name}: 拉取失败(${e.message})`);
    }
  }));
  // 英文媒体自带摘要: 标题用 LLM 翻译(门面 + 质量关键, 每轮 ≤8 调用, 加解读 1 次卡在 10 RPM 内),
  // 摘要维持免费 Google 机翻(正文细节, 机翻够用)。翻译失败回退英文原文直接发。
  const zhTitles = await translateTitlesWithLlm(raw, config);
  const zhSummaries = await Promise.all(raw.map((r) => translateText(r.summary)));
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    const zhT = (zhTitles[i] || "").trim();
    const zhS = (zhSummaries[i] || "").trim();
    if (!zhT) continue; // 标题为空才跳过(翻译失败回退英文原文, 直接发英文帖)
    // 选题过滤: 资讯标题含强煽动词 / 未证实传闻时跳过, 平台易限流且易被打"需核查"标
    if (skipRe && skipRe.test(zhT)) { log(`  过滤煽动/传言标题: ${zhT.slice(0, 30)}`); continue; }
    // 英文规则没覆盖到、但翻译产物变成中文引流话术时在这里兜底跳过
    if (isPromoSummary(zhS)) { log(`  过滤空壳摘要: ${zhT.slice(0, 30)}`); continue; }
    // 标题或摘要仍是原文 = 翻译失败, 标记英文原帖, 生成文案时不加中文解读段与 CTA, 避免再叠加中文
    const fallback = zhT === (raw[i].title || "").trim()
      || (raw[i].summary && zhS === (raw[i].summary || "").trim());
    // titleEn 保留 RSS 英文原标题: 资讯卡片只渲染 ASCII, 中文翻译标题仍放帖子正文
    out.push({
      // 去重 id 用英文原标题的 hash 而非中文译文: LLM 翻译有轻微不确定性, 同一文章两次
      // 抓取的中文措辞可能微变导致 hash 漂移、重复发帖; 英文原题来自 RSS 源, 是文章的稳定身份。
      id: `news_${hashStr(normalizeText(raw[i].title || ""))}`,
      kind: "news", source: raw[i].source, title: zhT, titleEn: raw[i].title, link: raw[i].link,
      image: raw[i].image, summary: zhS, ts: raw[i].ts,
      lang: fallback ? "en" : "zh",
    });
  }
  log(`  资讯: ${out.length} 条候选(中文, ${feeds.map((f) => f.name).join("/")})`);
  return out;
}

// ---------- 帖子生成(从 templates.js 读词库) ----------

const CASHTAG = (sym) => `$${sym}`;
// 价格格式化: 低价币保留有效数字(如 0.00000452), 不能四舍五入成 0
function fmtPrice(p) {
  const n = Number(p);
  if (!Number.isFinite(n) || n === 0) return "0";
  if (Math.abs(n) >= 1) return n.toLocaleString("en-US", { maximumFractionDigits: n >= 1000 ? 2 : 4 });
  let s = n.toPrecision(4);
  if (/e/i.test(s)) s = n.toFixed(20);
  return s.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}
// 简单去重: 记住最近 N 次用过的句子, 随机时优先跳过, 全撞过再放行
const RECENT_DEPTH = 6;
const recentUsed = { opener: [], closer: [], cta: [] };
function pickFrom(list, slot) {
  const tried = [];
  for (let attempt = 0; attempt < list.length; attempt++) {
    const s = list[Math.floor(Math.random() * list.length)];
    if (!recentUsed[slot].includes(s)) {
      tried.push(s);
      break;
    }
    tried.push(s);
  }
  // 全撞过(列表比 recent 还短), 随机取
  const chosen = (tried.length && tried[0] !== undefined) ? (tried[0] ?? list[Math.floor(Math.random()*list.length)]) : list[Math.floor(Math.random()*list.length)];
  const final = recentUsed[slot].includes(chosen) && tried.length > 1 ? tried[1] : chosen;
  recentUsed[slot].push(final);
  if (recentUsed[slot].length > RECENT_DEPTH) recentUsed[slot].shift();
  return final;
}

function fill(template, data) {
  return template.replace(/\{(\w+)\}/g, (_, k) =>
    data[k] !== undefined ? String(data[k]) : `{${k}}`
  );
}

// 解读段: 由 takes.js 从素材真实数据推导; CTA: 一个开放式提问。
// 受 post.take 控制(默认开); 英文原帖(翻译失败回退)解读段与 CTA 都不加, 避免再叠加中文。
// 关闭时返回空数组, 输出与改动前逐字一致, 便于一键回退。
function takeLines(m, cfg) {
  if (cfg.post?.take === false || m.lang === "en") return [];
  // LLM 预生成的解读优先(m.take, 热搜/涨跌榜/资讯), 没有则回退 takes.js 规则推导
  const take = m.take || buildTake(m);
  return take ? ["", take] : [];
}
// 收尾话术本身已是提问时不再叠加 CTA, 避免连续两个问句
function ctaLines(m, cfg, closer) {
  if (cfg.post?.take === false || m.lang === "en") return [];
  const list = TPL.ctas?.[m.kind] ?? [];
  if (!list.length || /[？?]/.test(closer || "")) return [];
  return ["", pickFrom(list, "cta")];
}

function genMarketPost(m, cfg) {
  const up = m.pct >= 0;
  const coin = CASHTAG(m.baseSymbol);
  const bucket = up ? TPL.marketUp : TPL.marketDown;
  const opener = pickFrom(bucket.openers, "opener");
  const closer = pickFrom(bucket.closers, "closer");

  const lines = [];
  lines.push(`📊 ${coin} ${m.windowMinutes} 分钟${up ? "涨" : "跌"} ${Math.abs(m.pct).toFixed(1)}%`);
  lines.push(`· ${opener}`);
  lines.push(`· 现价 ${fmtPrice(m.price)}`);
  lines.push(`· 成交量放大 ${m.volMultiple} 倍`);
  lines.push(...takeLines(m, cfg));
  lines.push("", closer);
  lines.push(...ctaLines(m, cfg, closer));
  lines.push("", `${coin} #行情异动`);
  return lines.join("\n");
}

function genNewCoinPost(m, cfg) {
  const coin = m.baseAsset;
  const onboard = Number(m.onboardDate);
  const hasOnboard = Number.isFinite(onboard) && onboard > 0;
  const days = hasOnboard ? Math.max(1, Math.round((Date.now() - onboard) / 86400000)) : 1;
  const opener = fill(pickFrom(TPL.newCoin.openers, "opener"), { coin, days });
  // 素材缺上线时间时 days 无意义, 排除含 {days} 的收尾模板, 避免渲染成 "NaN 天"
  const closerPool = hasOnboard
    ? TPL.newCoin.closers
    : TPL.newCoin.closers.filter((s) => !s.includes("{days}"));
  const closer = fill(pickFrom(closerPool, "closer"), { coin, days });

  const lines = [];
  lines.push(`🆕 ${opener}`);
  lines.push(...takeLines(m, cfg));
  lines.push("", closer);
  lines.push(...ctaLines(m, cfg, closer));
  lines.push("", `$${coin} #币安新币`);
  return lines.join("\n");
}

function genTrendingPost(m, cfg) {
  const closer = "热度是情绪不是建议，仓位自己拿主意。";
  const lines = [];
  lines.push("🔥 24 小时热搜币种（大家都在看）");
  lines.push("");
  m.items.slice(0, 6).forEach((it, i) => {
    const chg = it.data?.price_change_percentage_24h?.usd;
    const pct = (typeof chg === "number") ? ` (${chg >= 0 ? "+" : ""}${chg.toFixed(1)}%)` : "";
    lines.push(`${i + 1}. ${it.sym}${pct}`);
  });
  lines.push(...takeLines(m, cfg));
  lines.push("", closer);
  lines.push(...ctaLines(m, cfg, closer));
  lines.push("", "#热搜币种 #加密资讯");
  return lines.join("\n");
}

function genMoversPost(m, cfg) {
  const closer = "极端波动时更要注意风险，别追在尖上。";
  const lines = [];
  const up = m.items.filter((i) => i.pct >= 0).sort((a, b) => b.pct - a.pct);
  const down = m.items.filter((i) => i.pct < 0).sort((a, b) => a.pct - b.pct);
  lines.push("📊 24h 涨跌榜（全市场）");
  lines.push("");
  if (up.length) lines.push("领涨：" + up.slice(0, 5).map((i) => `${i.sym} +${i.pct.toFixed(1)}%`).join(" / "));
  if (down.length) lines.push("领跌：" + down.slice(0, 5).map((i) => `${i.sym} ${i.pct.toFixed(1)}%`).join(" / "));
  lines.push(...takeLines(m, cfg));
  lines.push("", closer);
  lines.push(...ctaLines(m, cfg, closer));
  lines.push("", "#涨跌榜单 #行情异动");
  return lines.join("\n");
}

function genNewsPost(m, cfg) {
  // 不显示文章来源平台名(如 CoinDesk / Cointelegraph): 币安广场对"把用户引向第三方平台"敏感,
  // 帖首挂别家媒体名容易被当成引流。m.source 仅保留在素材里供日志排查, 不渲染。
  // 中文资讯解读由 LLM 在发帖前预生成并存入 m.take; 按你的选择, LLM 不可用 / 英文回退 / 关闭 take 时:
  //   - take=false → 旧固定收尾, 与改动前逐字一致(一键回退);
  //   - 其余 → 不加解读段与 CTA 的 A 兜底(仅标题 + 摘要 + 标签), 干净不公式化。
  const isOff = cfg.post?.take === false;
  const lines = [];
  if (m.title) lines.push(m.title);
  if (m.summary) {
    lines.push("");
    lines.push(m.summary);
  }
  if (isOff) {
    lines.push("", "消息面仅供参考，操作看自己的判断。");
  } else if (m.take) {
    lines.push("", m.take);
    lines.push("", pickFrom(TPL.newsClosers, "closer"));
    lines.push(...ctaLines(m, cfg, m.take));
  }
  lines.push("", "#加密资讯");
  return lines.join("\n");
}

// 热度评分: 事件强度 + 新鲜度, 只用于同一轮多条素材里挑一条发。
// 类型优先级: 行情异动 > 热搜 > 涨跌榜 > 新闻; 各类一天可多条(按内容去重),
// 相邻两条不能同类(选择逻辑见 runOnce)。
function heatScore(m) {
  const ageHours = Math.max(0, (Date.now() - (m.ts ?? Date.now())) / 3600000);
  const freshBonus = Math.max(0, 20 - ageHours); // 越新越高, 20 分封顶
  let base;
  switch (m.kind) {
    case "market":
      // 涨跌幅度 + 量比放大倍数, 异动越猛分越高; base 拉高确保触发态稳压其余类型
      base = 70 + Math.min(40, Math.abs(m.pct ?? 0) * 8) + Math.min(20, (m.volMultiple ?? 1) * 4);
      break;
    case "newCoin":
      base = 90 - Math.min(30, Math.max(0, (Date.now() - (m.onboardDate ?? Date.now())) / 86400000) * 4);
      break;
    case "trending":
      base = 60;
      break;
    case "movers":
      base = 55;
      break;
    case "news":
      base = 40;
      break;
    default:
      base = 10;
  }
  return base + freshBonus;
}

function buildPost(material, cfg) {
  let text;
  switch (material.kind) {
    case "market": text = genMarketPost(material, cfg); break;
    case "newCoin": text = genNewCoinPost(material, cfg); break;
    case "trending": text = genTrendingPost(material, cfg); break;
    case "movers": text = genMoversPost(material, cfg); break;
    case "news": text = genNewsPost(material, cfg); break;
    default: return null;
  }

  // 追加话题: 各 gen*Post 末行已自带该类型的固定标签(如 #行情异动 / #加密资讯)。
  // post.hashtags 只放"所有类型都适用"的通用标签(默认留空), 别把类型专属标签放进来串到别的帖子;
  // 要接到同一行, 全部用空格分隔, 超宽交给客户端自动换行。
  const existing = new Set(text.match(/#[^\s#]+/g) ?? []);
  const extra = (cfg.post?.hashtags ?? []).map((t) => `#${t}`).filter((t) => !existing.has(t));
  if (extra.length) {
    const lines = text.split("\n");
    const last = lines[lines.length - 1] ?? "";
    // 末行是标签行(可选带一个 $币种, 后跟若干 #标签)时直接续上, 否则另起一行
    if (/^\s*(\$[A-Za-z0-9]+\s+)?#[^\s#]+(\s+#[^\s#]+)*\s*$/.test(last)) {
      lines[lines.length - 1] = last.trimEnd() + " " + extra.join(" ");
      text = lines.join("\n");
    } else {
      text += "\n" + extra.join(" ");
    }
  }
  const disclaimer = cfg.post?.disclaimer?.trim();
  if (disclaimer) text += `\n\n${disclaimer}`;

  // 币安官方《新手指南》: 短帖上限 2,100 字符。这里仍保守截在 950 作兜底,
  // 实际五类帖子(含解读段)约 150–350 字符, 远低于上限, 正常不会触发。
  if (text.length > 950) text = text.slice(0, 947) + "…";
  return text;
}

// ---------- 发帖 ----------

async function publishPost(text, imageList) {
  // 纯文本短帖: 只传 bodyTextOnly; 图片短帖(contentType=1): imageList(最多 4 张)
  const body = imageList && imageList.length
    ? { contentType: 1, bodyTextOnly: text, imageList }
    : { bodyTextOnly: text };
  const res = await fetch(
    `${BAPI}/composite/v1/public/pgc/openApi/content/add`,
    {
      method: "POST",
      headers: {
        "X-Square-OpenAPI-Key": config.openApiKey,
        "Content-Type": "application/json",
        clienttype: "binanceSkill",
      },
      body: JSON.stringify(body),
    }
  );
  const data = await res.json();
  return data;
}

// 行情帖尝试配图: 本地生成行情卡片 -> 上传到币安 -> 返回 imageList
// 任何一步失败都返回 null, 由上层降级为纯文本发帖(不影响发帖链路)。
// 下载远程图片为 buffer(供上传币安); 体积/类型异常则抛错, 由上层降级纯文本
async function downloadImage(url, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; bns-bot/1.0)" },
      redirect: "follow",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 1024 || buf.length > 5 * 1024 * 1024) throw new Error(`体积异常 ${buf.length}`);
    return buf;
  } finally {
    clearTimeout(t);
  }
}
// 仅接受 jpg/png(币安上传接口目前只认这两种); 其它格式返回 null 表示不配图
function imageExt(url) {
  const m = /\.(jpg|jpeg|png)(?:[?#]|$)/i.exec(url || "");
  if (!m) return null;
  const e = m[1].toLowerCase();
  return e === "jpeg" ? "jpg" : e;
}

async function tryImageForMaterial(material, cfg) {
  // 默认开, 仅显式 false 才关(避免 Secret 里漏配 imageCard 导致日常配图悄悄不生效)
  if (cfg.post?.imageCard === false) return null;
  try {
    if (material.kind === "market") {
      const buf = makeMarketCard({
        baseSymbol: material.baseSymbol,
        pct: material.pct,
        price: material.price,
        volMultiple: material.volMultiple,
        windowMinutes: material.windowMinutes,
        at: material.ts,
      });
      const url = await uploadImage(cfg.openApiKey, buf, "png");
      log(`  配图: 上传成功 ${url}`);
      return [url];
    }
    // 热搜榜 / 涨跌榜 / 新币: 同样生成卡片图(与行情卡同规格), 失败降级纯文本
    const cardBuilders = {
      trending: () => makeTrendingCard({ items: material.items, at: material.ts }),
      movers: () => makeMoversCard({ items: material.items, at: material.ts }),
      newCoin: () => makeNewCoinCard({
        baseAsset: material.baseAsset, symbol: material.symbol,
        onboardDate: material.onboardDate, at: material.ts,
      }),
    };
    if (cardBuilders[material.kind]) {
      const buf = cardBuilders[material.kind]();
      const url = await uploadImage(cfg.openApiKey, buf, "png");
      log(`  配图: ${material.kind} 卡片上传成功 ${url}`);
      return [url];
    }
    // 资讯帖: news.cardFeeds 列出的源(当前 Cointelegraph)改用自己的生成卡片,
    // 不搬第三方封面上的媒体水印/标识; 其余源仍沿用 RSS 自带配图。
    // 以后发现别的源也有水印, 只需把源名加进 news.cardFeeds, 不用改代码。
    if (material.kind === "news") {
      if ((cfg.news?.cardFeeds ?? []).includes(material.source)) {
        const buf = makeNewsCard({ titleEn: material.titleEn, at: material.ts });
        const url = await uploadImage(cfg.openApiKey, buf, "png");
        log(`  配图: news 卡片上传成功 ${url}`);
        return [url];
      }
      if (material.image) {
        const ext = imageExt(material.image);
        if (!ext) { log("  配图: 非 jpg/png, 跳过"); return null; }
        const buf = await downloadImage(material.image);
        const url = await uploadImage(cfg.openApiKey, buf, ext);
        log(`  配图: 远程图上传成功 ${url}`);
        return [url];
      }
    }
  } catch (e) {
    log(`  配图失败, 降级纯文本: ${e.message}`);
    return null;
  }
  return null;
}

const ERROR_CODES = {
  "20002": "敏感词",
  "20013": "内容超长",
  "20020": "内容为空",
  "20022": "敏感词(带风险段)",
  "20041": "URL 风险",
  "30004": "用户不存在",
  "30008": "违规被禁言",
  "220003": "Key 不存在",
  "220004": "Key 已过期",
  "220009": "当日发帖限额",
  "220010": "内容类型不支持",
  "220011": "正文不能为空",
  "2000001": "账号被永久限制",
  "2000002": "设备被永久限制",
  "10005": "未完成身份认证",
};

// ---------- 主循环 ----------

function canPostNow(state) {
  const now = new Date();
  const todayKey = now.toDateString();
  if (state.todayKey !== todayKey) {
    state.todayKey = todayKey;
    state.todayPosted = 0;
  }
  if (state.todayPosted >= config.postsPerDay) return false;
  const last = state.lastPostAt || 0;
  if (Date.now() - last < config.minIntervalMinutes * 60000) return false;
  return true;
}

// ---------- 时间线排期(可选, 配了 schedule.enabled 就按时间点发) ----------

// 把 某日某天 HH:mm (指定时区) 算成绝对时间戳。
// 原理: 先算目标时区该日的 UTC 偏移(支持 DST), 再反推目标时刻的 UTC。
function tzOffsetMs(dayStr, tz) {
  const [y, m, d] = dayStr.split("-").map(Number);
  const isoDay = y + "-" + String(m).padStart(2, "0") + "-" + String(d).padStart(2, "0");
  const anchorUtc = new Date(isoDay + "T12:00:00Z").getTime();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour12: false, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(anchorUtc);
  const g = (t) => parts.find((p) => p.type === t)?.value ?? "0";
  const wallTs = Date.parse(
    g("year") + "-" + g("month") + "-" + g("day") +
    "T" + g("hour") + ":" + g("minute") + ":" + g("second") + "Z"
  );
  return wallTs - anchorUtc; // 正数=该时区在 UTC 东边
}

function tzHourMinuteToTs(dayStr, hour, minute, tzName) {
  const tz = tzName ?? "Asia/Shanghai";
  const offset = tzOffsetMs(dayStr, tz);
  const [y, m, d] = dayStr.split("-").map(Number);
  const isoDay = y + "-" + String(m).padStart(2, "0") + "-" + String(d).padStart(2, "0");
  const utcGuess = new Date(isoDay + "T00:00:00Z").getTime() + hour * 3600000 + minute * 60000;
  return utcGuess - offset;
}

function todayStrTZ(tzName) {
  const tz = tzName ?? "Asia/Shanghai";
  return new Date().toLocaleDateString("en-CA", { timeZone: tz });
}

function dayPlusOne(dayStr, tzName) {
  const tz = tzName ?? "Asia/Shanghai";
  const d = new Date(dayStr + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + 1);
  // 取该日期在目标时区里的表示
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(d);
  return `${parts.find((p) => p.type === "year").value}-${parts.find((p) => p.type === "month").value}-${parts.find((p) => p.type === "day").value}`;
}

function buildTimeline(state) {
  const s = config.schedule;
  if (!s?.enabled) return null;
  const tz = s.timezone ?? "Asia/Shanghai";
  const dayKey = todayStrTZ(tz);
  // 按需生成(每次调用都算), 但用 state 记录已发进度
  const slots = [];
  const maxPerDay = s.maxPerDay ?? 15;
  // evenSpread: 把 maxPerDay 个 slot 平均铺满 24 小时(从本地 0:00 起), 不设静默期。
  // 15 帖 -> 1440/15 = 96min 一个 slot: 0:00 / 1:36 / 3:12 / ... / 22:24。
  // 关掉这个开关则回到原来的 "startHour 起 + intervalMinutes + quiet" 写法。
  const evenSpread = s.evenSpread === true;
  const intervalMinutes = evenSpread ? (24 * 60) / maxPerDay : (s.intervalMinutes ?? 90);
  const intervalMs = intervalMinutes * 60000;
  const quietFrom = evenSpread ? 0 : (s.quiet?.from ?? 0);
  const quietTo = evenSpread ? 0 : (s.quiet?.to ?? 0);

  // 从起点开始, 每跳 intervalMs 一次, 用"目标时区的日+时分"推进(处理跨天)
  let curDay = dayKey;
  let curH = evenSpread ? 0 : (s.startHour ?? 8);
  let curM = 0;
  for (let i = 0; i < maxPerDay; i++) {
    // 静默期: 落在 [quietFrom, quietTo) 的小时, 推到 quietTo:00(evenSpread 下 0<0 恒不成立)
    if (quietFrom < quietTo && curH >= quietFrom && curH < quietTo) {
      curH = quietTo;
      curM = 0;
    }
    const ts = tzHourMinuteToTs(curDay, curH, curM, tz);
    slots.push(ts);
    // 推进 intervalMs, 换算回目标时区的 日+时分
    const next = new Date(ts + intervalMs);
    const nextParts = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(next);
    const ng = (t) => nextParts.find((p) => p.type === t)?.value ?? "0";
    curDay = ng("year") + "-" + ng("month") + "-" + ng("day");
    curH = ng("hour") === "24" ? 0 : parseInt(ng("hour"), 10);
    curM = parseInt(ng("minute"), 10);
  }

  state.timeline = slots;
  // 进度由 state.timelineSentCount 管理(发一帖 +1), 不再用 timelineIdx 跳格。
  // 注意: 必须用 timelineDay 判断"新的一天", 且先比较、后赋值。
  // 旧写法先执行 state.timelineKey = dayKey, 再判断 timelineKey !== dayKey,
  // 条件永远为假 -> timelineSentCount 跨天不归零, 会一路累加到 15,
  // 之后每天直接返回"slot 用完"而永久停发。
  if (state.timelineSentCount === undefined) state.timelineSentCount = 0;
  if (state.timelineDay !== dayKey) {
    state.timelineSentCount = 0;
    state.timelineDay = dayKey;
  }
  state.timelineKey = dayKey;
  return slots;
}

// 按时间线判断: 锚定式, 错过的 slot 可以追发(只追最近的 1 个)
function timelineGate(state) {
  const s = config.schedule;
  if (!s?.enabled) return { ok: true, msg: "" };
  buildTimeline(state);
  const timeline = state.timeline;
  const now = Date.now();
  let sent = state.timelineSentCount ?? 0;
  if (s.evenSpread) {
    // 均分模式下按时间推进: 已经过去(超过 30min 容错)的 slot 不再补发,
    // 否则一帖没发出去时会永远卡在 0:00 那一格, 每轮都显示"追发 0:00"。
    const passed = timeline.filter((t) => now >= t + 30 * 60000).length;
    // 错过的 slot 最多只领先实际已发数 1 个: 允许后续素材以 cooldown 节奏(约 76min)
    // 把浪费的 slot 逐条追回(不连刷), 同时实现"追发最近 1 个"的初衷, 又不会失控。
    sent = Math.min(Math.max(sent, passed), (state.timelineSentCount ?? 0) + 1);
  }

  // 今天发满了
  if (sent >= timeline.length) {
    return { ok: false, msg: `今日 ${timeline.length} 个 slot 已用完, 明天继续` };
  }

  // 当前应处于的 slot 位置
  // 找第一个"应该到点"的 slot: 即 timeline[i] <= now 的最后一个 i, 且 i >= sent
  // 如果所有 timeline[i] (i>=sent) 都还没到点 -> 等待下一个
  // 如果有些 timeline[i] 已经过了(错过了) -> 允许追发最近的一个(即 timeline[sent])
  const nextDue = timeline[sent];
  if (now >= nextDue) {
    // 到了(或错过了)该发的 slot, 可以发
    const missedMs = now - nextDue;
    if (missedMs > 30 * 60000) {
      log(`  时间线: 追发 1 帖(原 slot ${new Date(nextDue).toLocaleString("zh-CN",{hour12:false})} 已错过 ${Math.round(missedMs/60000)}min, 不连补)`);
    }
    return { ok: true, msg: "" };
  }
  // 还没到, 但 30 分钟内到点 -> 允许提前发(避免 07:58 轮次因差 2 分钟错过 08:00 slot)
  const waitMs = nextDue - now;
  if (waitMs <= 30 * 60000) {
    if (waitMs > 60000) {
      log(`  时间线: 提前补发(原 slot ${new Date(nextDue).toLocaleString("zh-CN",{hour12:false})} 还差 ${Math.round(waitMs/60000)}min, 本轮先发)`);
    }
    return { ok: true, msg: "" };
  }
  // 超过 30 分钟, 等待
  const slotStr = new Date(nextDue).toLocaleString("zh-CN", { hour12: false });
  return { ok: false, msg: `时间线 slot ${slotStr} 未到(还差 ${Math.round(waitMs/60000)}min), 等待` };
}

// 每天首次到点轮次按 24h 成交额刷新监控币种池。
// Secret 里的 market.symbols 只是初始快照, 结果存 state.json 才能跨 runner 持久。
async function refreshSymbolPoolIfNeeded(state) {
  const poolCfg = config.market?.symbolPool ?? {};
  if (poolCfg.autoRefresh === false) return;

  const today = todayStrTZ(config.schedule?.timezone);
  if (state.symbolsUpdatedAt === today && Array.isArray(state.symbols) && state.symbols.length) {
    config.market.symbols = state.symbols;
    log(`币种池: 今日(${today})已刷新, 沿用 ${state.symbols.length} 个`);
    return;
  }

  const topN = poolCfg.topN ?? config._symbolsAuto?.topN ?? DEFAULT_TOP_N;
  const minUsd = poolCfg.minUsd ?? config._symbolsAuto?.minUsd ?? DEFAULT_MIN_USD;
  try {
    const { symbols } = await fetchSymbolPool({ topN, minUsd });
    config.market.symbols = symbols;
    state.symbols = symbols;
    state.symbolsUpdatedAt = today;
    state.symbolsMeta = { topN, minUsd, updatedAt: Date.now() };
    log(`币种池: 今日首次刷新, 24h 成交额前 ${symbols.length} 个(≥${minUsd / 1e6}M USDT): ${symbols.join(", ")}`);
  } catch (e) {
    // 刷新失败不阻断发帖: 沿用上次持久化的池子, 没有则沿用 Secret 里的初始值
    const fallback = Array.isArray(state.symbols) && state.symbols.length
      ? state.symbols : config.market.symbols;
    config.market.symbols = fallback;
    log(`币种池: 刷新失败(${e.message}), 沿用 ${fallback.length} 个, 下个 slot 再试`);
  }
}

async function runOnce() {
  log(`\n=== 开始一轮 @ ${new Date().toLocaleString("zh-CN", { hour12: false })}`);
  const state = loadState();
  const forceMode = process.argv.includes("--force") || process.env.FORCE === "true";
  log(`▶ forceMode=${forceMode} argv=[${process.argv.slice(2).join(" ")}] FORCE_env=${process.env.FORCE ?? ""}`);

  // 1. 先判节奏再抓接口: 没到发帖时点就零请求退出, 且完全不改动 state,
  //    GitHub Actions 也不会为这种空转轮次提交 state.json。
  //    抓取频率从每 15 分钟一次降到每个 slot(默认 90min)一次。
  if (config.schedule?.enabled && !forceMode) {
    const gate = timelineGate(state);
    if (!gate.ok) {
      log(`时间线: ${gate.msg}, 本轮不抓接口也不发帖`);
      return;
    }
  } else if (!forceMode && !canPostNow(state)) {
    log(`节奏未到 (今日已发 ${state.todayPosted}/${config.postsPerDay}, 最小间隔 ${config.minIntervalMinutes}min), 本轮不抓接口也不发帖`);
    return;
  }

  // 按周期冷却: 一个 slot 周期内只抓一次接口。
  // 用「上次抓取时间戳」而不是「已发数量」做 key —— 后者在一帖都没发出去时
  // 永远不变, 会让当天后续 slot 全被挡住(没素材时整天只抓取一次)。
  // --force 手动验证: 跳过抓取冷却, 直接抓素材发帖。
  if (config.schedule?.enabled && !forceMode) {
    const s = config.schedule;
    const intervalMs = (s.evenSpread
      ? (24 * 60) / (s.maxPerDay ?? 15)
      : (s.intervalMinutes ?? 90)) * 60000;
    // 留 20 分钟余量, 让"提前 30 分钟补发"窗口里的下一个 slot 仍能按点抓到
    const cooldownMs = Math.max(30 * 60000, intervalMs - 20 * 60000);
    const gapMin = state.lastFetchAt
      ? Math.round((Date.now() - state.lastFetchAt) / 60000)
      : Infinity;
    if (gapMin < cooldownMs / 60000) {
      log(`距上次抓取 ${gapMin}min < ${Math.round(cooldownMs / 60000)}min, 跳过`);
      return;
    }
    state.lastFetchAt = Date.now();
  }

  // 到点了才写时间戳: 状态文件变化 → workflow 提交持久化 + 保持仓库活动
  state.lastRunAt = Date.now();

  // 1.5 每天首次到点轮次自动刷新币种池(空转轮次走不到这里)
  await refreshSymbolPoolIfNeeded(state);

  // 2. 抓全部素材(并行拉)。所有抓取共享同一个 state 对象, 由本函数结尾统一落盘,
  //    避免并发写文件互相覆盖。
  const [marketMoves, newCoins, trending, movers, newsRss] =
    await Promise.all([
      fetchMarketMove(config),
      fetchNewCoins(config, state),
      fetchTrending(config, state),
      fetchMovers(config, state),
      fetchRssNews(config, state),
    ]);

  const candidates = [
    ...marketMoves, ...newCoins,
    ...trending, ...movers, ...newsRss,
  ];

  // --force 模式: 没素材时用实时真实数据造一条行情帖(不用假数字, 避免虚假消息)
  if (candidates.length === 0 && forceMode) {
    try {
      const d = await fetchJson(`${BINANCE_API}/api/v3/ticker/24hr?symbol=BTCUSDT`);
      candidates.push({
        id: `force_${Date.now()}`, kind: "market", symbol: "BTCUSDT", baseSymbol: "BTC",
        pct: parseFloat(d.priceChangePercent), price: parseFloat(d.lastPrice),
        volMultiple: 1, windowMinutes: 24, isForce: true,
      });
      log("--force: 用实时 BTC 数据造一条帖(真实价格)");
    } catch (e) {
      log(`--force: 拉实时数据失败(${e.message}), 不发假帖, 跳过本轮`);
      saveState(state);
      return;
    }
  }

  // 3. 去重(素材 id 没发过)
  const seen = new Set(state.postedMaterialIds);
  const fresh = candidates.filter((c) => !seen.has(c.id));
  log(`素材: 行情 ${marketMoves.length} / 新币 ${newCoins.length} / 热搜 ${trending.length} / 涨跌 ${movers.length} / 资讯 ${newsRss.length} = 共 ${fresh.length} 条未发`);

  if (fresh.length === 0) {
    log("没有新素材, 本轮不发帖");
    saveState(state);
    return;
  }

  // 4. 热度排序: 多条候选只发热度最高的那一条
  const scored = fresh
    .map((m) => ({ m, score: heatScore(m) }))
    .sort((a, b) => b.score - a.score);
  if (scored.length > 1) {
    log(`  本轮 ${scored.length} 条候选热度: ${scored.map(({ m, score }) => `${m.kind}:${score.toFixed(1)}`).join(" / ")}`);
  }
  // 相邻两条不能同类: 上一条发了 A 类, 本轮改发次高分的其它类; 只剩 A 类可选时仍发它(避免空轮)。
  const lastKind = (state.postHistory ?? []).slice(-1)[0]?.kind;
  let material = scored[0].m;
  if (lastKind && scored.length > 1) {
    const alt = scored.find(({ m }) => m.kind !== lastKind);
    if (alt) material = alt.m;
  }
  // 中文资讯/热搜/涨跌榜在真实发帖前调 LLM 生成解读, 存入 material.take;
  // 失败 / 英文资讯 / 关 take / dryRun 时留空: 热搜/涨跌榜回退规则推导, 资讯走 A 兜底。
  // 行情异动与新币不用 LLM: 数字即信息, LLM 没有实时消息面, 硬凑观点只会是套话或编造。
  const TAKE_KINDS = ["news", "trending", "movers"];
  if (TAKE_KINDS.includes(material.kind)
      && (material.kind !== "news" || material.lang === "zh")
      && config.post?.take !== false && !config.dryRun) {
    log(`→ 触发 LLM 解读(${material.kind}${material.kind === "news" ? "/zh" : ""})`);
    material.take = await genTake(material, config);
    log(`← LLM 解读结果: ${material.take ? `OK(${material.take.length}字)` : "null(规则推导/兜底)"}`);
  }
  const text = buildPost(material, config);
  log(`本轮待发 [${material.kind}]:\n${text}`);

  if (config.dryRun && !forceMode) {
    log("▶ dryRun 模式, 不真发。加 --force 可强制发这条");
    saveState(state);
    return;
  }

  // 5. 发帖(卡片/资讯素材尝试配图, 失败自动降级纯文本)
  const imageList = await tryImageForMaterial(material, config);
  const result = await publishPost(text, imageList);
  if (result.code === "000000" || result.code === 0) {
    state.lastPostAt = Date.now();
    state.todayPosted++;
    markUsed(state, material.id);
    if (config.schedule?.enabled) state.timelineSentCount = (state.timelineSentCount ?? 0) + 1;
    state.postHistory = state.postHistory ?? [];
    state.postHistory.push({
      id: result.data?.id,
      kind: material.kind,
      at: Date.now(),
      text: text.slice(0, 200),
    });
    state.postHistory = state.postHistory.slice(-50);
    saveState(state);
    log(`✅ 发帖成功, id=${result.data?.id}`);
    log(`   https://www.binance.com/square/post/${result.data?.id}`);
  } else {
    const msg = ERROR_CODES[String(result.code)] ?? result.message ?? "未知错误";
    log(`❌ 发帖失败 code=${result.code} (${msg})`);
    if (["220009", "30008", "2000001", "2000002"].includes(String(result.code))) {
      log("额度/风控问题, 停止本轮");
    }
    saveState(state);
  }
}

async function testPost() {
  log("测试发帖接口(真发一条测试帖)");
  const text = `bns-bot 链路测试 ${new Date().toLocaleString("zh-CN", { hour12: false })}\n#行情异动`;
  const r = await publishPost(text);
  if (r.code === "000000" || r.code === 0) {
    log(`✅ 接口通, 发帖成功 id=${r.data?.id}`);
  } else {
    log(`❌ 接口不通 code=${r.code} msg=${r.message} (${ERROR_CODES[String(r.code)] ?? ""})`);
  }
}

// 验证图片帖链路: 用模拟行情数据生成卡片 → 上传 → 带图发布一条测试帖。
// 用于确认 presigned 上传 + content/add(imageList) 整条链路可用, 不依赖真实行情异动触发。
async function testImagePost() {
  log("测试图片帖链路(生成行情卡片 → 上传 → 带图发布一条测试帖)");
  try {
    const buf = makeMarketCard({
      baseSymbol: "BTC",
      pct: 3.2,
      price: 67234.5,
      volMultiple: 3.1,
      windowMinutes: 60,
      at: Date.now(),
    });
    const url = await uploadImage(config.openApiKey, buf, "png");
    log(`  卡片上传成功: ${url}`);
    const text = `bns-bot 图片帖链路测试 ${new Date().toLocaleString("zh-CN", { hour12: false })}\n#行情异动`;
    const r = await publishPost(text, [url]);
    if (r.code === "000000" || r.code === 0) {
      log(`✅ 图片帖发布成功 id=${r.data?.id}`);
      log(`   https://www.binance.com/square/post/${r.data?.id}`);
    } else {
      log(`❌ 图片帖发布失败 code=${r.code} (${ERROR_CODES[String(r.code)] ?? r.message})`);
    }
  } catch (e) {
    log(`❌ 图片帖链路失败: ${e.message}`);
  }
}

async function main() {
  log("bns-bot 启动");
  log(`模式: ${config.dryRun ? "dryRun(不真发)" : "真发"}`);
  if (config.schedule?.enabled) {
    const s = config.schedule;
    if (s.evenSpread) {
      const step = Math.round((24 * 60) / (s.maxPerDay ?? 15));
      log(`节奏: 24h 均分, 0:00 起每 ${step}min 一 slot, 每天 ${s.maxPerDay} slot, 无静默`);
    } else {
      const quiet = s.quiet?.from !== undefined ? `静默 ${s.quiet.from}:00-${s.quiet.to}:00` : "无静默";
      log(`节奏: 时间线排期 ${s.startHour}:00 起, 每 ${s.intervalMinutes}min 一 slot, 每天 ${s.maxPerDay} slot, ${quiet}`);
    }
  } else {
    log(`节奏: 非时间线模式, 每天 ≤${config.postsPerDay} 帖, 最小间隔 ${config.minIntervalMinutes}min`);
  }
  log(`监控: ${config.market.symbols.join(", ")} (${config.market.windowMinutes}min 内 ${config.market.priceChangePct}% + 量比 ${config.market.volSpikeMultiple}x)`);

  if (process.argv.includes("--test-image")) {
    await testImagePost();
    return;
  }
  if (process.argv.includes("--test")) {
    await testPost();
    return;
  }
  await runOnce();
  log("单次跑完, 退出");
  // 无服务器环境必须明确退出, 避免残留 handle 让 job 挂到超时
  await new Promise((r) => setTimeout(r, 50));
  process.exit(0);
}

main().catch((e) => {
  log("FATAL", e);
  process.exit(1);
});
