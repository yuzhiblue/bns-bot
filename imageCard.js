// 卡片 PNG 生成(纯 Node, 依赖 @napi-rs/canvas)。
// 行情/榜单卡只用英文数字(免中文字体); 资讯卡渲染中文标题, 需注册 CJK 字体。
const { createCanvas, GlobalFonts } = require("@napi-rs/canvas");

// DejaVu: 英文/数字; CI(bot.yml)装 fonts-dejavu-core。
// CJK: 资讯中文标题; CI 装 fonts-noto-cjk, Windows 本地用系统微软雅黑。
// 注册失败不抛错——资讯卡会回退到英文标题(见 makeNewsCard)。
for (const [p, family] of [
  ["/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "DejaVuSansBold"],
  ["/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "DejaVuSans"],
  ["/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc", "CJK"],
  ["/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc", "CJKBold"],
  ["C:/Windows/Fonts/msyh.ttc", "CJK"],
  ["C:/Windows/Fonts/msyhbd.ttc", "CJKBold"],
]) {
  try { GlobalFonts.registerFromPath(p, family); } catch (_) {}
}
const HAS_CJK = GlobalFonts.families.some((f) => f.family === "CJK");
const CJK_FONT = HAS_CJK ? '"CJK"' : '"DejaVuSans"';
const CJK_BOLD = GlobalFonts.families.some((f) => f.family === "CJKBold") ? '"CJKBold"' : CJK_FONT;

const BG = "#0b0e11", CARD = "#181a20", FG = "#eaecef", SUB = "#848e9c";
const GREEN = "#0ecb81", RED = "#f6465d";

// ---------- 视觉框架: 渐变背景 + 顶部主题光晕 + 圆角内容面板 ----------
const PANEL = "#1c2129", PANEL_ALT = "#222833", BORDER = "#2b3139";

function hex2rgb(hex) {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function rgba(hex, a) {
  const [r, g, b] = hex2rgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}
// 整卡背景: 深色底 + 顶部主题色柔光晕, 让纯文字卡也有层次
function drawBackground(ctx, accent) {
  const g = ctx.createLinearGradient(0, 0, 0, 1080);
  g.addColorStop(0, "#121820");
  g.addColorStop(1, BG);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 1080, 1080);
  const glow = ctx.createRadialGradient(300, 0, 0, 300, 0, 760);
  glow.addColorStop(0, rgba(accent, 0.16));
  glow.addColorStop(1, rgba(accent, 0));
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, 1080, 620);
}
// 顶部渐变主题条
function drawTopBar(ctx, accent) {
  const g = ctx.createLinearGradient(0, 0, 1080, 0);
  g.addColorStop(0, rgba(accent, 0.35));
  g.addColorStop(0.5, accent);
  g.addColorStop(1, rgba(accent, 0.35));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 1080, 8);
}
// 圆角面板
function roundPanel(ctx, x, y, w, h, r = 28) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.fillStyle = PANEL;
  ctx.fill();
  ctx.strokeStyle = BORDER;
  ctx.lineWidth = 2;
  ctx.stroke();
}
// 底部免责条: 与背景融合, 用细分隔线代替硬切色块
function drawFooter(ctx) {
  ctx.fillStyle = BORDER;
  ctx.fillRect(90, 1080 - 92, 900, 2);
  ctx.fillStyle = SUB;
  ctx.font = '28px "DejaVuSans", sans-serif';
  ctx.fillText("Not financial advice", 90, 1080 - 42);
}

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

  const up = Number(pct) >= 0;
  const accent = up ? GREEN : RED;
  const sign = up ? "+" : "";

  drawBackground(ctx, accent);
  drawTopBar(ctx, accent);

  // 币种
  ctx.fillStyle = FG;
  ctx.font = 'bold 84px "DejaVuSansBold", sans-serif';
  ctx.fillText(`$${baseSymbol}`, 90, 180);

  // 副标题: 窗口 + 时间(CST)
  ctx.fillStyle = SUB;
  ctx.font = '34px "DejaVuSans", sans-serif';
  const t = at ? new Date(at) : new Date();
  const ts = `${t.toLocaleString("en-GB", { timeZone: "Asia/Shanghai", hour12: false })} CST`;
  ctx.fillText(`${windowMinutes}min ${up ? "gain" : "drop"} · ${ts}`, 90, 234);

  // 涨跌幅大字 + 主题色柔光面板
  ctx.fillStyle = rgba(accent, 0.10);
  ctx.beginPath();
  ctx.roundRect(70, 280, 940, 300, 32);
  ctx.fill();
  ctx.strokeStyle = rgba(accent, 0.30);
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = accent;
  ctx.font = 'bold 210px "DejaVuSansBold", sans-serif';
  ctx.fillText(`${sign}${Number(pct).toFixed(1)}%`, 110, 490);

  // 现价 / 量比: 两个小面板
  ctx.fillStyle = PANEL;
  ctx.beginPath();
  ctx.roundRect(70, 620, 450, 150, 24);
  ctx.fill();
  ctx.beginPath();
  ctx.roundRect(560, 620, 450, 150, 24);
  ctx.fill();
  ctx.fillStyle = SUB;
  ctx.font = '26px "DejaVuSans", sans-serif';
  ctx.fillText("PRICE", 100, 672);
  ctx.fillText("VOLUME", 590, 672);
  ctx.fillStyle = FG;
  ctx.font = 'bold 46px "DejaVuSans", sans-serif';
  ctx.fillText(fmtPrice(price), 100, 730);
  ctx.fillText(`×${Number(volMultiple).toFixed(1)}`, 590, 730);

  drawFooter(ctx);

  return canvas.toBuffer("image/png");
}

// ---------- 热搜榜 / 涨跌榜卡片 ----------
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
// 公共框架: 渐变背景 + 顶部主题条 + 标题 + 时间 + 底部免责条
function drawChrome(ctx, { title, subtitle, accent, at }) {
  drawBackground(ctx, accent || GOLD);
  drawTopBar(ctx, accent || GOLD);
  ctx.fillStyle = FG;
  ctx.font = 'bold 64px "DejaVuSansBold", sans-serif';
  ctx.fillText(title, 90, 140);
  ctx.fillStyle = SUB;
  ctx.font = '32px "DejaVuSans", sans-serif';
  ctx.fillText(`${subtitle} · ${timeText(at)}`, 90, 194);
  drawFooter(ctx);
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
      const y = 280 + i * 108;
      ctx.fillStyle = i % 2 === 0 ? PANEL : PANEL_ALT;
      ctx.beginPath();
      ctx.roundRect(70, y - 52, 940, 92, 18);
      ctx.fill();
      ctx.fillStyle = SUB;
      ctx.font = '34px "DejaVuSans", sans-serif';
      ctx.fillText(`#${i + 1}`, 100, y);
      ctx.fillStyle = FG;
      ctx.font = 'bold 52px "DejaVuSansBold", sans-serif';
      ctx.fillText(`$${ascii(it.sym, 8)}`, 210, y);
      const pct = it.data?.price_change_percentage_24h?.usd;
      const label = fmtPct(pct);
      if (label) {
        const up = Number(pct) >= 0;
        ctx.fillStyle = rgba(up ? GREEN : RED, 0.14);
        ctx.beginPath();
        ctx.roundRect(800, y - 44, 180, 66, 14);
        ctx.fill();
        ctx.fillStyle = up ? GREEN : RED;
        ctx.font = 'bold 42px "DejaVuSansBold", sans-serif';
        ctx.textAlign = "center";
        ctx.fillText(label, 890, y + 2);
        ctx.textAlign = "left";
      }
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
      roundPanel(ctx, col.x - 20, 250, 440, 640, 24);
      ctx.fillStyle = col.color;
      ctx.font = 'bold 36px "DejaVuSansBold", sans-serif';
      ctx.fillText(col.label, col.x, 306);
      if (!col.rows.length) {
        ctx.fillStyle = SUB;
        ctx.font = '32px "DejaVuSans", sans-serif';
        ctx.fillText("none", col.x, 386);
      }
      col.rows.forEach((it, i) => {
        const y = 386 + i * 110;
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

// 中文按字符折行(中文没有空格, wrapAscii 按词折行对中文无效)
function wrapCjk(ctx, text, maxWidth, maxLines) {
  const lines = [];
  let cur = "";
  for (const ch of String(text)) {
    const next = cur + ch;
    if (cur && ctx.measureText(next).width > maxWidth) { lines.push(cur); cur = ch; }
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

function makeNewsCard({ titleZh, titleEn, at }) {
  return makeCard((ctx) => {
    // 不写来源媒体名: 卡片上挂第三方平台标识容易被当成引流
    drawChrome(ctx, { title: HAS_CJK ? "加密资讯" : "CRYPTO NEWS", subtitle: "Latest headlines", accent: GOLD, at });
    // 有中文字体 + 有中文标题 → 渲染中文(实测英文标题卡对中文用户是劝退项);
    // 否则回退英文原题(无 CJK 字体的环境仍可用)。
    const useZh = HAS_CJK && titleZh && /[\u4e00-\u9fff]/.test(titleZh);
    const panelTop = 270, panelH = 640, panelMid = panelTop + panelH / 2;
    roundPanel(ctx, 70, panelTop, 940, panelH, 28);
    ctx.fillStyle = FG;
    if (useZh) {
      const lh = 96;
      ctx.font = `54px ${CJK_FONT}, sans-serif`;
      const lines = wrapCjk(ctx, String(titleZh).replace(/\s+/g, " "), 880, 6);
      const startY = panelMid - (lines.length - 1) * lh / 2 + 18;
      lines.forEach((line, i) => ctx.fillText(line, 100, startY + i * lh));
    } else {
      const lh = 92;
      const title = asciiTitle(titleEn) || "No headline available";
      ctx.font = 'bold 60px "DejaVuSansBold", sans-serif';
      const lines = wrapAscii(ctx, title, 880, 5);
      const startY = panelMid - (lines.length - 1) * lh / 2 + 20;
      lines.forEach((line, i) => ctx.fillText(line, 100, startY + i * lh));
    }
  });
}

// 通用数据卡: 给资金费率/持仓/多空/形态/合约榜五类新素材共用。
// 只渲染 ASCII(币种+数字), 中文说明放正文; 行内容由 bot.js 传纯文本, 不渲染中文。
function makeDataCard({ title, subtitle, rows = [], accent = GOLD, at }) {
  return makeCard((ctx) => {
    drawChrome(ctx, { title: ascii(title, 24), subtitle: ascii(subtitle, 40), accent, at });
    roundPanel(ctx, 70, 270, 940, 640, 28);
    rows.slice(0, 8).forEach((row, i) => {
      const y = 344 + i * 76;
      if (i % 2 === 0) {
        ctx.fillStyle = PANEL_ALT;
        ctx.beginPath();
        ctx.roundRect(88, y - 46, 904, 66, 12);
        ctx.fill();
      }
      ctx.fillStyle = i % 2 === 0 ? FG : SUB;
      ctx.font = 'bold 44px "DejaVuSansBold", sans-serif';
      ctx.fillText(ascii(row, 42), 108, y);
    });
  });
}

module.exports = { makeMarketCard, makeTrendingCard, makeMoversCard, makeNewsCard, makeDataCard };
