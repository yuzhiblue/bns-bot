#!/usr/bin/env node
/**
 * bns-bot — 币安广场自动发帖机器人（GitHub Actions 纯云端单次模式）
 * 抓取行情异动 + 币安公告 → 生成带 $币种 的帖子 → 调官方 OpenAPI 发布
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
const { fetchSymbolPool, DEFAULT_TOP_N, DEFAULT_MIN_USD } = require("./symbolPool");
const { uploadImage } = require("./squareMedia");
const { makeMarketCard } = require("./imageCard");

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
      lastAnnouncementIds: [], // 上次见过的公告 id
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

// ---------- 新信源: 新币 / 资金费率 / 鲸鱼 / 恐惧贪婪 ----------

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

async function fetchFundingRate(cfg) {
  if (!cfg.fundingRate?.enabled) return [];
  // 合约接口没有无地域限制的镜像, 默认禁用; 只有 config 里显式配了可用
  // baseUrl 才请求, 避免每轮刷一屏 451。
  const base = cfg.fundingRate.baseUrl;
  if (!base) return [];
  const { symbols, absThreshold } = cfg.fundingRate;
  const out = [];
  await Promise.all(
    symbols.map(async (sym) => {
      try {
        const d = await fetchJson(`${base}/fapi/v1/premiumIndex?symbol=${sym}`);
        const rate = parseFloat(d.lastFundingRate ?? 0);
        const absPct = Math.abs(rate) * 100;
        if (absPct >= absThreshold) {
          out.push({
            id: `funding_${sym}_${new Date().toISOString().slice(0, 10)}_${rate > 0 ? "up" : "down"}`,
            kind: "fundingRate",
            symbol: sym,
            baseSymbol: sym.replace("USDT", ""),
            ratePct: rate * 100,
            markPrice: parseFloat(d.markPrice ?? 0),
            ts: Date.now(),
          });
          log(`  资金费率 ${sym}: ${rate.toFixed(4)} (${absPct.toFixed(2)}%) 触发`);
        } else {
          log(`  资金费率 ${sym}: ${rate.toFixed(4)} 未触发`);
        }
      } catch (e) {
        log(`  资金费率 ${sym} 拉取失败: ${e.message}`);
      }
    })
  );
  return out;
}

async function fetchWhaleWatch(cfg) {
  if (!cfg.whale?.enabled) return [];
  // 同资金费率: 合约接口默认禁用, 需要时在 config 里配可用 baseUrl。
  const base = cfg.whale.baseUrl;
  if (!base) return [];
  const { symbols } = cfg.whale;
  const out = [];
  await Promise.all(
    symbols.map(async (sym) => {
      try {
        const d = await fetchJson(
          `${base}/futures/data/topLongShortPositionRatio?symbol=${sym}&period=1h&limit=1`
        );
        if (!Array.isArray(d) || d.length === 0) return;
        const latest = d[0];
        const ratio = parseFloat(latest.longShortRatio ?? 1);
        if (Math.abs(ratio - 1) >= 0.5) {
          out.push({
            id: `whale_${sym}_${new Date().toISOString().slice(0, 10)}`,
            kind: "whale",
            symbol: sym,
            baseSymbol: sym.replace("USDT", ""),
            ratio,
            ts: Date.now(),
          });
          log(`  鲸鱼 ${sym}: 多空比 ${ratio} 异常`);
        }
      } catch (e) {
        log(`  鲸鱼 ${sym} 拉取失败: ${e.message}`);
      }
    })
  );
  return out;
}

// ---------- 热门信源: CoinGecko 热搜 / 全市场涨跌榜 / RSS 资讯 / CryptoPanic ----------
// 全部第三方、零 key(除 CryptoPanic 需免费 key); 失败一律 return [], 不影响其它素材。

function decodeEntities(s) {
  return (s || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
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
    if (linkM) link = linkM[1].trim();
    else { const l2 = blk.match(/<link[^>]*href="([^"]+)"/i); if (l2) link = l2[1]; }
    const image = extractRssImage(blk);
    let ts = 0;
    const pd = blk.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i) ||
      blk.match(/<updated[^>]*>([\s\S]*?)<\/updated>/i) ||
      blk.match(/<published[^>]*>([\s\S]*?)<\/published>/i);
    if (pd) ts = Date.parse(pd[1].trim());
    if (title) out.push({ title, link, image, ts: ts || Date.now() });
  }
  return out;
}

async function fetchTrending(cfg, state) {
  if (!cfg.trending?.enabled) return [];
  const today = todayStrTZ(cfg.schedule?.timezone);
  if ((state.trendingDates ?? []).includes(today)) {
    log("  热搜: 今天已发过, 跳过");
    return [];
  }
  try {
    const j = await fetchJson("https://api.coingecko.com/api/v3/search/trending", {}, 15000);
    const coins = j?.coins ?? [];
    if (!coins.length) return [];
    state.trendingDates = [...(state.trendingDates ?? []), today].slice(-30);
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
    return [{ id: `trending_${today}`, kind: "trending", items, ts: Date.now() }];
  } catch (e) {
    log(`  热搜拉取失败: ${e.message}`);
    return [];
  }
}

async function fetchMovers(cfg, state) {
  if (!cfg.movers?.enabled) return [];
  const today = todayStrTZ(cfg.schedule?.timezone);
  if ((state.moversDates ?? []).includes(today)) {
    log("  涨跌榜: 今天已发过, 跳过");
    return [];
  }
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
    state.moversDates = [...(state.moversDates ?? []), today].slice(-30);
    const items = filtered.map((c) => ({
      sym: (c.symbol || "").toUpperCase(), name: c.name,
      pct: c.price_change_percentage_24h ?? 0, price: c.current_price,
    }));
    log(`  涨跌榜: ${items.length} 个涨跌币(≥${minAbsPct}%)`);
    return [{ id: `movers_${today}`, kind: "movers", items, ts: Date.now() }];
  } catch (e) {
    log(`  涨跌榜拉取失败: ${e.message}`);
    return [];
  }
}

async function fetchRssNews(cfg, state) {
  if (!cfg.news?.enabled) return [];
  const feeds = cfg.news?.feeds ?? [];
  if (!feeds.length) return [];
  const limit = cfg.news?.perFeed ?? 2;
  const out = [];
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
        out.push({
          id: `news_${hashStr(normalizeText(it.title || link))}`,
          kind: "news", source: feed.name, title: it.title, link, image: it.image, ts: it.ts,
        });
      }
    } catch (e) {
      log(`  RSS ${feed.name}: 拉取失败(${e.message})`);
    }
  }));
  log(`  资讯: ${out.length} 条候选(${feeds.map((f) => f.name).join("/")})`);
  return out;
}

// ---------- 公告(HTTP) ----------
// 云端是短进程, 不挂长连接; 公告接口结构不固定, 宽松解析,
// 失败或结构不认识就降级为空, 不影响其他素材。
// ---------- 帖子生成(从 templates.js 读词库) ----------

const CASHTAG = (sym) => `$${sym}`;
// 简单去重: 记住最近 N 次用过的句子, 随机时优先跳过, 全撞过再放行
const RECENT_DEPTH = 6;
const recentUsed = { opener: [], closer: [] };
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

function genMarketPost(m) {
  const up = m.pct >= 0;
  const coin = CASHTAG(m.baseSymbol);
  const bucket = up ? TPL.marketUp : TPL.marketDown;
  const opener = pickFrom(bucket.openers, "opener");
  const closer = pickFrom(bucket.closers, "closer");

  const lines = [];
  lines.push(`📊 ${coin} ${m.windowMinutes} 分钟${up ? "涨" : "跌"} ${Math.abs(m.pct).toFixed(1)}%`);
  lines.push(`· ${opener}`);
  lines.push(`· 现价 ${m.price.toLocaleString("en-US", { maximumFractionDigits: 4 })}`);
  lines.push(`· 成交量放大 ${m.volMultiple} 倍`);
  lines.push("");
  lines.push(closer);
  lines.push("");
  lines.push(`${coin} #行情异动`);
  return lines.join("\n");
}

function genNewCoinPost(m) {
  const coin = m.baseAsset;
  const days = Math.max(1, Math.round((Date.now() - m.onboardDate) / 86400000));
  const opener = fill(pickFrom(TPL.newCoin.openers, "opener"), { coin, days });
  const closer = fill(pickFrom(TPL.newCoin.closers, "closer"), { coin, days });

  const lines = [];
  lines.push(`🆕 ${opener}`);
  lines.push("");
  lines.push(closer);
  lines.push("");
  lines.push(`$${coin} #币安新币`);
  return lines.join("\n");
}

function genFundingPost(m) {
  const coin = m.baseSymbol;
  const up = m.ratePct > 0;
  const annual = Math.abs(m.ratePct * 24 * 365).toFixed(0);
  const payer = up ? "空头" : "多头";
  // 按付费方选词库: 多头付费=多头拥挤, 空头付费=空头拥挤
  const bucket = up ? TPL.fundingLong : TPL.fundingShort;
  const opener = fill(pickFrom(bucket.openers, "opener"), {
    coin, ratePct: m.ratePct.toFixed(3), annual, payer,
  });
  const closer = fill(pickFrom(bucket.closers, "closer"), {
    coin, ratePct: m.ratePct.toFixed(3), annual, payer,
  });

  const lines = [];
  lines.push(`📊 ${opener}`);
  lines.push(`· 当期费率: ${m.ratePct.toFixed(3)}%`);
  lines.push(`· 年化: ${annual}%`);
  lines.push(`· 付费方: ${payer}`);
  lines.push("");
  lines.push(closer);
  lines.push("");
  lines.push(`$${coin} #资金费率`);
  return lines.join("\n");
}

function genWhalePost(m) {
  const coin = m.baseSymbol;
  const long = m.ratio > 1;
  // 按多空方向选词库, 保证开头/结尾方向一致
  let openers, closers;
  if (long) {
    openers = TPL.whale.longOpeners;
    closers = TPL.whale.longClosers;
  } else {
    openers = TPL.whale.shortOpeners;
    closers = TPL.whale.shortClosers;
  }
  const side = long ? "多头" : "空头";
  const opener = fill(pickFrom(openers, "opener"), {
    coin, ratio: m.ratio, side,
  });
  const closer = fill(pickFrom(closers, "closer"), {
    coin, ratio: m.ratio, side,
  });

  const lines = [];
  lines.push(`🐋 ${opener}`);
  lines.push(`· 当前多空比: ${m.ratio}`);
  lines.push(`· ${long ? "多头持仓明显占优" : "空头持仓明显占优"}`);
  lines.push("");
  lines.push(closer);
  lines.push("");
  lines.push(`$${coin} #多空比`);
  return lines.join("\n");
}

function genTrendingPost(m) {
  const lines = [];
  lines.push("🔥 24 小时热搜币种（大家都在看）");
  lines.push("");
  m.items.slice(0, 6).forEach((it, i) => {
    const chg = it.data?.price_change_percentage_24h?.usd;
    const pct = (typeof chg === "number") ? ` (${chg >= 0 ? "+" : ""}${chg.toFixed(1)}%)` : "";
    lines.push(`${i + 1}. ${it.sym}${pct}`);
  });
  lines.push("");
  lines.push("热度是情绪不是建议，仓位自己拿主意。");
  lines.push("");
  lines.push("#热搜币种 #加密资讯");
  return lines.join("\n");
}

function genMoversPost(m) {
  const lines = [];
  const up = m.items.filter((i) => i.pct >= 0).sort((a, b) => b.pct - a.pct);
  const down = m.items.filter((i) => i.pct < 0).sort((a, b) => a.pct - b.pct);
  lines.push("📊 24h 涨跌榜（全市场）");
  lines.push("");
  if (up.length) lines.push("领涨：" + up.slice(0, 5).map((i) => `${i.sym} +${i.pct.toFixed(1)}%`).join(" / "));
  if (down.length) lines.push("领跌：" + down.slice(0, 5).map((i) => `${i.sym} ${i.pct.toFixed(1)}%`).join(" / "));
  lines.push("");
  lines.push("极端波动时更要注意风险，别追在尖上。");
  lines.push("");
  lines.push("#涨跌榜单 #行情异动");
  return lines.join("\n");
}

function genNewsPost(m) {
  const lines = [];
  lines.push(`📰 ${m.source || "加密资讯"}`);
  lines.push("");
  if (m.title) lines.push(m.title);
  if (m.link) lines.push(m.link);
  lines.push("");
  lines.push("消息面仅供参考，操作看自己的判断。");
  lines.push("");
  lines.push("#加密资讯");
  return lines.join("\n");
}

// 热度评分: 事件强度 + 新鲜度, 只用于同一轮多条素材里挑一条发。
// 分数没有跨类型严格可比性, 但规则固定、日志可见, 便于按需调整权重。
function heatScore(m) {
  const ageHours = Math.max(0, (Date.now() - (m.ts ?? Date.now())) / 3600000);
  const freshBonus = Math.max(0, 20 - ageHours); // 越新越高, 20 分封顶
  let base;
  switch (m.kind) {
    case "market":
      // 涨跌幅度 + 量比放大倍数, 异动越猛分越高
      base = 40 + Math.min(40, Math.abs(m.pct ?? 0) * 8) + Math.min(20, (m.volMultiple ?? 1) * 4);
      break;
    case "newCoin":
      base = 90 - Math.min(30, Math.max(0, (Date.now() - (m.onboardDate ?? Date.now())) / 86400000) * 4);
      break;
    case "trending":
      base = 52;
      break;
    case "movers":
      base = 53;
      break;
    case "news":
      base = 58;
      break;
    case "fundingRate":
      base = 35 + Math.min(30, Math.abs(m.rate ?? 0) * 300);
      break;
    case "whale":
      base = 35 + Math.min(30, Math.abs((m.ratio ?? 1) - 1) * 30);
      break;
    default:
      base = 10;
  }
  return base + freshBonus;
}

function buildPost(material, cfg) {
  let text;
  switch (material.kind) {
    case "market": text = genMarketPost(material); break;
    case "newCoin": text = genNewCoinPost(material); break;
    case "fundingRate": text = genFundingPost(material); break;
    case "whale": text = genWhalePost(material); break;
    case "trending": text = genTrendingPost(material); break;
    case "movers": text = genMoversPost(material); break;
    case "news": text = genNewsPost(material); break;
    default: return null;
  }

  // 追加话题: 各 gen*Post 末行自带一个固定标签(如 #币安公告 / #币安新币),
  // 配置里的 post.hashtags 要接到同一行, 全部用空格分隔, 超宽交给客户端自动换行。
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

  // 币安广场帖子长度限制:1000 字符左右,保守截断
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
    // 资讯帖: 若 RSS 带有文章配图(jpg/png), 下载后上传币安带一张图发; 失败降级纯文本
    if (material.kind === "news" && material.image) {
      const ext = imageExt(material.image);
      if (!ext) { log("  配图: 非 jpg/png, 跳过"); return null; }
      const buf = await downloadImage(material.image);
      const url = await uploadImage(cfg.openApiKey, buf, ext);
      log(`  配图: 远程图上传成功 ${url}`);
      return [url];
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

  // 1. 先判节奏再抓接口: 没到发帖时点就零请求退出, 且完全不改动 state,
  //    GitHub Actions 也不会为这种空转轮次提交 state.json。
  //    抓取频率从每 15 分钟一次降到每个 slot(默认 90min)一次。
  if (config.schedule?.enabled) {
    const gate = timelineGate(state);
    if (!gate.ok) {
      log(`时间线: ${gate.msg}, 本轮不抓接口也不发帖`);
      return;
    }
  } else if (!canPostNow(state)) {
    log(`节奏未到 (今日已发 ${state.todayPosted}/${config.postsPerDay}, 最小间隔 ${config.minIntervalMinutes}min), 本轮不抓接口也不发帖`);
    return;
  }

  // 按周期冷却: 一个 slot 周期内只抓一次接口。
  // 用「上次抓取时间戳」而不是「已发数量」做 key —— 后者在一帖都没发出去时
  // 永远不变, 会让当天后续 slot 全被挡住(没素材时整天只抓一次)。
  if (config.schedule?.enabled) {
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
  //    避免并发写文件互相覆盖。公告走内置 HTTP 接口。
  const [marketMoves, newCoins, funding, whales, trending, movers, newsRss] =
    await Promise.all([
      fetchMarketMove(config),
      fetchNewCoins(config, state),
      fetchFundingRate(config),
      fetchWhaleWatch(config),
      fetchTrending(config, state),
      fetchMovers(config, state),
      fetchRssNews(config, state),
    ]);

  const candidates = [
    ...marketMoves, ...newCoins, ...funding, ...whales,
    ...trending, ...movers, ...newsRss,
  ];

  // --force 模式: 没素材时用实时真实数据造一条行情帖(不用假数字, 避免虚假消息)
  const forceMode = process.argv.includes("--force");
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
  log(`素材: 行情 ${marketMoves.length} / 新币 ${newCoins.length} / 费率 ${funding.length} / 鲸鱼 ${whales.length} / 热搜 ${trending.length} / 涨跌 ${movers.length} / 资讯 ${newsRss.length} = 共 ${fresh.length} 条未发`);

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
  const material = scored[0].m;
  const text = buildPost(material, config);
  log(`本轮待发 [${material.kind}]:\n${text}`);

  if (config.dryRun && !forceMode) {
    log("▶ dryRun 模式, 不真发。加 --force 可强制发这条");
    saveState(state);
    return;
  }

  // 5. 发帖(行情帖尝试配图, 失败自动降级纯文本)
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
