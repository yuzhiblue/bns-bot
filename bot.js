#!/usr/bin/env node
/**
 * bns-bot — 币安广场自动发帖机器人
 * 抓取行情异动 + 币安公告 → 生成带 $币种 的帖子 → 调官方 OpenAPI 发布
 *
 * 用法:
 *   node bot.js            正常运行(按 config.json 的 dryRun)
 *   node bot.js --once     只跑一轮就退出(调试用)
 *   node bot.js --force    忽略节奏限制, 本轮强制发帖(--once 时没素材会造一条)
 *   node bot.js --test     只测发帖接口通不通(用一句测试帖)
 *
 * 验证发帖链路:  node bot.js --once --force
 * 之后把 config.dryRun 改 false 就是真发
 */

const fs = require("fs");
const path = require("path");
const TPL = require("./templates");

const ROOT = __dirname;
const config = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
const STATE_FILE = path.join(ROOT, "state.json");

const BINANCE_API = "https://api.binance.com";
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
  const state = loadState();
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

async function fetchNewCoins(cfg) {
  if (!cfg.newCoin?.enabled) return [];
  const state = loadState();
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
    saveState(state);
    if (news.length) log(`  新币: 发现 ${news.length} 个 7 天内上线的币`);
    return news;
  } catch (e) {
    log(`  新币拉取失败: ${e.message}`);
    return [];
  }
}

async function fetchFundingRate(cfg) {
  if (!cfg.fundingRate?.enabled) return [];
  const { symbols, absThreshold } = cfg.fundingRate;
  const out = [];
  await Promise.all(
    symbols.map(async (sym) => {
      try {
        const d = await fetchJson(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${sym}`);
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
  const { symbols } = cfg.whale;
  const out = [];
  await Promise.all(
    symbols.map(async (sym) => {
      try {
        const d = await fetchJson(
          `https://fapi.binance.com/futures/data/topLongShortPositionRatio?symbol=${sym}&period=1h&limit=1`
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

async function fetchFearGreed(cfg) {
  if (!cfg.sentiment?.enabled) return [];
  try {
    const j = await fetchJson("https://api.alternative.me/fng/?limit=1", {}, 15000);
    const d = j?.data?.[0];
    if (!d) return [];
    const val = parseInt(d.value, 10);
    const cls = d.value_classification ?? "";
    const today = new Date().toISOString().slice(0, 10);
    const state = loadState();
    if ((state.sentimentDates ?? []).includes(today)) {
      log(`  恐惧贪婪: 今天已发过, 跳过`);
      return [];
    }
    state.sentimentDates = [...(state.sentimentDates ?? []), today].slice(-30);
    saveState(state);
    log(`  恐惧贪婪: ${val} (${cls})`);
    return [{ id: `fng_${today}`, kind: "fearGreed", value: val, cls, ts: Date.now() }];
  } catch (e) {
    log(`  恐惧贪婪拉取失败: ${e.message}`);
    return [];
  }
}

// ---------- 公告 WebSocket 订阅(常驻) ----------
// 公告流是实时推送, 没新公告不会主动发, 所以常驻模式下挂着一个 WS
const ANN_WS = "wss://stream.binance.com:443/ws/announcementStream";
let annWebSocket = null;
const annBuffer = []; // 未消化的新公告

function connectAnnouncements() {
  const state = loadState();
  const seen = new Set(state.lastAnnouncementIds);
  annWebSocket = new WebSocket(ANN_WS);

  annWebSocket.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(String(ev.data)); } catch { return; }
    // 公告流的消息结构: { stream: 'announcementStream', data: {...} }
    const a = msg.data ?? msg;
    if (!a?.id) return;
    const idStr = String(a.id);
    if (seen.has(idStr)) return; // 已见过的跳过
    const news = {
      id: `ann_${a.id}`,
      kind: "announcement",
      title: a.title ?? "",
      body: a.body ?? "",
      ts: a.releaseTime ? Date.parse(a.releaseTime) : Date.now(),
    };
    annBuffer.push(news);
    log(`  公告推送: ${news.title?.slice(0, 60)}`);

    // 更新 seen, 避免重启后重复
    const st = loadState();
    st.lastAnnouncementIds = [...new Set([...st.lastAnnouncementIds, idStr])].slice(-200);
    saveState(st);
  };

  annWebSocket.onclose = () => {
    log("  公告 WS 断开, 5s 后重连");
    annWebSocket = null;
    setTimeout(connectAnnouncements, 5000);
  };
  annWebSocket.onerror = () => {
    // onclose 会跟着触发, 不额外处理
  };
}

// 取未消化的公告, 取完清空
function drainAnnouncements(limit = 1) {
  if (annBuffer.length === 0) return [];
  const out = annBuffer.splice(0, limit);
  return out;
}

// 单次模式下: 直接连一次 WS, 等最多 N 秒拿公告
async function fetchAnnouncementsOnce(waitMs = 5000) {
  if (!annWebSocket) connectAnnouncements();
  const deadline = Date.now() + waitMs;
  while (annBuffer.length === 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
  }
  return drainAnnouncements(5);
}

// 常驻模式下每轮调用: buffer 有就立刻取, 没有就短等 3 秒(不阻塞太久, 避免错过 slot 窗口)
async function fetchAnnouncements(cfg) {
  if (!cfg.announcement?.enabled) return [];
  const fromBuffer = drainAnnouncements(5);
  if (fromBuffer.length) return fromBuffer;
  await new Promise((r) => setTimeout(r, 3000));
  return drainAnnouncements(5);
}

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

function genAnnouncementPost(a) {
  const opener = pickFrom(TPL.announcement.openers, "opener");
  const closer = pickFrom(TPL.announcement.closers, "closer");

  const lines = [];
  lines.push(`📢 ${opener}`);
  lines.push("");
  lines.push(a.title);
  const body = (a.body ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  if (body) lines.push(body.slice(0, 200) + (body.length > 200 ? "…" : ""));
  lines.push("");
  lines.push(closer);
  lines.push("");
  lines.push("#币安公告");
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

function genFearGreedPost(m) {
  const val = m.value;
  let cls = m.cls;
  if (val >= 75) cls = "极度贪婪";
  else if (val >= 55) cls = "贪婪";
  else if (val <= 25) cls = "极度恐惧";
  else if (val <= 45) cls = "恐惧";
  else cls = "中性";

  const opener = fill(pickFrom(TPL.fearGreed.openers, "opener"), { val, cls });
  const closer = fill(pickFrom(TPL.fearGreed.closers, "closer"), { val, cls });

  const lines = [];
  lines.push(`🌡️ ${opener}`);
  lines.push("");
  lines.push(closer);
  lines.push("");
  lines.push("#恐惧贪婪指数");
  return lines.join("\n");
}

function buildPost(material, cfg) {
  let text;
  switch (material.kind) {
    case "market": text = genMarketPost(material); break;
    case "announcement": text = genAnnouncementPost(material); break;
    case "newCoin": text = genNewCoinPost(material); break;
    case "fundingRate": text = genFundingPost(material); break;
    case "whale": text = genWhalePost(material); break;
    case "fearGreed": text = genFearGreedPost(material); break;
    default: return null;
  }

  // 追加话题
  const tags = cfg.post?.hashtags ?? [];
  if (material.kind === "market" && !text.includes("#行情异动") && tags.includes("行情异动")) {
    // 已在文本里带过,不重复
  } else {
    const extra = tags.map((t) => `#${t}`).join(" ");
    if (extra && !text.includes(extra)) text += "\n" + extra;
  }
  const disclaimer = cfg.post?.disclaimer?.trim();
  if (disclaimer) text += `\n\n${disclaimer}`;

  // 币安广场帖子长度限制:1000 字符左右,保守截断
  if (text.length > 950) text = text.slice(0, 947) + "…";
  return text;
}

// ---------- 发帖 ----------

async function publishPost(text) {
  const res = await fetch(
    `${BAPI}/composite/v1/public/pgc/openApi/content/add`,
    {
      method: "POST",
      headers: {
        "X-Square-OpenAPI-Key": config.openApiKey,
        "Content-Type": "application/json",
        clienttype: "binanceSkill",
      },
      body: JSON.stringify({ bodyTextOnly: text }),
    }
  );
  const data = await res.json();
  return data;
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
  const quietFrom = s.quiet?.from ?? 0;
  const quietTo = s.quiet?.to ?? 0;
  const intervalMs = (s.intervalMinutes ?? 90) * 60000;

  // 从 startHour 开始, 每跳 intervalMs 一次, 用"目标时区的日+时分"推进(处理跨天)
  let curDay = dayKey;
  let curH = s.startHour ?? 8;
  let curM = 0;
  for (let i = 0; i < s.maxPerDay; i++) {
    // 静默期: 落在 [quietFrom, quietTo) 的小时, 推到 quietTo:00
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
  state.timelineKey = dayKey;
  // 进度由 state.timelineSentCount 管理(发一帖 +1), 不再用 timelineIdx 跳格
  if (state.timelineSentCount === undefined) state.timelineSentCount = 0;
  if (state.timelineKey !== dayKey || (state.timelineSentCount === 0 && !state.timelineDay)) {
    // 新的一天重置进度
    if (state.timelineKey !== dayKey) state.timelineSentCount = 0;
    state.timelineDay = dayKey;
  }
  saveState(state);
  return slots;
}

// 按时间线判断: 锚定式, 错过的 slot 可以追发(只追最近的 1 个)
function timelineGate(state) {
  const s = config.schedule;
  if (!s?.enabled) return { ok: true, msg: "" };
  buildTimeline(state);
  const timeline = state.timeline;
  const now = Date.now();
  const sent = state.timelineSentCount ?? 0;

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

async function runOnce(onceMode = false) {
  log(`\n=== 开始一轮 @ ${new Date().toLocaleString("zh-CN", { hour12: false })}`);
  const state = loadState();

  // 1. 抓全部素材(并行拉, 控制总耗时, 避免错过 slot 窗口)
  // 公告用 buffer(常驻时 WS 实时填), 单次模式给 5s 等待
  const [marketMoves, announcements, newCoins, funding, whales, fng] =
    await Promise.all([
      fetchMarketMove(config),
      onceMode ? fetchAnnouncementsOnce(5000) : fetchAnnouncements(config),
      fetchNewCoins(config),
      fetchFundingRate(config),
      fetchWhaleWatch(config),
      fetchFearGreed(config),
    ]);

  const candidates = [
    ...marketMoves, ...announcements, ...newCoins, ...funding, ...whales, ...fng,
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

  // 2. 去重(素材 id 没发过)
  const seen = new Set(state.postedMaterialIds);
  const fresh = candidates.filter((c) => !seen.has(c.id));
  log(`素材: 行情 ${marketMoves.length} / 公告 ${announcements.length} / 新币 ${newCoins.length} / 费率 ${funding.length} / 鲸鱼 ${whales.length} / 情绪 ${fng.length} = 共 ${fresh.length} 条未发`);

  if (fresh.length === 0) {
    log("没有新素材, 本轮不发帖");
    saveState(state);
    return;
  }

  // 3. 节奏控制(时间线模式优先, 否则走最小间隔)
  if (config.schedule?.enabled) {
    const gate = timelineGate(state);
    if (!gate.ok) {
      log(`时间线: ${gate.msg}, 本轮不发`);
      saveState(state);
      return;
    }
  } else if (!canPostNow(state)) {
    log(`节奏未到 (今日已发 ${state.todayPosted}/${config.postsPerDay}, 最小间隔 ${config.minIntervalMinutes}min), 本轮不发`);
    saveState(state);
    return;
  }

  // 4. 排序: 新币 > 行情异动 > 费率/鲸鱼 > 公告 > 恐惧贪婪
  const kindRank = { newCoin: 0, market: 1, fundingRate: 2, whale: 3, announcement: 4, fearGreed: 5 };
  const sorted = [...fresh].sort((a, b) => (kindRank[a.kind] ?? 9) - (kindRank[b.kind] ?? 9));
  const material = sorted[0];
  const text = buildPost(material, config);
  log(`本轮待发 [${material.kind}]:\n${text}`);

  if (config.dryRun && !forceMode) {
    log("▶ dryRun 模式, 不真发。加 --force 可强制发这条");
    saveState(state);
    return;
  }

  // 5. 发帖
  const result = await publishPost(text);
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

async function main() {
  log("bns-bot 启动");
  log(`模式: ${config.dryRun ? "dryRun(不真发)" : "真发"}`);
  if (config.schedule?.enabled) {
    const s = config.schedule;
    const quiet = s.quiet?.from !== undefined ? `静默 ${s.quiet.from}:00-${s.quiet.to}:00` : "无静默";
    log(`节奏: 时间线排期 ${s.startHour}:00 起, 每 ${s.intervalMinutes}min 一 slot, 每天 ${s.maxPerDay} slot, ${quiet}`);
  } else {
    log(`节奏: 每轮 ${config.cycleMinutes}min, 每天 ≤${config.postsPerDay} 帖, 最小间隔 ${config.minIntervalMinutes}min`);
  }
  log(`监控: ${config.market.symbols.join(", ")} (${config.market.windowMinutes}min 内 ${config.market.priceChangePct}% + 量比 ${config.market.volSpikeMultiple}x)`);

  if (process.argv.includes("--test")) {
    await testPost();
    return;
  }
  if (process.argv.includes("--once")) {
    await runOnce(true);
    log("单次跑完, 退出");
    return;
  }

  // 常驻: 每 cycleMinutes 跑一轮
  const interval = config.cycleMinutes * 60000;
  log("连接公告 WebSocket...");
  connectAnnouncements();
  const onceMode = process.argv.includes("--once");
  await runOnce(onceMode);
  if (!onceMode) setInterval(() => runOnce(false), interval);
  log(`常驻运行中, 每 ${config.cycleMinutes} 分钟一轮, Ctrl+C 退出`);

  process.on("SIGINT", () => {
    log("收到 Ctrl+C, 保存状态退出");
    saveState(loadState());
    try { annWebSocket?.close(); } catch {}
    process.exit(0);
  });
}

main().catch((e) => {
  log("FATAL", e);
  process.exit(1);
});
