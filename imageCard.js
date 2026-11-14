// 卡片 PNG 生成(纯 Node, 依赖 @napi-rs/canvas)。
// 卡片只用英文/数字(币种、涨跌幅、现价、量比、时间), 不渲染中文,
// 这样无需中文字体; 完整中文免责声明仍放在文字帖正文里。
const { createCanvas, GlobalFonts } = require("@napi-rs/canvas");

// GitHub Actions ubuntu 自带 DejaVu; 本地/其它环境若没有, 注册失败会 fallback 到 sans-serif。
// 字体缺失时字会渲染不出, 所以 bot.yml 里也确保安装了 fonts-dejavu-core。
for (const [p, family] of [
  ["/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "DejaVuSansBold"],
  ["/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "DejaVuSans"],
]) {
  try { GlobalFonts.registerFromPath(p, family); } catch (_) {}
}

const BG = "#0b0e11", CARD = "#181a20", FG = "#eaecef", SUB = "#848e9c";
const GREEN = "#0ecb81", RED = "#f6465d";

function fmtPrice(p) {
  const n = Number(p);
  if (!Number.isFinite(n) || n === 0) return "0";
  if (Math.abs(n) >= 1) return n.toLocaleString("en-US", { maximumFractionDigits: n >= 1000 ? 2 : 4 });
  let s = n.toPrecision(4);
  if (/e/i.test(s)) s = n.toFixed(20);
  return s.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

function makeMarketCard({ baseSymbol, pct, price, volMultiple, windowMinutes, at }) {
  const W = 1080, H = 1080;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, W, H);

  const up = Number(pct) >= 0;
  const accent = up ? GREEN : RED;
  const sign = up ? "+" : "";

  // 币种
  ctx.fillStyle = FG;
  ctx.font = 'bold 84px "DejaVuSansBold", sans-serif';
  ctx.fillText(`$${baseSymbol}`, 90, 175);

  // 副标题: 窗口 + 时间(CST)
  ctx.fillStyle = SUB;
  ctx.font = '34px "DejaVuSans", sans-serif';
  const t = at ? new Date(at) : new Date();
  const ts = `${t.toLocaleString("en-GB", { timeZone: "Asia/Shanghai", hour12: false })} CST`;
  ctx.fillText(`${windowMinutes}min ${up ? "gain" : "drop"} · ${ts}`, 90, 230);

  // 涨跌幅大字
  ctx.fillStyle = accent;
  ctx.font = 'bold 220px "DejaVuSansBold", sans-serif';
  ctx.fillText(`${sign}${Number(pct).toFixed(1)}%`, 90, 480);

  // 现价
  ctx.fillStyle = FG;
  ctx.font = '52px "DejaVuSans", sans-serif';
  ctx.fillText(`Price   ${fmtPrice(price)}`, 90, 600);

  // 量比
  ctx.fillText(`Volume  ×${Number(volMultiple).toFixed(1)}`, 90, 680);

  // 底部免责条
  ctx.fillStyle = CARD;
  ctx.fillRect(0, H - 96, W, 96);
  ctx.fillStyle = SUB;
  ctx.font = '30px "DejaVuSans", sans-serif';
  ctx.fillText("Not financial advice", 90, H - 40);

  return canvas.toBuffer("image/png");
}

// ---------- 热搜榜 / 涨跌榜 / 新币卡片 ----------
// 与行情卡共用同一套视觉规格: 1080×1080 深色底、纯 ASCII 文本、绿涨红跌、底部免责条。
// 只渲染 ASCII(币种符号等), 避免 runner 缺中文字体时出现方块字; 中文说明放在帖子正文里。
const GOLD = "#f0b90b";

function ascii(s, max = 14) {
  return String(s ?? "").replace(/[^\x20-\x7e]/g, "").trim().slice(0, max) || "-";
}
function fmtPct(p) {
  const n = Number(p);
  if (!Number.isFinite(n)) return "";
  return `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
}
function timeText(at) {
  const t = at ? new Date(at) : new Date();
  return `${t.toLocaleString("en-GB", { timeZone: "Asia/Shanghai", hour12: false })} CST`;
}
// 公共框架: 背景 + 顶部主题色细条 + 标题 + 时间 + 底部免责条
function drawChrome(ctx, { title, subtitle, accent, at }) {
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, 1080, 1080);
  ctx.fillStyle = accent;
  ctx.fillRect(0, 0, 1080, 10);
  ctx.fillStyle = FG;
  ctx.font = 'bold 64px "DejaVuSansBold", sans-serif';
  ctx.fillText(title, 90, 135);
  ctx.fillStyle = SUB;
  ctx.font = '32px "DejaVuSans", sans-serif';
  ctx.fillText(`${subtitle} · ${timeText(at)}`, 90, 190);
  ctx.fillStyle = CARD;
  ctx.fillRect(0, 1080 - 96, 1080, 96);
  ctx.fillStyle = SUB;
  ctx.font = '30px "DejaVuSans", sans-serif';
  ctx.fillText("Not financial advice", 90, 1080 - 40);
}
function makeCard(draw) {
  const canvas = createCanvas(1080, 1080);
  const ctx = canvas.getContext("2d");
  draw(ctx);
  return canvas.toBuffer("image/png");
}

function makeTrendingCard({ items = [], at }) {
  return makeCard((ctx) => {
    drawChrome(ctx, { title: "TRENDING 24H", subtitle: "CoinGecko top search", accent: GOLD, at });
    const rows = items.slice(0, 6);
    if (!rows.length) {
      ctx.fillStyle = SUB;
      ctx.font = '40px "DejaVuSans", sans-serif';
      ctx.fillText("No trending data", 90, 340);
      return;
    }
    rows.forEach((it, i) => {
      const y = 310 + i * 105;
      ctx.fillStyle = SUB;
      ctx.font = '34px "DejaVuSans", sans-serif';
      ctx.fillText(`#${i + 1}`, 90, y);
      ctx.fillStyle = FG;
      ctx.font = 'bold 52px "DejaVuSansBold", sans-serif';
      ctx.fillText(`$${ascii(it.sym, 8)}`, 200, y);
      const pct = it.data?.price_change_percentage_24h?.usd;
      const label = fmtPct(pct);
      if (label) {
        ctx.fillStyle = Number(pct) >= 0 ? GREEN : RED;
        ctx.font = 'bold 44px "DejaVuSansBold", sans-serif';
        ctx.textAlign = "right";
        ctx.fillText(label, 990, y);
        ctx.textAlign = "left";
      }
      ctx.fillStyle = CARD;
      ctx.fillRect(90, y + 30, 900, 2);
    });
  });
}

function makeMoversCard({ items = [], at }) {
  return makeCard((ctx) => {
    drawChrome(ctx, { title: "24H MOVERS", subtitle: "Top gainers / losers", accent: GOLD, at });
    const valid = items.filter((i) => Number.isFinite(Number(i.pct)));
    const gainers = valid.filter((i) => Number(i.pct) >= 0).sort((a, b) => Number(b.pct) - Number(a.pct)).slice(0, 5);
    const losers = valid.filter((i) => Number(i.pct) < 0).sort((a, b) => Number(a.pct) - Number(b.pct)).slice(0, 5);
    const cols = [
      { x: 90, label: "GAINERS", color: GREEN, rows: gainers },
      { x: 560, label: "LOSERS", color: RED, rows: losers },
    ];
    for (const col of cols) {
      ctx.fillStyle = col.color;
      ctx.font = 'bold 36px "DejaVuSansBold", sans-serif';
      ctx.fillText(col.label, col.x, 290);
      if (!col.rows.length) {
        ctx.fillStyle = SUB;
        ctx.font = '32px "DejaVuSans", sans-serif';
        ctx.fillText("none", col.x, 370);
      }
      col.rows.forEach((it, i) => {
        const y = 370 + i * 110;
        ctx.fillStyle = FG;
        ctx.font = 'bold 46px "DejaVuSansBold", sans-serif';
        ctx.fillText(`$${ascii(it.sym, 8)}`, col.x, y);
        ctx.fillStyle = col.color;
        ctx.font = '34px "DejaVuSans", sans-serif';
        ctx.fillText(fmtPct(it.pct), col.x, y + 42);
      });
    }
  });
}

function makeNewCoinCard({ baseAsset, symbol, onboardDate, at }) {
  return makeCard((ctx) => {
    drawChrome(ctx, { title: "NEW LISTING", subtitle: "Binance Spot", accent: GREEN, at });
    const coin = ascii(baseAsset, 12);
    const size = coin.length > 8 ? 110 : coin.length > 5 ? 140 : 170;
    ctx.fillStyle = FG;
    ctx.font = `bold ${size}px "DejaVuSansBold", sans-serif`;
    ctx.fillText(`$${coin}`, 90, 500);
    ctx.fillStyle = SUB;
    ctx.font = '46px "DejaVuSans", sans-serif';
    ctx.fillText(`Pair   ${ascii(symbol, 16)}`, 90, 600);
    const days = Number(onboardDate)
      ? Math.max(0, Math.round((Date.now() - Number(onboardDate)) / 86400000))
      : 0;
    ctx.fillText(`Listed   ${days}d ago`, 90, 670);
  });
}

// ---------- 资讯卡片 ----------
// 只渲染 RSS 的英文原标题(翻译前), 中文标题/摘要仍在帖子正文里, 因此无需中文字体。
// 弯引号 / 破折号等先换成 ASCII 等价字符, 其余非 ASCII 直接剔除, 避免出现方块字。
function asciiTitle(s) {
  return String(s ?? "")
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”„]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...")
    .replace(/\u00a0/g, " ")
    .replace(/[^\x20-\x7e]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
// 按 measureText 折行; 超过 maxLines 时末行加省略号, 避免长标题溢出卡片
function wrapAscii(ctx, text, maxWidth, maxLines) {
  const lines = [];
  let cur = "";
  for (const w of text.split(/\s+/).filter(Boolean)) {
    const next = cur ? `${cur} ${w}` : w;
    if (cur && ctx.measureText(next).width > maxWidth) { lines.push(cur); cur = w; }
    else cur = next;
  }
  if (cur) lines.push(cur);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  let last = kept[maxLines - 1];
  while (last.length && ctx.measureText(`${last}…`).width > maxWidth) last = last.slice(0, -1);
  kept[maxLines - 1] = `${last.trimEnd()}…`;
  return kept;
}

function makeNewsCard({ titleEn, at }) {
  return makeCard((ctx) => {
    // 不写来源媒体名: 卡片上挂第三方平台标识容易被当成引流
    drawChrome(ctx, { title: "CRYPTO NEWS", subtitle: "Latest headlines", accent: GOLD, at });
    const title = asciiTitle(titleEn) || "No headline available";
    ctx.fillStyle = FG;
    ctx.font = 'bold 60px "DejaVuSansBold", sans-serif';
    wrapAscii(ctx, title, 900, 5).forEach((line, i) => ctx.fillText(line, 90, 430 + i * 92));
  });
}

module.exports = { makeMarketCard, makeTrendingCard, makeMoversCard, makeNewCoinCard, makeNewsCard };
