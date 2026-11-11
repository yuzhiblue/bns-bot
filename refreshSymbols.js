#!/usr/bin/env node
/**
 * refreshSymbols.js — 按 24h 成交额自动更新监控币种池(本地常驻模式用)
 *
 * 云端 GitHub Actions 走 bot.js --once, 由 bot 每天自己刷新并存进 state.json;
 * 本脚本只服务本地常驻模式, 筛选规则与云端共用 symbolPool.js。
 *
 * 用法:
 *   node refreshSymbols.js              刷新一次(默认 topN=16, 成交额>=3000万)
 *   node refreshSymbols.js --top 30     指定取前 30
 *   node refreshSymbols.js --min-usd 50000000
 *
 * 想每天自动跑: 加个 Windows 计划任务, 每天 00:30 执行 daily-refresh.bat 即可。
 */

const fs = require("fs");
const path = require("path");
const { fetchSymbolPool, DEFAULT_TOP_N, DEFAULT_MIN_USD } = require("./symbolPool");

const ROOT = __dirname;
const config = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const topN = parseInt(arg("--top", String(DEFAULT_TOP_N)), 10);
const minUsd = Number(arg("--min-usd", String(DEFAULT_MIN_USD)));

async function main() {
  const log = (...a) => console.log(`[${new Date().toLocaleString("zh-CN", { hour12: false })}]`, ...a);

  log("拉全所 24hr ticker...");
  let symbols, rows;
  try {
    ({ symbols, rows } = await fetchSymbolPool({ topN, minUsd }));
  } catch (e) {
    log(`拉取/筛选失败: ${e.message}, 保持原配置`);
    process.exit(0);
  }

  log(`取前 ${symbols.length} (成交额 ≥ ${minUsd.toLocaleString()}):`);
  symbols.forEach((s, i) => {
    const t = rows[i];
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
  log("重启 bot 生效: node control.js stop && node control.js start");
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
