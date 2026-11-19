/**
 * 帖子解读段: 只从素材已有字段推导(行情/热搜/涨跌), 不编造数据、不给买卖建议。
 * 依据币安创作者学院《How to Post for Better Reach》: 字数不是重点,
 * 关键是要有"自己的判断"而非纯搬运; 红线是不做结论式预测、不给投资建议。
 * 无网络、不编造数据; 档内随机二选一增加变化(不联网、不耗 LLM 额度)。
 *
 * 注: 资讯(news)的解读不在这里——资讯帖整帖由 LLM 改写(见 bot.js genNewsRewrite), 失败走 A 兜底;
 *     热搜/涨跌榜/币安合约榜由 LLM 点评优先(m.take), 本文件只作为 LLM 失败时的规则回退。
 */

function p1(n) {
  const v = Number(n);
  return Number.isFinite(v) ? Math.abs(v).toFixed(1) : "0.0";
}
// 档内二选一, 同一档不至于每次都逐字一样
function pick2(a, b) { return Math.random() < 0.5 ? a : b; }

// 行情解读: 按"波动强度 × 量能"分 8 档说人话, 不用"我会先看…"这种书面分析腔,
// 也不给操作指令。每档 2 句变体随机选, 收尾也 2 选 1, 组合数翻倍但不联网、不耗 LLM 额度。
function marketTake(m) {
  const up = Number(m.pct) >= 0;
  const pct = Math.abs(Number(m.pct));
  const vol = Number(m.volMultiple);
  const heavy = Number.isFinite(vol) && vol >= 1.5;
  let body;
  if (up) {
    if (pct >= 5 && heavy) body = pick2(
      `短时间拉了 ${p1(m.pct)}%，量也跟着放出来，这种齐头并进的样子说明买盘不是零零散散的。`,
      `一下子冲了 ${p1(m.pct)}%，成交明显比平时活跃，买方这会儿挺集中。`);
    else if (pct >= 5) body = pick2(
      `涨了 ${p1(m.pct)}%，不过量能没怎么跟上，光看价格有点单薄。`,
      `价格窜了 ${p1(m.pct)}%，可成交没放大多少，这波涨得有点虚。`);
    else if (heavy) body = pick2(
      `涨 ${p1(m.pct)}% 不算大，但量能明显比平时活跃，有点资金在试探的意思。`,
      `涨幅一般，量倒是不小，看着像有人在慢慢吸。`);
    else body = pick2(
      `小涨 ${p1(m.pct)}%，量能平平，就是普通的盘中波动。`,
      `微涨 ${p1(m.pct)}%，没什么量，属于正常起伏。`);
  } else {
    if (pct >= 5 && heavy) body = pick2(
      `短时间砸了 ${p1(m.pct)}%，量也放出来了，抛压是实打实的。`,
      `一下跌了 ${p1(m.pct)}%，卖盘跟着放大，这次的下跌有量。`);
    else if (pct >= 5) body = pick2(
      `跌了 ${p1(m.pct)}%，但量能没跟上，看着更像是没人接而不是有人在砸。`,
      `价格掉了 ${p1(m.pct)}%，成交却没什么变化，更像是买盘缩了。`);
    else if (heavy) body = pick2(
      `跌 ${p1(m.pct)}% 幅度不大，可量能比平时高，有点不对劲。`,
      `跌幅有限，量却比平时大，这反差挺值得留意。`);
    else body = pick2(
      `小跌 ${p1(m.pct)}%，量能一般，没什么特别的。`,
      `微跌 ${p1(m.pct)}%，成交也平淡，就是普通波动。`);
  }
  return body + pick2("不过就这几十分钟的事，先别急着下结论。", "当然，短时间说明不了太多，继续看着就是。");
}

function trendingTake(m) {
  const rows = (m.items ?? []).slice(0, 6)
    .map((it) => ({ sym: it.sym || it.name || "该币", chg: it.data?.price_change_percentage_24h?.usd }))
    .filter((r) => typeof r.chg === "number" && Number.isFinite(r.chg));
  if (!rows.length) {
    return "这份榜单没有可用的 24h 涨跌数据，单凭搜索排名看不出方向。";
  }
  const signed = (n) => `${n >= 0 ? "+" : "-"}${p1(n)}`;
  const down = rows.filter((r) => r.chg < 0).length;
  const up = rows.filter((r) => r.chg > 0).length;
  const biggest = rows.reduce((a, b) => Math.abs(b.chg) > Math.abs(a.chg) ? b : a);
  const tiedBig = rows.filter((r) => Math.abs(Math.abs(r.chg) - Math.abs(biggest.chg)) < 0.05).length > 1;
  const highlight = tiedBig
    ? "几个币波动幅度接近，没有谁特别突出"
    : `${biggest.sym} ${signed(biggest.chg)}% 波动最突出`;
  const majors = new Set(["BTC", "ETH", "SOL", "BNB", "XRP", "DOGE", "ADA", "AVAX", "LINK", "DOT"]);
  const majorCount = rows.filter((r) => majors.has(r.sym)).length;

  // 单个币波动明显大出一截：点名说清热度集中在谁身上, 不猜原因
  const rest = rows.filter((r) => r !== biggest);
  const runnerUp = rest.length ? Math.max(...rest.map((r) => Math.abs(r.chg))) : 0;
  if (Math.abs(biggest.chg) >= 8 && Math.abs(biggest.chg) > runnerUp * 3) {
    if (!rest.length) return `榜单里只有 ${biggest.sym} 有可用的 24h 数据（${signed(biggest.chg)}%），单一样本看不出榜单方向。`;
    const restDown = rest.filter((r) => r.chg < 0).length;
    return `榜单里 ${biggest.sym} 24h ${signed(biggest.chg)}%，波动比其余币都大出一截；另外 ${rest.length} 个里有 ${restDown} 个在跌，热搜多半是冲着这一个币去的。`;
  }
  // 主流币占多数：说清注意力的底盘, 不推断板块轮动
  if (majorCount >= Math.ceil(rows.length / 2)) {
    const mix = majorCount === rows.length ? "清一色主流币" : `里 ${majorCount} 个主流币夹着几个中小市值`;
    return `榜单${mix}，注意力还是围着熟悉的几个名字转，没有明显挤向单一方向。`;
  }
  // 涨跌分布: 只陈述方向和波动, 不推断资金意图(最大波动可能是反向的)
  if (!up && !down) return `${rows.length} 个币 24h 基本持平，这份榜单看不出方向。`;
  if (down > up) return `榜单里 ${down} 个在跌、${up} 个在涨，跌的一方占多数；${highlight}。`;
  if (up > down) return `榜单里 ${up} 个在涨、${down} 个在跌，涨的一方占多数；${highlight}。`;
  const topUp = rows.reduce((a, b) => b.chg > a.chg ? b : a);
  const topDown = rows.reduce((a, b) => b.chg < a.chg ? b : a);
  return `${rows.length} 个币涨跌各半，涨得最多的是 ${topUp.sym} ${signed(topUp.chg)}%，跌得最狠的是 ${topDown.sym} ${signed(topDown.chg)}%，方向对不上；这份榜单更像观察名单。`;
}

function moversTake(m) {
  const items = m.items ?? [];
  const up = items.filter((i) => Number(i.pct) >= 0);
  const down = items.filter((i) => Number(i.pct) < 0);
  const nums = down.map((i) => Math.abs(Number(i.pct))).filter(Number.isFinite);
  const range = nums.length
    ? `，跌幅集中在 ${Math.min(...nums).toFixed(0)}%–${Math.max(...nums).toFixed(0)}%`
    : "";
  let lead;
  if (down.length && !up.length) {
    lead = `榜单领跌 ${down.length} 个、没有涨幅达标的币${range}，属于同步回撤而非个别币的问题。`;
  } else if (up.length && !down.length) {
    lead = `榜单领涨 ${up.length} 个、没有跌幅达标的币，属于普涨而非个别币独立走强。`;
  } else {
    lead = `榜单领涨 ${up.length} 个、领跌 ${down.length} 个，涨跌分化说明资金在挑方向，不是整体单边。`;
  }
  return lead + "真要琢磨，先看大盘和杠杆清算，一个个找理由反而容易想多。";
}

// 币安合约榜: 回退也要点名币种并做数字比较, 不再写"合约带杠杆""看个热闹"这类通用句。
function binanceMoversTake(m) {
  const clean = (arr) => (arr ?? [])
    .map((x) => ({ sym: x.sym, pct: Number(x.pct) }))
    .filter((x) => x.sym && Number.isFinite(x.pct));
  const up = clean(m.up).sort((a, b) => b.pct - a.pct);
  const down = clean(m.down).sort((a, b) => a.pct - b.pct);
  if (!up.length && !down.length) return "这份合约榜没有可用的涨跌数据。";

  const topUp = up[0], topDown = down[0], secondUp = up[1];
  const parts = [];
  if (topUp) {
    let s = `领涨 ${topUp.sym} +${p1(topUp.pct)}%`;
    if (secondUp && topUp.pct > 0 && secondUp.pct > 0) {
      const ratio = topUp.pct / secondUp.pct;
      if (ratio >= 1.4) s += `，是第二名 ${secondUp.sym} +${p1(secondUp.pct)}% 的 ${ratio.toFixed(1)} 倍，断层领先`;
      else if (ratio <= 1.15) s += `，和第二名 ${secondUp.sym} +${p1(secondUp.pct)}% 咬得很近`;
      else s += `，后面 ${secondUp.sym} +${p1(secondUp.pct)}% 也跟得不慢`;
    }
    parts.push(s);
  } else parts.push("领涨端没有达到波动门槛的币");

  if (topDown) parts.push(`领跌 ${topDown.sym} -${p1(topDown.pct)}%`);
  else parts.push("领跌端没有达到波动门槛的币");

  let compare;
  if (topUp && topDown) {
    const a = topUp.pct, b = Math.abs(topDown.pct);
    compare = a > b * 1.5 ? "涨幅端波动比跌幅端猛得多"
      : b > a * 1.5 ? "跌幅端波动比涨幅端猛得多"
      : "涨跌两端波动幅度接近";
  } else if (topUp) compare = "跌幅端没有达标标的，属于单边上涨";
  else compare = "涨幅端没有达标标的，属于单边下跌";

  return `${parts.join("；")}。${compare}；${up.length} 涨对 ${down.length} 跌。`;
}

function buildTake(m) {
  switch (m.kind) {
    case "market": return marketTake(m);
    case "trending": return trendingTake(m);
    case "movers": return moversTake(m);
    case "binanceMovers": return binanceMoversTake(m);
    default: return "";
  }
}

module.exports = { buildTake };
