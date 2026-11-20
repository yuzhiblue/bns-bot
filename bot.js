#!/usr/bin/env node
/**
 * bns-bot — 币安广场自动发帖机器人（GitHub Actions 纯云端单次模式）
 * 抓取行情异动 / 热搜榜 / 涨跌榜 / 资讯 RSS / Foresight / 形态突破 / 币安合约涨跌榜 → 生成带 $币种 的帖子 → 调官方 OpenAPI 发布
 *
 * 每次运行只跑一轮就退出, 由外部定时器(CNB, 每 15 分钟 POST workflow_dispatch)唤起;
 * 状态靠 state.json 持久化,
 * 配置: 仓库 config.json 为基准(不含 Key), 云端由 workflow 把 Secret 里的 openApiKey 注入;
 * 本地可放 config.local.json(含 Key, gitignore, 优先)。没有常驻进程、没有长连接。
 *
 * 用法:
 *   node bot.js            跑一轮(workflow 里写作 node bot.js --once, --once 为兼容参数)
 *   node bot.js --force    强制发一条(绕过时间线/节奏/抓取冷却/类型冷却, 用于手动验证);
 *                          没素材时用实时行情造一条
 *   node bot.js --test     发一条测试帖验发帖接口
 */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const TPL = require("./templates");
const { buildTake } = require("./takes");
const { fetchSymbolPool, SHELL_BASES, DEFAULT_TOP_N, DEFAULT_MIN_USD } = require("./symbolPool");
const { uploadImage } = require("./squareMedia");
const { makeMarketCard, makeTrendingCard, makeMoversCard, makeNewsCard, makeDataCard } = require("./imageCard");

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
const MOVERS_API = "https://info.qianyuwing.com/api/tickers?type=crypto";

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
  // 与其它 9 个源一致的可选开关; 默认开(省略 enabled 时照常工作)
  if (cfg.market?.enabled === false) return [];
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
            // id 用小时级时间桶: 同一币种一天内可因多次独立异动多次发帖(每次都是新内容);
            // 不用更细粒度是防止相邻 slot 窗口重叠时把同一段行情当两条发。
            id: `market_${symbol}_${new Date(t0).toISOString().slice(0, 13)}`,
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

async function fetchTrending(cfg) {
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

async function fetchMovers(cfg) {
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

// ---------- 形态素材源(公开接口, 零 key) ----------
// 每个源失败一律 return [], 不影响其它素材; id 用"日期桶 + 触发对称名"做去重, 一天同类最多 1 条。
const todayKey = () => todayStrTZ(config.schedule?.timezone);
// 分批并发: 形态源要拉全池 klines, 若同时 Promise.all 全部币,
// 轻则被限流重则 fetch failed(实测主循环里 32 个并发请求会挂)。每批 4 个稳。
async function mapInBatches(items, batchSize, fn) {
  const out = new Array(items.length);
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const res = await Promise.all(batch.map((x, k) => fn(x, i + k)));
    res.forEach((v, k) => { out[i + k] = v; });
  }
  return out;
}

// 形态突破: 监控池每币拉 1d klines(21 根), 今日高/低破前 20 日高低则触发。
async function fetchBreakout(cfg) {
  if (!cfg.breakout?.enabled) return [];
  const symbols = (cfg.market?.symbols ?? []).slice(0, cfg.breakout?.maxCheck ?? 16);
  const lookback = cfg.breakout?.lookbackDays ?? 20;
  try {
    const results = await mapInBatches(symbols, 4, async (sym) => {
      const arr = await fetchJson(`${BINANCE_API}/api/v3/klines?symbol=${sym}&interval=1d&limit=${lookback + 1}`, {}, 15000);
      if (!Array.isArray(arr) || arr.length < lookback + 1) return null;
      const prev = arr.slice(0, -1);
      const cur = arr[arr.length - 1];
      const maxHigh = Math.max(...prev.map((k) => Number(k[2])));
      const minLow = Math.min(...prev.map((k) => Number(k[3])));
      const high = Number(cur[2]), low = Number(cur[3]), close = Number(cur[4]);
      if (high > maxHigh) return { sym: sym.replace(/USDT$/, ""), dir: "high", price: close, level: maxHigh, lookback, ts: Number(cur[0]) };
      if (low < minLow) return { sym: sym.replace(/USDT$/, ""), dir: "low", price: close, level: minLow, lookback, ts: Number(cur[0]) };
      return null;
    });
    const hits = results.filter(Boolean).slice(0, cfg.breakout?.topN ?? 3);
    if (!hits.length) { log(`  形态: ${symbols.length} 个币无 ${lookback} 日突破, 跳过`); return []; }
    log(`  形态突破: ${hits.map((x) => `${x.sym} ${x.dir === "high" ? "新高" : "新低"}`).join(" / ")}`);
    return [{ id: `breakout_${todayKey()}_${hits.map((x) => x.sym + x.dir).join("_")}`, kind: "breakout", items: hits, ts: Date.now() }];
  } catch (e) {
    log(`  形态突破拉取失败: ${e.message}`);
    return [];
  }
}

// 币安合约涨跌榜: 走第三方聚合(info.qianyuwing.com)绕过 fapi.binance.com 的 runner 451。
// 只取 exchange === "binance-perp" 的币安永续, 严格排除 okx / bybit / bitget / mexc / gate 等其他所,
// 避免把竞品交易所的交易对带进币安广场帖。
async function fetchBinanceMovers(cfg) {
  if (!cfg.binanceMovers?.enabled) return [];
  try {
    const j = await fetchJson(MOVERS_API, {}, 20000);
    const arr = Array.isArray(j?.items) ? j.items : [];
    if (!arr.length) return [];
    const minUsd = cfg.binanceMovers?.minUsd ?? 5e7;
    const rows = arr
      .filter((x) => x.exchange === "binance-perp" && x.kind === "perp")
      .filter((x) => String(x.symbol ?? "").endsWith("USDT") && !SHELL_BASES.has(String(x.base ?? "")))
      .filter((x) => Number(x.quote_volume) >= minUsd)
      .map((x) => ({ sym: String(x.base), pct: Number(x.change_pct), price: Number(x.price) }))
      .filter((x) => x.sym && Number.isFinite(x.pct));
    if (!rows.length) { log("  合约榜(币安): 无符合条件的交易对, 跳过"); return []; }
    const topN = cfg.binanceMovers?.topN ?? 5;
    const up = [...rows].sort((a, b) => b.pct - a.pct).slice(0, topN);
    const down = [...rows].sort((a, b) => a.pct - b.pct).slice(0, topN);
    log(`  合约榜(币安): 领涨 ${up.map((x) => x.sym).join("/")} 领跌 ${down.map((x) => x.sym).join("/")}`);
    return [{
      id: `bmovers_${todayKey()}_${[...up, ...down].map((x) => x.sym + x.pct.toFixed(0)).join("_")}`,
      kind: "binanceMovers", up, down, ts: Date.now(),
    }];
  } catch (e) {
    log(`  合约榜(币安)拉取失败: ${e.message}`);
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
// 平台公告/平台自身新闻过滤: 标题同时命中"平台主体"和"动作"才跳过。
// 只拦平台自己发的操作(上线交易对/下架/平台币/财报/牌照等), 行情、链上数据、
// 机构产品(如富途家族信托)、他方事件(如币安黑客钱包被转移)都不含平台主体+动作组合, 保留。
// 开关与词表在 config.news: skipPlatformNotices / platformNames / platformActions。
function isPlatformNotice(title, cfg) {
  if (cfg.news?.skipPlatformNotices === false) return false;
  const names = cfg.news?.platformNames ?? [];
  const actions = cfg.news?.platformActions ?? [];
  if (!names.length || !actions.length) return false;
  const t = String(title ?? "").toLowerCase();
  return names.some((w) => t.includes(String(w).toLowerCase()))
      && actions.some((w) => t.includes(String(w).toLowerCase()));
}
// 低价值题材过滤: 一条规则里的词全部命中才跳过(规则间 OR), 比单关键词更不容易误伤。
// 拦的是"看不懂/跟交易无关"的资讯: 协议技术细节(EIP/Gas 提案)、机构持仓披露、
// 娱乐八卦。与 skipWords(情绪词)、skipPlatformNotices(平台公告) 互补, 都只看资讯标题。
// 开关与规则在 config.news: skipLowValueTopics / skipTopicRules。
function isLowValueTopic(title, cfg) {
  if (cfg.news?.skipLowValueTopics === false) return false;
  const rules = cfg.news?.skipTopicRules ?? [];
  if (!rules.length) return false;
  const t = String(title ?? "").toLowerCase();
  return rules.some((rule) => {
    const words = (Array.isArray(rule) ? rule : []).map((w) => String(w).toLowerCase());
    return words.length > 0 && words.every((w) => t.includes(w));
  });
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

// 统一的 LLM chat 调用: 超时/鉴权/响应解析集中在这里,
// 三个调用方(标题翻译/榜单解读/资讯整帖改写)只负责拼 prompt 与后校验。
// 返回 content 文本; 未启用 / 无 key / 失败 / 空 content 一律返回 null, 由调用方自行降级。
async function llmChat(cfg, system, user, { temperature = 0.6, maxTokens = 200, label = "LLM" } = {}) {
  const llm = cfg.llm;
  if (!llm?.enabled) { log(`  ${label} 未启用`); return null; }
  const key = process.env[llm.apiKeyEnv || "GITHUB_TOKEN"] || llm.apiKey;
  if (!key) { log(`  ${label} 跳过: 未找到 API key(${llm.apiKeyEnv || "GITHUB_TOKEN"})`); return null; }
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), llm.timeoutMs ?? 15000);
    const r = await fetch(`${llm.baseURL}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: llm.model,
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
        temperature,
        max_tokens: maxTokens,
      }),
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!r.ok) { log(`  ${label} 失败 HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`); return null; }
    const j = await r.json();
    const text = (j?.choices?.[0]?.message?.content ?? "").trim();
    if (!text) { log(`  ${label} 返回空 content`); return null; }
    return text;
  } catch (e) {
    log(`  ${label} 异常 ${e.message}`);
    return null;
  }
}

// LLM 翻译新闻标题: 质量优于机翻(术语地道、语气中性化), 且结果更稳定。
// 每轮 ≤8 个调用, 与解读 1 次合计 ≤9, 控制在 Agnes 10 RPM 内; 分批(每批 4 个)并发。
// 单条失败 / 无 key / 返回非中文 → 回退 Google 机翻, 再失败英文 A 兜底(三层链)。
async function translateTitlesWithLlm(raw, cfg) {
  const results = new Array(raw.length).fill("");
  const system = "你是专业的加密行业新闻编辑。把英文标题翻译成简体中文: 用地道的行业用语, 语气中性, 去掉夸大词和感叹号。只输出译文本身, 不加任何解释、引号或前后缀。";
  const translateOne = async (i) => {
    const text = await llmChat(cfg, system, (raw[i].title || "").trim(), { temperature: 0.2, maxTokens: 100, label: "LLM 翻译" });
    if (!text) return;
    const clean = text.replace(/^["'「『]+/, "").replace(/["'」』]+$/, "");
    // 防 LLM 偷懒原样返回: 译文必须含中文字符且不等于原文才算成功
    if (clean && /[\u4e00-\u9fff]/.test(clean) && clean !== (raw[i].title || "").trim()) results[i] = clean;
  };
  // 分批(每批 4 个)并发, 控制 RPM
  for (let start = 0; start < raw.length; start += 4) {
    await Promise.all(raw.slice(start, start + 4).map((_, k) => translateOne(start + k)));
  }
  // LLM 没覆盖到的(无 key / 超时 / 校验不过)逐条回退 Google 机翻
  await Promise.all(raw.map(async (r, i) => {
    if (!results[i]) results[i] = await translateText(r.title);
  }));
  return results;
}

// 榜单解读: 热搜/涨跌榜由 LLM 点评榜单结构。
// 硬约束: 只用给定数据, 不编造事实、不猜具体原因、不给买卖建议; 失败返回 null,
// 回退 takes.js 规则推导。资讯的解读走 genNewsRewrite(整帖改写), 不经过本函数。
async function genTake(m, cfg) {
  const system = [
    "你是币安广场一个加密资讯号的运营, 写有观点但不煽动的中文短评。",
    "只用给定的数据, 不编造新事实、不猜具体原因、不预测具体价格、不给买卖建议。",
    "不要用'暴跌/崩盘/狂潮'等煽动词; 控制在 3 句以内; 不要以问号结尾; 不要用'解读:'这类前缀, 直接给正文。",
  ].join("");
  let user;
  if (m.kind === "trending") {
    const list = m.items.map((x, i) => {
      const chg = x.data?.price_change_percentage_24h?.usd;
      const pct = (typeof chg === "number") ? ` 24h${chg >= 0 ? "+" : ""}${chg.toFixed(1)}%` : "";
      return `${i + 1}. ${x.name}(${x.sym})${pct}`;
    }).join("\n");
    user = `CoinGecko 当前热搜榜:\n${list}\n\n点评这个榜单: 点名 1-2 个具体币种及其 24h 涨跌幅, 再说榜单结构(涨跌分布、主流币还是中小市值占多数、热度是否集中在个别币)。只陈述榜单里有的数据, 不猜原因、不给买卖建议; 2-3 句, 不要用"热搜排名反映的是注意力"这类空泛套话, 不要以问号结尾。`;
  } else if (m.kind === "movers") {
    const list = m.items.map((x) => `${x.name}(${x.sym}) 24h ${x.pct >= 0 ? "+" : ""}${(x.pct ?? 0).toFixed(1)}%`).join("\n");
    user = `24h 领涨/领跌榜(波动≥4%):\n${list}\n\n点评榜单结构: 点名领涨和领跌各 1 个具体币种及涨跌幅, 再说双方数量对比和集中度。只基于榜单数据, 不猜原因、不给买卖建议; 2-3 句, 不用空泛套话, 不要以问号结尾。`;
  } else if (m.kind === "binanceMovers") {
    const fmt = (x) => `${x.sym} ${(x.pct ?? 0) >= 0 ? "+" : ""}${(x.pct ?? 0).toFixed(1)}%`;
    const ups = (m.up ?? []).map(fmt).join(" / ");
    const downs = (m.down ?? []).map(fmt).join(" / ");
    user = `币安永续合约 24h 涨跌榜(仅币安, 已排除其他交易所):\n领涨: ${ups || "无"}\n领跌: ${downs || "无"}\n\n点评这份榜单, 必须给出能从数字核对的具体关系, 不要写感想:\n1. 点名涨幅第一和跌幅第一的币种及具体涨跌幅;\n2. 比较领涨第一和第二的差距——是断层领先还是咬得很近;\n3. 比较领涨端和领跌端谁的波动更极端;\n4. 指出是否单边(某一端没有币达到波动门槛)。\n只陈述榜单里有的数据, 不猜原因、不给买卖建议、不预测价格; 2-3 句; 不要以问号结尾。\n严禁写"合约带杠杆""涨得急回撤也快""榜单只是快照""看个热闹""背后的资金动向才是重点""市场情绪起落快"这类能套到任何一天的通用句。`;
  } else {
    return null;
  }
  // 合约榜要点名多个数字、做两侧比较, 130 字容易截断, 单独放宽字数与 token 预算
  const deep = m.kind === "binanceMovers";
  const opts = { temperature: 0.6, maxTokens: deep ? 280 : 200 };
  let text = await llmChat(cfg, system, user, { ...opts, label: "LLM 解读" });
  if (!text) {
    log("  LLM 解读首次失败, 重试一次");
    text = await llmChat(cfg, system, user, { ...opts, label: "LLM 解读重试" });
  }
  if (!text) return null;
  const clean = text.replace(/\s+/g, " ");
  log(`  LLM 解读 OK(${clean.length}字)`);
  return clean.slice(0, deep ? 190 : (cfg.llm?.maxChars ?? 130));
}

// LLM 整帖改写: 把新闻标题+摘要改写成口语化的个人分享帖, 降低"搬运"判定风险。
// 硬约束: 事实只来自给定标题与摘要, 数字/日期/人名/机构名原样保留, 不编造细节或延伸事实,
// 不给买卖建议, 不用煽动词, 2-4 句。失败返回 null 走 A 兜底(标题+摘要拼接)。
// 起手方式池: 每条随机抽一种注入 prompt, 让 LLM 不在同一几个口头语里打转。
const NEWS_OPENERS = [
  "从这条新闻里最关键的数字起笔",
  "先说清楚是谁做了什么",
  "先交代事情发生在什么时候",
  "先给一句不带评价的事实陈述",
  "先挑跟行情最相关的一点",
  "先说结果, 再补背景",
  "从涉及的币种或市场切入",
];
async function genNewsRewrite(m, cfg) {
  const system = [
    "你是币安广场上的一个加密老玩家, 用自己的口气把新闻改写成一条随手分享的个人帖。",
    "硬性要求: 事实只来自给定内容, 百分比/金额/具体数量等关键数字以及人名、机构名必须逐字原样保留(不得改写形式、加减修饰词), 绝不编造细节或延伸事实;",
    "新闻里的发布时间(如'11月18日消息')可以口语化省略或说成'日前', 不必原样保留; 但事件本身发生的日期(如上线的具体日期)必须保留;",
    "不要用'我'来表达对行情或资产的观点——新闻人物的观点要明确标注是谁说的(如'他认为'), 不能当成发帖人自己的判断;",
    "不要用'讲真/有意思的是/这事儿挺意外/懂的都懂/看来/有点意思/挺意外/确实挺有意思'这类被用滥的口头语——每帖冒出一次反而像机器模板, 整条一句口头语都没有也完全没问题;",
    "开头直接从事实、具体数字、人物动作或时间切入, 别用评价式套语开场; 每条换一种起手方式, 句子短一点, 别堆长定语;",
    "结尾别固定加总结式评价('数字摆在这里/摆在那里'、'值得关注'、'算是...信号'、'更值得关注'这类), 说完事实就停或只留一句很短的自然感受;",
    "口语化、有自然过渡, 像个人观察而不是新闻稿; 2 到 4 句; 不用'暴跌/崩盘/狂潮'等煽动词;",
    "不给买卖建议; 不以问号结尾; 不要用'解读:'这类前缀; 不要加任何话题标签。",
  ].join("");
  const opener = NEWS_OPENERS[Math.floor(Math.random() * NEWS_OPENERS.length)];
  const user = `新闻标题: ${m.title}\n新闻摘要: ${m.summary}\n\n按系统要求把这条新闻改写成一条分享帖。这次优先从"${opener}"的角度切入, 但别在帖子里提这个要求。`;
  const raw = await llmChat(cfg, system, user, { temperature: 0.5, maxTokens: 300, label: "LLM 改写" });
  if (!raw) return null;
  const text = raw.replace(/\s+/g, " ");
  if (!/[\u4e00-\u9fff]/.test(text) || text.length < 20) {
    log("  LLM 改写结果无效, 走 A 兜底");
    return null;
  }
  // 确定性校验: 只校验"事实数字"——百分比 / 金额 / 带数量词的数字, 防止 LLM 改写时丢或改关键事实。
  // 先剥掉日期(11月18日/2026年)、时间(11:00)、时长(19个月/24小时)、代号(EWJB 里的数字)再抽,
  // 否则公告类新闻数字极密集(日期+时间+代码+数量), LLM 口语化后必然触发缺失、100% 走 A 兜底发搬运帖。
  // 注: "19个月"若被正则切出"19个"会误杀改写, 时长属可口语化的时间表述, 一并剥掉。
  const src = `${m.title} ${m.summary}`;
  const factNums = src
    .replace(/\d{4}年\d{1,2}月\d{1,2}日/g, " ")
    .replace(/\d{1,2}月\d{1,2}日/g, " ")
    .replace(/\d{4}年/g, " ")
    .replace(/\d+(?:\.\d+)?\s*(?:个月|小时|天|分钟)/g, " ")
    .replace(/\d{1,2}:\d{2}(:\d{2})?/g, " ")
    .match(/\d[\d,.]*(?:%|亿|万|美元|个|枚|只|家|笔|次|倍|种|项|对|天|小时)/g) ?? [];
  // LLM 中文输出常在数字与单位间留空格(如"5000 万美元"、"19 个"), 比对时忽略空白,
  // 但数字本身仍必须逐字一致, 改错(5000万→6000万)照样拦截。
  const compact = text.replace(/\s+/g, "");
  const missing = factNums.filter((n) => !compact.includes(n));
  if (missing.length) {
    log(`  LLM 改写丢失关键数字(${missing.join(", ")}), 走 A 兜底`);
    return null;
  }
  log(`  LLM 改写 OK(${text.length}字)`);
  return text;
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
        raw.push({ source: feed.name, lang: feed.lang === "zh" ? "zh" : "en", title: it.title, link, image: it.image, summary: it.summary, ts: it.ts });
      }
    } catch (e) {
      log(`  RSS ${feed.name}: 拉取失败(${e.message})`);
    }
  }));
  // 中文源(PANews/Odaily, feed.lang="zh")正文已是中文, 直接原文, 不调 LLM/机翻:
  // 既省调用额度(卡在 Agnes 10 RPM 内), 也避免中文标题被"英译中"prompt 无意义改写。
  // 英文源照旧: 标题 LLM 翻译(门面), 摘要 Google 机翻, 失败回退英文原文。
  const enIdx = raw.map((r, i) => (r.lang === "zh" ? -1 : i)).filter((i) => i >= 0);
  const enRaw = enIdx.map((i) => raw[i]);
  const enTitles = await translateTitlesWithLlm(enRaw, cfg);
  const enSummaries = await Promise.all(enRaw.map((r) => translateText(r.summary)));
  const zhTitleMap = new Map(), zhSummaryMap = new Map();
  enIdx.forEach((rawIdx, j) => {
    zhTitleMap.set(rawIdx, enTitles[j] || "");
    zhSummaryMap.set(rawIdx, enSummaries[j] || "");
  });
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    const isZh = raw[i].lang === "zh";
    const zhT = (isZh ? raw[i].title : zhTitleMap.get(i) || "").trim();
    const zhS = (isZh ? raw[i].summary : zhSummaryMap.get(i) || "").trim();
    if (!zhT) continue; // 标题为空才跳过(翻译失败回退英文原文, 直接发英文帖)
    // 选题过滤: 资讯标题含强煽动词 / 未证实传闻时跳过, 平台易限流且易被打"需核查"标
    if (skipRe && skipRe.test(zhT)) { log(`  过滤煽动/传言标题: ${zhT.slice(0, 30)}`); continue; }
    // 平台公告/平台自身新闻: 对中文标题判定(英文源此时已译成中文), 避免发平台自说自话的低质帖
    if (isPlatformNotice(zhT, cfg)) { log(`  过滤平台公告: ${zhT.slice(0, 34)}`); continue; }
    // 低价值题材(协议细节/机构持仓披露/娱乐八卦): 同样只看标题, 避免误伤行情帖
    if (isLowValueTopic(zhT, cfg)) { log(`  过滤低价值题材: ${zhT.slice(0, 34)}`); continue; }
    // 英文规则没覆盖到、但翻译产物变成中文引流话术时在这里兜底跳过
    if (isPromoSummary(zhS)) { log(`  过滤空壳摘要: ${zhT.slice(0, 30)}`); continue; }
    // 只看英文源标题是否翻译失败: 标题是门面, 翻成中文就是中文帖(可加提问/cashtag/LLM 改写)。
    // 中文源标题本来就=原文, 不能据此判成英文帖; 摘要机翻失败也不该把整帖判成英文帖。
    const fallback = !isZh && zhT === (raw[i].title || "").trim();
    // titleEn 保留原标题供资讯卡片使用(卡片只渲染 ASCII): 中文源标题是中文, 卡片会走 fallback
    out.push({
      // 去重 id 用原标题 hash 而非译文: LLM 翻译有轻微不确定性, 同一文章两次抓取措辞可能微变
      // 导致 hash 漂移、重复发帖; RSS 原标题是文章的稳定身份。
      id: `news_${hashStr(normalizeText(raw[i].title || ""))}`,
      kind: "news", source: raw[i].source, title: zhT, titleEn: raw[i].title, link: raw[i].link,
      image: raw[i].image, summary: zhS, ts: raw[i].ts,
      lang: fallback ? "en" : "zh",
    });
  }
  // P1: 选题价值打分。交易者关心价格/上线/资金流, 政治流程/监管诉讼/矿机安全帖互动极低
  // (实测浏览 35-84、0 评论)。打分只影响同一轮的相对优先级, 不硬删候选, 保留素材多样性。
  const boostWords = cfg.news?.topicBoostWords ?? [];
  const penaltyWords = cfg.news?.topicPenaltyWords ?? [];
  const maxBoost = cfg.news?.topicMaxBoost ?? 20;
  const maxPenalty = cfg.news?.topicMaxPenalty ?? 25;
  for (const item of out) {
    const text = `${item.titleEn ?? ""} ${item.title ?? ""} ${item.summary ?? ""}`.toLowerCase();
    const hits = (words) => words.filter((w) => text.includes(String(w).toLowerCase()));
    const boost = Math.min(maxBoost, hits(boostWords).length * 8);
    const penalty = Math.min(maxPenalty, hits(penaltyWords).length * 12);
    item.topicScore = boost - penalty;
    if (item.topicScore <= -12) {
      log(`  选题降权 ${item.topicScore}: ${(item.title ?? "").slice(0, 34)}`);
    }
  }
  log(`  资讯: ${out.length} 条候选(中文, ${feeds.map((f) => f.name).join("/")})`);
  return out;
}

// Foresight News: 官方 API(api.foresightnews.pro, 免 key), 数据用 base64 + zlib 压缩。
// 解密: response.data.list -> base64 decode -> zlib.inflateSync -> JSON.parse(数组)。
// 产出与 fetchRssNews 同构的 news 素材(中文正文现成, 无需翻译), 走同一条发帖/卡片/去重链路。
async function fetchForesight(cfg) {
  if (!cfg.foresight?.enabled) return [];
  const url = cfg.foresight.api ?? "https://api.foresightnews.pro/v1/news";
  const limit = cfg.foresight?.perFetch ?? 2;
  const skipWords = cfg.news?.skipWords ?? [];
  const skipRe = skipWords.length ? new RegExp(skipWords.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")) : null;
  const boostWords = cfg.news?.topicBoostWords ?? [];
  const penaltyWords = cfg.news?.topicPenaltyWords ?? [];
  const maxBoost = cfg.news?.topicMaxBoost ?? 20;
  const maxPenalty = cfg.news?.topicMaxPenalty ?? 25;
  try {
    const j = await fetchJson(`${url}?size=50`, {}, 15000);
    const packed = j?.data?.list ?? j?.data;
    if (!packed) return [];
    const inflated = zlib.inflateSync(Buffer.from(packed, "base64")).toString("utf8").trim();
    const list = JSON.parse(inflated);
    if (!Array.isArray(list)) return [];
    const raw = [];
    for (const x of list) {
      const d = x[x.source_type] ?? x;
      const title = String(d.title ?? "").trim();
      // 与 RSS 源一致截到 240 字: 全文太长会让 LLM 改写因数字校验失败必走兜底,
      // 且兜底长正文会被发帖上限(950字)截断在句中、丢掉末尾标签
      const content = String(d.content ?? d.brief ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 240);
      const link = d.id ? `https://foresightnews.pro/news/detail/${d.id}` : "";
      if (!title || !content) continue;
      if (skipRe && skipRe.test(title)) { log(`  Foresight 过滤煽动/传言: ${title.slice(0, 30)}`); continue; }
      if (isPlatformNotice(title, cfg)) { log(`  Foresight 过滤平台公告: ${title.slice(0, 34)}`); continue; }
      if (isLowValueTopic(title, cfg)) { log(`  Foresight 过滤低价值题材: ${title.slice(0, 34)}`); continue; }
      if (mentionsCompetitor(`${title} ${content}`, link)) { log(`  Foresight 过滤竞品: ${title.slice(0, 30)}`); continue; }
      const ts = d.published_at ? Number(d.published_at) * 1000 : Date.now();
      // 选题打分与 RSS 资讯一致, 重要快讯额外加权
      const text = `${title} ${content}`.toLowerCase();
      const hits = (words) => words.filter((w) => text.includes(String(w).toLowerCase()));
      const topicScore = Math.min(maxBoost, hits(boostWords).length * 8)
        - Math.min(maxPenalty, hits(penaltyWords).length * 12)
        + (d.is_important ? 8 : 0);
      raw.push({
        // 去重 id 用官方 id, 稳定不漂
        id: `foresight_${d.id}`,
        kind: "news", source: "Foresight",
        title, titleEn: title, link,
        image: d.img || "", summary: content, ts,
        lang: "zh", topicScore,
      });
    }
    raw.sort((a, b) => (b.ts - a.ts));
    const out = raw.slice(0, limit);
    log(`  Foresight: ${list.length} 条解密, 取 ${out.length} 条(中文加密垂直)`);
    return out;
  } catch (e) {
    log(`  Foresight 拉取失败: ${e.message}`);
    return [];
  }
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
// 简单去重: 记住最近 N 次用过的句子, 随机时优先从未用过的里挑, 全用过再放行
const RECENT_DEPTH = 6;
const recentUsed = { opener: [], closer: [], cta: [] };
function pickFrom(list, slot) {
  const recent = recentUsed[slot];
  const fresh = list.filter((s) => !recent.includes(s));
  const pool = fresh.length ? fresh : list;
  const chosen = pool[Math.floor(Math.random() * pool.length)];
  recent.push(chosen);
  if (recent.length > RECENT_DEPTH) recent.shift();
  return chosen;
}

function fill(template, data) {
  return template.replace(/\{(\w+)\}/g, (_, k) =>
    data[k] !== undefined ? String(data[k]) : `{${k}}`
  );
}

// 解读段: LLM 预生成的榜单点评(m.take, 仅热搜/涨跌榜走这里)优先, 回退 takes.js 规则推导;
// CTA: 一个开放式提问。受 post.take 控制(默认开)。
// 英文原帖(翻译失败回退)解读段与 CTA 都不加, 避免再叠加中文。
// 关闭时返回空数组, 输出与改动前逐字一致, 便于一键回退。
function takeLines(m, cfg) {
  if (cfg.post?.take === false || m.lang === "en") return [];
  const take = m.take || buildTake(m);
  return take ? ["", take] : [];
}
// 收尾提问(CTA): 默认关闭——固定套路的"你们怎么看"用多了像尬聊、易被判机器模板。
// 需要恢复时把 post.cta 设为 true 即可(同时恢复资讯帖的 newsQuestion)。
function ctaLines(m, cfg, closer) {
  if (cfg.post?.cta !== true || cfg.post?.take === false || m.lang === "en") return [];
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

  // 数据用自然句连起来写, 不用"· 现价 / · 成交量"的列报表式排版——那种一看就是机器填模板。
  // 数据全来自素材真实字段, 不编造。
  const lines = [];
  lines.push(`📊 ${coin} ${m.windowMinutes} 分钟${up ? "涨" : "跌"} ${Math.abs(m.pct).toFixed(1)}%`);
  lines.push(`${opener}，现在 ${fmtPrice(m.price)}，成交量放大到 ${m.volMultiple} 倍。`);
  lines.push(...takeLines(m, cfg));
  lines.push("", closer);
  lines.push(...ctaLines(m, cfg, closer));
  lines.push("", `${coin} #行情异动`);
  return lines.join("\n");
}

function genTrendingPost(m, cfg) {
  const lines = [];
  lines.push("🔥 24 小时热搜币种（大家都在看）");
  lines.push("");
  m.items.slice(0, 6).forEach((it, i) => {
    const chg = it.data?.price_change_percentage_24h?.usd;
    const pct = (typeof chg === "number") ? ` (${chg >= 0 ? "+" : ""}${chg.toFixed(1)}%)` : "";
    lines.push(`${i + 1}. ${it.sym}${pct}`);
  });
  lines.push(...takeLines(m, cfg));
  lines.push(...ctaLines(m, cfg, ""));
  lines.push("", "#热搜币种 #加密资讯");
  return lines.join("\n");
}

function genMoversPost(m, cfg) {
  const closer = "涨跌两头都拉得挺开，说明今天分歧不小；这种分化能维持多久，单看一天的榜单说不准。";
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

// ---------- 新素材类型的帖子生成(数据驱动, 不用 LLM; 不给买卖建议) ----------
const pct1 = (n) => `${n >= 0 ? "+" : ""}${Number(n).toFixed(1)}%`;

function genBreakoutPost(m, cfg) {
  const lines = ["🔺 日线突破监控"];
  lines.push("");
  for (const x of m.items) {
    lines.push(`${x.sym} 今天摸到 ${x.dir === "high" ? `${x.lookback ?? 20} 日新高` : `${x.lookback ?? 20} 日新低`}，现价 ${fmtPrice(x.price)}`);
  }
  const hi = m.items.some((x) => x.dir === "high");
  lines.push("", hi
    ? "价格摸到区间上沿，说明买盘确实推了一把，但能不能在这里站稳，单看今天这根线还不够，得后面几天确认。"
    : "价格探到区间下沿，卖压是有的，不过破位之后能不能延续，还得看接下来几天的成交能不能跟上。");
  const closer = "这种位置，光看一根线判断不了什么";
  lines.push("", closer);
  lines.push(...ctaLines(m, cfg, closer));
  lines.push("", "#行情异动 #技术分析");
  return lines.join("\n");
}

function genBinanceMoversPost(m, cfg) {
  const lines = ["📊 币安合约 24h 涨跌榜"];
  lines.push("");
  if (m.up.length) lines.push("领涨：" + m.up.map((i) => `${i.sym} ${pct1(i.pct)}`).join(" / "));
  if (m.down.length) lines.push("领跌：" + m.down.map((i) => `${i.sym} ${pct1(i.pct)}`).join(" / "));
  lines.push(...takeLines(m, cfg));
  lines.push(...ctaLines(m, cfg, ""));
  lines.push("", "#涨跌榜单 #合约情绪");
  return lines.join("\n");
}

// 从文本里提取币种符号 → $cashtag(进币安广场对应币种的讨论区, 是比泛标签更大的流量入口)。
// 只认明确的大写符号和几个高置信全称, 避免把普通英文词当币; 最多 2 个防止堆砌。
const KNOWN_COINS = {
  bitcoin: "BTC", ethereum: "ETH", solana: "SOL", ripple: "XRP", binance: "BNB",
  dogecoin: "DOGE", cardano: "ADA", avalanche: "AVAX", chainlink: "LINK",
  polkadot: "DOT", litecoin: "LTC", toncoin: "TON",
};
function extractCashtags(text) {
  const s = String(text ?? "");
  const out = [];
  // 大写币种符号(3-10 位), 排除常见大写噪音词
  const NOISE = new Set(["AI", "CEO", "ETF", "US", "UK", "SEC", "FED", "GDP", "CPI", "NFT", "USD", "DXY", "IPO"]);
  for (const m of s.matchAll(/\b([A-Z]{2,10})\b/g)) {
    const sym = m[1];
    if (!NOISE.has(sym) && !out.includes(sym)) out.push(sym);
  }
  // 英文全称(bitcoin/ethereum...)与中文全称
  for (const [name, sym] of Object.entries(KNOWN_COINS)) {
    if (new RegExp(`\\b${name}\\b`, "i").test(s) && !out.includes(sym)) out.push(sym);
  }
  for (const [name, sym] of [["比特币", "BTC"], ["以太坊", "ETH"], [" solana ", "SOL"]]) {
    if (s.includes(name.trim()) && !out.includes(sym)) out.push(sym);
  }
  return out.slice(0, 2).map((sym) => `$${sym}`);
}

// 资讯帖的互动提问: 默认关闭(见 post.cta), 恢复时才生效。
// 专属中文资讯; 英文原帖与关闭 take 时不加。
function newsQuestion(m, cfg) {
  if (cfg.post?.cta !== true || cfg.post?.take === false || m.lang === "en") return "";
  return pickFrom(TPL.newsQuestions, "cta");
}

function genNewsPost(m, cfg) {
  // 不显示文章来源平台名(如 CoinDesk / Cointelegraph): 币安广场对"把用户引向第三方平台"敏感,
  // 帖首挂别家媒体名容易被当成引流。m.source 仅保留在素材里供日志排查, 不渲染。
  // 中文资讯优先用 LLM 整帖改写(m.rewrite, 口语化分享帖, 降低搬运判定)。
  // 流量优化: 末行带 $cashtag 进币种讨论区(币安广场主要自然流量入口), 受 autoCashtag 控制。
  // 结尾提问已随 post.cta 默认关闭; 改写失败走 A 兜底(标题+摘要+cashtag)。
  const tags = cfg.news?.autoCashtag === false ? [] : extractCashtags(`${m.title ?? ""} ${m.summary ?? ""}`);
  const tagLine = [...tags, "#加密资讯"].join(" ");
  const question = newsQuestion(m, cfg);
  if (m.rewrite) {
    // LLM 改写里若已自带问号, 不再叠加(避免连续两个问句)
    const end = question && !/[？?]/.test(m.rewrite) ? `\n\n${question}` : "";
    return `${m.rewrite}${end}\n\n${tagLine}`;
  }
  const isOff = cfg.post?.take === false;
  const lines = [];
  if (m.title) lines.push(m.title);
  if (m.summary) {
    lines.push("");
    lines.push(m.summary);
  }
  if (isOff) {
    lines.push("", "消息面仅供参考，操作看自己的判断。");
  } else if (question) {
    lines.push("", question);
  }
  lines.push("", tagLine);
  return lines.join("\n");
}

// 资讯的"盘面锚点"加分: 新闻里提到的币正好是当下热搜/榜单/监控池里的资产时,
// 用户读完能立刻回去看盘, 比纯标题党/平台公告有流量。只认明确币种符号或已知全称,
// 且必须在锚点集合内, 避免 extractCashtags 那种把 CEO/ETF 当币的误判。
// 锚点来源: 本轮 trending/movers/binanceMovers 的币种 + state.symbols 池(按成交额刷新)。
// 交易相关性: 提到锚点但通篇没有价格/资金/成交信号时按 noSignalFactor 打折,
// 避免"$BTC 挂在 120 万美元股票持仓"这种也拿满盘面分。词表在 config.news.anchorRelevance。
function marketAnchorSet(candidates, state) {
  const set = new Set();
  const add = (s) => { const v = String(s ?? "").toUpperCase().replace(/USDT$/, ""); if (v) set.add(v); };
  for (const m of candidates) {
    if (m.kind === "trending" || m.kind === "movers") for (const it of (m.items ?? [])) add(it.sym);
    if (m.kind === "binanceMovers") { for (const it of (m.up ?? [])) add(it.sym); for (const it of (m.down ?? [])) add(it.sym); }
  }
  for (const s of (state?.symbols ?? [])) add(s);
  return set;
}
function anchorHasTradeSignal(m, cfg) {
  const words = cfg?.news?.anchorRelevance?.tradeWords ?? [];
  if (!words.length) return false;
  const s = `${m.titleEn ?? ""} ${m.title ?? ""} ${m.summary ?? ""}`.toLowerCase();
  return words.some((w) => s.includes(String(w).toLowerCase()));
}
function marketAnchorBonus(m, anchors, cfg) {
  if (!anchors?.size) return 0;
  const s = `${m.titleEn ?? ""} ${m.title ?? ""} ${m.summary ?? ""}`;
  const mentioned = new Set();
  for (const x of s.matchAll(/\b([A-Z]{2,12})\b/g)) mentioned.add(x[1].toUpperCase());
  for (const [name, sym] of Object.entries(KNOWN_COINS)) {
    if (new RegExp(`\\b${name}\\b`, "i").test(s)) mentioned.add(sym);
  }
  for (const [name, sym] of [["比特币", "BTC"], ["以太坊", "ETH"], ["索拉纳", "SOL"]]) {
    if (s.includes(name)) mentioned.add(sym);
  }
  let hits = 0;
  for (const sym of mentioned) if (anchors.has(sym)) hits++;
  if (!hits) return 0;
  const full = Math.min(20, hits * 10);
  const rel = cfg?.news?.anchorRelevance;
  if (rel?.enabled === false || !(rel?.tradeWords?.length) || anchorHasTradeSignal(m, cfg)) return full;
  const raw = Number(rel?.noSignalFactor);
  const factor = Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0.4;
  return Math.round(full * factor);
}

// 热度评分: 事件强度 + 新鲜度, 只用于同一轮多条素材里挑一条发。
// 类型优先级: 行情异动 > 热搜 > 涨跌榜 > 新闻; 各类一天可多条(按内容去重),
// 相邻两条不能同类(选择逻辑见 runOnce)。
function heatScore(m, anchors, cfg) {
  const ageHours = Math.max(0, (Date.now() - (m.ts ?? Date.now())) / 3600000);
  const freshBonus = Math.max(0, 20 - ageHours); // 越新越高, 20 分封顶
  let base;
  switch (m.kind) {
    case "market":
      // 涨跌幅度 + 量比放大倍数, 异动越猛分越高; base 拉高确保触发态稳压其余类型
      base = 70 + Math.min(40, Math.abs(m.pct ?? 0) * 8) + Math.min(20, (m.volMultiple ?? 1) * 4);
      break;
    case "trending":
      base = 60;
      break;
    case "movers":
      base = 55;
      break;
    case "breakout":
      base = 57;
      break;
    case "binanceMovers":
      base = 55;
      break;
    case "news":
      // P1: 选题价值分直接叠加到 base —— 交易相关帖能压过热搜榜, 政治监管冷门帖沉底。
      // 中文资讯加权: 走 LLM 整帖改写(质量更高), 英文仅机翻兜底; 同轮中文优先于英文。
      base = 40 + (m.topicScore ?? 0) + (m.lang === "zh" ? 10 : 0) + marketAnchorBonus(m, anchors, cfg);
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
    case "trending": text = genTrendingPost(material, cfg); break;
    case "movers": text = genMoversPost(material, cfg); break;
    case "news": text = genNewsPost(material, cfg); break;
    case "breakout": text = genBreakoutPost(material, cfg); break;
    case "binanceMovers": text = genBinanceMoversPost(material, cfg); break;
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
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
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
        signal: ctrl.signal,
      }
    );
    return await res.json();
  } finally {
    clearTimeout(t);
  }
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
    // 热搜榜 / 涨跌榜: 同样生成卡片图(与行情卡同规格), 失败降级纯文本
    const cardBuilders = {
      trending: () => makeTrendingCard({ items: material.items, at: material.ts }),
      movers: () => makeMoversCard({ items: material.items, at: material.ts }),
      // 通用数据卡, 行内容全 ASCII(币名+数字+英文标签)
      breakout: () => makeDataCard({
        title: "20D BREAKOUT", subtitle: "daily high / low",
        rows: material.items.map((x) => `${x.sym} ${x.dir === "high" ? "NEW HIGH" : "NEW LOW"} ${fmtPrice(x.price)}`),
        accent: "#f0b90b", at: material.ts,
      }),
      binanceMovers: () => makeDataCard({
        title: "FUTURES MOVERS 24H", subtitle: "binance perp only",
        rows: [
          ...material.up.map((x) => `${x.sym} ${pct1(x.pct)}`),
          ...material.down.map((x) => `${x.sym} ${pct1(x.pct)}`),
        ],
        accent: "#f0b90b", at: material.ts,
      }),
    };
    if (cardBuilders[material.kind]) {
      const buf = cardBuilders[material.kind]();
      const url = await uploadImage(cfg.openApiKey, buf, "png");
      log(`  配图: ${material.kind} 卡片上传成功 ${url}`);
      return [url];
    }
    // 资讯帖: news.cardFeeds 列出的源强制用自生成卡片(避开第三方封面水印);
    // 其余源优先用 RSS 自带配图, 没有图 / 图格式不支持 / 下载上传失败时, 自动补一张资讯卡片,
    // 避免 Odaily 等无图源的资讯帖裸奔。总开关仍是 post.imageCard。
    if (material.kind === "news") {
      const newsCard = async () => {
        const buf = makeNewsCard({ titleZh: material.title, titleEn: material.titleEn, at: material.ts });
        const url = await uploadImage(cfg.openApiKey, buf, "png");
        log(`  配图: news 卡片上传成功 ${url}`);
        return [url];
      };
      if ((cfg.news?.cardFeeds ?? []).includes(material.source)) return await newsCard();
      if (material.image) {
        const ext = imageExt(material.image);
        if (!ext) {
          log("  配图: 非 jpg/png, 改用 news 卡片");
        } else {
          try {
            const buf = await downloadImage(material.image);
            const url = await uploadImage(cfg.openApiKey, buf, ext);
            log(`  配图: 远程图上传成功 ${url}`);
            return [url];
          } catch (e) {
            log(`  配图: 远程图失败(${e.message}), 改用 news 卡片`);
          }
        }
      } else {
        log("  配图: RSS 无图, 改用 news 卡片");
      }
      return await newsCard();
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

  // 今日计数按日翻转重置。必须在这里做而不能只依赖 canPostNow:
  // schedule 模式不走 canPostNow, 之前 todayPosted 一路累加、todayKey 十天不翻转,
  // 一旦切回非 schedule 模式, canPostNow 会因计数超限永久 false 而静默停摆。
  const dayKey = new Date().toDateString();
  if (state.todayKey !== dayKey) {
    state.todayKey = dayKey;
    state.todayPosted = 0;
  }

  // 1. 先判节奏再抓接口: 没到发帖时点就零请求退出, 且完全不改动 state,
  //    GitHub Actions 也不会为这种空转轮次提交 state.json。
  //    抓取频率从 CNB 的每 15 分钟一次降到每个 slot(均分模式 = 1440/maxPerDay 分钟)一次。
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
  const [marketMoves, trending, movers, newsRss, breakout, binanceMovers, foresight] =
    await Promise.all([
      fetchMarketMove(config),
      fetchTrending(config),
      fetchMovers(config),
      fetchRssNews(config, state),
      fetchBreakout(config),
      fetchBinanceMovers(config),
      fetchForesight(config),
    ]);

  const candidates = [
    ...marketMoves, ...trending, ...movers, ...newsRss, ...breakout, ...binanceMovers, ...foresight,
  ];

  // --force 模式: 没素材时用实时真实数据造一条行情帖(不用假数字, 避免虚假消息)
  if (candidates.length === 0 && forceMode) {
    try {
      const d = await fetchJson(`${BINANCE_API}/api/v3/ticker/24hr?symbol=BTCUSDT`);
      candidates.push({
        id: `force_${Date.now()}`, kind: "market", symbol: "BTCUSDT", baseSymbol: "BTC",
        pct: parseFloat(d.priceChangePercent), price: parseFloat(d.lastPrice),
        volMultiple: 1, windowMinutes: 24, ts: Date.now(),
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
  log(`素材: 行情 ${marketMoves.length} / 热搜 ${trending.length} / 涨跌 ${movers.length} / 资讯 ${newsRss.length}`
    + ` / 形态 ${breakout.length} / 合约榜 ${binanceMovers.length} / Foresight ${foresight.length} = 共 ${fresh.length} 条未发`);

  if (fresh.length === 0) {
    log("没有新素材, 本轮不发帖");
    saveState(state);
    return;
  }

  // 4. 热度排序: 多条候选只发热度最高的那一条
  // 资讯的盘面锚点取"本轮榜单币种 + 当日监控池", 让新闻里提到的币正好在异动的那些优先发。
  const anchors = marketAnchorSet(fresh, state);
  const scored = fresh
    .map((m) => ({ m, score: heatScore(m, anchors, config) }))
    .sort((a, b) => b.score - a.score);
  if (scored.length > 1) {
    log(`  本轮 ${scored.length} 条候选热度: ${scored.map(({ m, score }) => {
      if (m.kind !== "news") return `${m.kind}:${score.toFixed(1)}`;
      const ab = marketAnchorBonus(m, anchors, config);
      const weak = ab && !anchorHasTradeSignal(m, config) ? "(弱相关)" : "";
      return `news(选题${m.topicScore ?? 0}${ab ? `+盘面${ab}${weak}` : ""}):${score.toFixed(1)}`;
    }).join(" / ")}`);
  }
  // 类型冷却: 榜单类(trending/movers)分数高(新鲜度加成每轮拿满)且榜单变化频繁,
  // 不节流会来回刷屏、把新闻挤没。发帖成功后按类型记时间戳, 冷却期内该类不参选;
  // 冷却结束但榜单没变化(id 相同已发过)时该类自然无候选, 新闻顶上 —— 上限控制 + 内容驱动。
  // 全部候选都在冷却中且没有新闻时本轮空转; --force 忽略冷却(手动验证不受限)。
  const cooldownCfg = config.post?.kindCooldownMinutes ?? {};
  const inCooldown = (kind) => {
    const ms = (cooldownCfg[kind] ?? 0) * 60000;
    if (!ms) return false;
    const last = (state.lastPostAtByKind ?? {})[kind] ?? 0;
    return Date.now() - last < ms;
  };
  // 资讯低谷时段: 资讯帖互动率本就低, 发在北京时间凌晨等于白发(实测凌晨帖只有 30-50 浏览)。
  // 低谷时段的 slot 让给其它素材; 没有其它素材就空转, 资讯留给白天的 slot 再发。
  // --force 不受限(手动验证要能发任意类型)。
  const tz = config.schedule?.timezone ?? "Asia/Shanghai";
  // h24 时钟下午夜会格式化成 "24"(部分 Node/locale 组合), 归一到 0 才能匹配 quietHours 的 0
  const hourRaw = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", hour12: false }).format(new Date());
  const hourNow = hourRaw === "24" ? 0 : Number(hourRaw);
  const quietHours = config.news?.quietHours ?? [];
  const newsQuiet = quietHours.includes(hourNow);
  const eligible = forceMode ? scored : scored.filter(({ m }) => {
    if (inCooldown(m.kind)) return false;
    if (m.kind === "news" && newsQuiet) return false;
    return true;
  });
  if (!eligible.length) {
    log(newsQuiet ? "  资讯低谷时段且无其它素材, 本轮不发, 等白天 slot" : "  所有候选类型都在冷却中, 本轮不发, 等下个 slot");
    saveState(state);
    return;
  }
  if (eligible.length !== scored.length) {
    const skipped = scored.filter(({ m }) => inCooldown(m.kind)).map(({ m }) => m.kind);
    if (newsQuiet && scored.some(({ m }) => m.kind === "news")) skipped.push("news(低谷时段)");
    if (skipped.length) log(`  本轮不参选: ${skipped.join(", ")}`);
  }
  // 相邻两条不能同类: 上一条发了 A 类, 本轮改发次高分的其它类; 只剩 A 类可选时仍发它(避免空轮)。
  const lastKind = (state.postHistory ?? []).slice(-1)[0]?.kind;
  let material = eligible[0].m;
  if (lastKind && eligible.length > 1) {
    const alt = eligible.find(({ m }) => m.kind !== lastKind);
    if (alt) material = alt.m;
  }
  // 中文资讯/热搜/涨跌榜/合约榜在真实发帖前调 LLM; 行情异动不用 LLM(数字即信息, 硬凑观点只会是套话)。
  // 资讯: 整帖改写成口语化分享帖(m.rewrite, 降低搬运判定), 失败走 A 兜底;
  // 榜单类: 结构点评(m.take), 失败回退 takes.js 规则推导。合约榜原来只有固定文案,
  // 连续多条一字不差, 现同样走点评, prompt 要求做数字比较(断层/两侧力量), 不用通用感想。
  const TAKE_KINDS = ["news", "trending", "movers", "binanceMovers"];
  if (TAKE_KINDS.includes(material.kind)
      && (material.kind !== "news" || material.lang === "zh")
      && config.post?.take !== false && !config.dryRun) {
    if (material.kind === "news") {
      log("→ 触发 LLM 整帖改写(news/zh)");
      material.rewrite = await genNewsRewrite(material, config);
      log(`← LLM 改写结果: ${material.rewrite ? `OK(${material.rewrite.length}字)` : "null(A兜底)"}`);
    } else {
      log(`→ 触发 LLM 解读(${material.kind})`);
      material.take = await genTake(material, config);
      log(`← LLM 解读结果: ${material.take ? `OK(${material.take.length}字)` : "null(规则推导)"}`);
    }
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
    // 按类型记发帖时间戳, 供类型冷却判断(见上方 eligible 过滤)
    state.lastPostAtByKind = state.lastPostAtByKind ?? {};
    state.lastPostAtByKind[material.kind] = Date.now();
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
