/**
 * 帖子解读段: 只从素材已有字段推导(行情/新币/热搜/涨跌), 不编造数据、不给买卖建议。
 * 依据币安创作者学院《How to Post for Better Reach》: 字数不是重点,
 * 关键是要有"自己的判断"而非纯搬运; 红线是不做结论式预测、不给投资建议。
 * 纯函数(无随机、无网络), 便于离线验证。
 *
 * 注: 资讯(news)的解读不在这里——资讯帖整帖由 LLM 改写(见 bot.js genNewsRewrite), 失败走 A 兜底;
 *     热搜/涨跌榜由 LLM 点评优先(m.take), 本文件只作为 LLM 失败时的规则回退。
 */

function p1(n) {
  const v = Number(n);
  return Number.isFinite(v) ? Math.abs(v).toFixed(1) : "0.0";
}

// 行情解读: 按"波动强度 × 量能"分档说人话, 不用"我会先看…"这种书面分析腔,
// 也不给操作指令。每档一句+, 末尾统一提醒短窗口别当趋势。纯函数, 便于离线验证。
function marketTake(m) {
  const up = Number(m.pct) >= 0;
  const pct = Math.abs(Number(m.pct));
  const vol = Number(m.volMultiple);
  const heavy = Number.isFinite(vol) && vol >= 1.5;
  let body;
  if (up) {
    if (pct >= 5 && heavy) body = `短时间拉了 ${p1(m.pct)}%，量也跟着放出来，这种齐头并进的样子说明买盘不是零零散散的。`;
    else if (pct >= 5) body = `涨了 ${p1(m.pct)}%，不过量能没怎么跟上，光看价格有点单薄。`;
    else if (heavy) body = `涨 ${p1(m.pct)}% 不算大，但量能明显比平时活跃，有点资金在试探的意思。`;
    else body = `小涨 ${p1(m.pct)}%，量能平平，就是普通的盘中波动。`;
  } else {
    if (pct >= 5 && heavy) body = `短时间砸了 ${p1(m.pct)}%，量也放出来了，抛压是实打实的。`;
    else if (pct >= 5) body = `跌了 ${p1(m.pct)}%，但量能没跟上，看着更像是没人接而不是有人在砸。`;
    else if (heavy) body = `跌 ${p1(m.pct)}% 幅度不大，可量能比平时高，有点不对劲。`;
    else body = `小跌 ${p1(m.pct)}%，量能一般，没什么特别的。`;
  }
  return body + "不过就这几十分钟的事，先别急着下结论。";
}

function newCoinTake(m) {
  const onboard = Number(m.onboardDate);
  const hasOnboard = Number.isFinite(onboard) && onboard > 0;
  const days = hasOnboard ? Math.max(1, Math.round((Date.now() - onboard) / 86400000)) : 0;
  const lead = days ? `上线才 ${days} 天，` : "刚上线不久，";
  return lead
    + "这种币基本没有历史走势能参考，涨跌全看筹码怎么分布、盘口有多深。"
    + "拿老币那套波动率去套它，很容易看走眼。";
}

function trendingTake(m) {
  const chgs = (m.items ?? []).slice(0, 6)
    .map((it) => it.data?.price_change_percentage_24h?.usd)
    .filter((x) => typeof x === "number" && Number.isFinite(x));
  let lead;
  if (!chgs.length) {
    lead = "这份榜单没有可用的 24h 涨跌数据，单凭搜索排名看不出方向。";
  } else {
    const down = chgs.filter((x) => x < 0).length;
    const up = chgs.length - down;
    if (down > up) {
      lead = `这份榜单里 ${chgs.length} 个币有 ${down} 个 24h 下跌，搜索热度更像是回撤带来的关注，而不是资金追涨。`;
    } else if (up > down) {
      lead = `这份榜单里 ${chgs.length} 个币有 ${up} 个 24h 上涨，热度与价格同向，注意力确实跟着涨幅走。`;
    } else {
      lead = `这份榜单涨跌各半（${up} 涨 / ${down} 跌），热度并没有指向一致方向。`;
    }
    lead += "热搜排名反映的是注意力，不等于资金流向；注意力先到、资金未必跟。";
  }
  return lead + "说白了就是个观察名单，别把它当信号。";
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

function buildTake(m) {
  switch (m.kind) {
    case "market": return marketTake(m);
    case "newCoin": return newCoinTake(m);
    case "trending": return trendingTake(m);
    case "movers": return moversTake(m);
    default: return "";
  }
}

module.exports = { buildTake };
