#!/usr/bin/env node
/**
 * symbolPool.js — 按 24h 成交额挑选监控币种池
 *
 * 云端 bot.js(--once) 与本地 refreshSymbols.js 共用同一份筛选规则,
 * 避免两套规则各自漂移。本文件不读写任何配置文件, 只负责取数 + 筛选。
 */

const TICKER_URL = "https://data-api.binance.vision/api/v3/ticker/24hr";
const DEFAULT_TOP_N = 16;
const DEFAULT_MIN_USD = 30000000;

// 排除"壳"币: 稳定币包装 / ETF 股票包装 / 杠杆代币 / 代币化黄金 / 跨链桥等,
// 这些交易对即便成交额够高, 写出来也没人看。
const SHELL_BASES = new Set([
  // 稳定币
  "USDC", "USD1", "USDE", "FDUSD", "TUSD", "PYUSD", "DAI",
  "RLUSD", "USDP", "BUSD", "USDS", "USDF", "USDJ", "USDT0",
  // ETF / 股票包装 (含 B 结尾的杠杆/反向)
  "SNDKB", "SNDLP", "SOXL", "SOXLB", "SPCX", "SPCXB", "SPCXLB", "SPCXLE",
  "CRCLB", "MSTRB", "COINB", "TSLAB", "NVDA", "AALB",
  // 代币化黄金/贵金属
  "XAUT", "PAXG", "GOLD", "XAUTI",
  // 跨链桥
  "ETHBTC", "BTCETH", "WBTC", "WETH", "STETH", "WSTETH", "CBETH",
]);

/**
 * 纯函数: 从 24hr ticker 数组里挑出币种池, 便于离线验证筛选规则。
 * @returns {{ symbols: string[], rows: object[] }}
 */
function pickSymbols(tickers, { topN = DEFAULT_TOP_N, minUsd = DEFAULT_MIN_USD } = {}) {
  if (!Array.isArray(tickers)) return { symbols: [], rows: [] };
  const rows = tickers
    .filter((t) => t && typeof t.symbol === "string" && t.symbol.endsWith("USDT"))
    .filter((t) => !SHELL_BASES.has(t.symbol.replace("USDT", "")))
    .filter((t) => Number(t.quoteVolume) >= minUsd)
    .sort((a, b) => Number(b.quoteVolume) - Number(a.quoteVolume))
    .slice(0, topN);
  return { symbols: rows.map((t) => t.symbol), rows };
}

/** 拉全所 24hr ticker 并筛选; 全量响应几百 KB, 超时单独放宽到 30 秒。 */
async function fetchSymbolPool({ topN = DEFAULT_TOP_N, minUsd = DEFAULT_MIN_USD, timeoutMs = 30000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(TICKER_URL, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${TICKER_URL}`);
    const picked = pickSymbols(await res.json(), { topN, minUsd });
    if (!picked.symbols.length) throw new Error("没有符合成交额门槛的币种");
    return picked;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  TICKER_URL, DEFAULT_TOP_N, DEFAULT_MIN_USD, SHELL_BASES, pickSymbols, fetchSymbolPool,
};
