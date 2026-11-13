// 行情卡片 PNG 生成(纯 Node, 依赖 @napi-rs/canvas)。
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
  ctx.fillText("Auto-posted by bns-bot · Not financial advice", 90, H - 40);

  return canvas.toBuffer("image/png");
}

module.exports = { makeMarketCard };
