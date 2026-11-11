#!/usr/bin/env node
/**
 * refreshSymbols.js — 按 24h 成交额自动更新监控币种池
 *
 * 拉币安全所 24hr ticker, 过滤 USDT 计价 + 24h 成交额 >= 阈值,
 * 取前 topN 写入 config.json 的三处 symbols (market / fundingRate / whale)。
 *
 * 用法:
 *   node refreshSymbols.js              刷新一次(默认 topN=20, 成交额>=3000万)
 *   node refreshSymbols.js --top 30     指定取前 30
 *   node refreshSymbols.js --min-usd 50000000
 *
 * 想每天自动跑: 加个 Windows 计划任务, 每天 00:30 执行本脚本即可。
 */

const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const config = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const topN = parseInt(arg("--top", "20"), 10);
const minUsd = Number(arg("--min-usd", "30000000")); // 默认 3000 万刀

async function main() {
  const log = (...a) => console.log(`[${new Date().toLocaleString("zh-CN", { hour12: false })}]`, ...a);

  log(`拉全所 24hr ticker...`);
  const tickers = await fetch("https://data-api.binance.vision/api/v3/ticker/24hr").then((r) => r.json());

  // 过滤: USDT 计价 + 成交额达标
  // 排除"壳"币: 稳定币包装/ETF包装/杠杆代币等, 帖子写出来没人看
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

  const candidates = tickers
    .filter((t) => t.symbol.endsWith("USDT"))
    .filter((t) => {
      const base = t.symbol.replace("USDT", "");
      return !SHELL_BASES.has(base);
    })
    .filter((t) => {
      // quoteVolume 是计价币成交额, USDT 计价即 USDT 成交额(≈美元)
      return Number(t.quoteVolume) >= minUsd;
    })
    .sort((a, b) => Number(b.quoteVolume) - Number(a.quoteVolume))
    .slice(0, topN);

  const symbols = candidates.map((t) => t.symbol);

  if (symbols.length === 0) {
    log("没有符合的币种, 不更新");
    process.exit(0);
  }

  log(`取前 ${symbols.length} (成交额 ≥ ${minUsd.toLocaleString()}):`);
  symbols.forEach((s, i) => {
    const t = candidates[i];
    log(`  ${i + 1}. ${s.padEnd(10)} 24h量 ${(Number(t.quoteVolume) / 1e6).toFixed(0)}M  涨跌 ${t.priceChangePercent}%`);
  });

  // 写入配置(三处共用)
  config.market.symbols = symbols;
  if (config.fundingRate) config.fundingRate.symbols = symbols;
  if (config.whale) config.whale.symbols = symbols;
  config._symbolsAuto = {
    updated: new Date().toISOString(),
    topN,
    minUsd,
  };

  fs.writeFileSync(path.join(ROOT, "config.json"), JSON.stringify(config, null, 2));
  log(`已写入 config.json (market/fundingRate/whale 各 ${symbols.length} 个)`);
  log(`重启 bot 生效: node control.js stop && node control.js start`);
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
