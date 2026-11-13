/**
 * 帖子解读段: 只从素材已有字段推导, 不编造数据、不给买卖建议。
 * 依据币安创作者学院《How to Post for Better Reach》: 字数不是重点,
 * 关键是要有"自己的判断"而非纯搬运; 红线是不做结论式预测、不给投资建议。
 * 纯函数(无随机、无网络), 便于离线验证。
 */

function p1(n) {
  const v = Number(n);
  return Number.isFinite(v) ? Math.abs(v).toFixed(1) : "0.0";
}

function marketTake(m) {
  const up = Number(m.pct) >= 0;
  const window = m.windowMinutes ?? 30;
  const vol = Number(m.volMultiple);
  const volPart = Number.isFinite(vol) && vol > 1
    ? `成交量放大到 ${vol.toFixed(1)} 倍，属于量价同步的短时脉冲。`
    : "成交量没有明显放大，价格与量能并不同步。";
  const first = `${window} 分钟内${up ? "涨" : "跌"} ${p1(m.pct)}%，${volPart}`;
  const second = up
    ? "这类走势我会先看回踩时的量能：缩量回踩说明抛压有限，放量回踩更像获利了结。"
    : "这类走势我会先看反弹时的量能：缩量反弹说明承接有限，放量反弹才更像有资金接。";
  return first + second + "短窗口只反映当下，还不能当作趋势确认。";
}

function newCoinTake(m) {
  const onboard = Number(m.onboardDate);
  const hasOnboard = Number.isFinite(onboard) && onboard > 0;
  const days = hasOnboard ? Math.max(1, Math.round((Date.now() - onboard) / 86400000)) : 0;
  // 缺上线时间就不写天数, 不拿默认值 1 冒充事实
  const lead = days
    ? `上线 ${days} 天，仍处在价格发现阶段，可参考的历史结构很少。`
    : "新币仍处在价格发现阶段，可参考的历史结构很少。";
  return lead
    + "这个阶段的波动更多由筹码分布和做市深度决定，套用成熟币的波动率容易误判。"
    + "先看 24 小时换手和盘口深度是否稳定，再谈方向更稳妥。";
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
  return lead + "我更愿意把它当观察名单，而不是入场信号。";
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
  return lead + "面对这类榜单先看大盘与杠杆清算，再逐个给个币找理由容易过度解读。";
}

function newsTake(m) {
  const text = `${m.title ?? ""} ${m.summary ?? ""}`;
  // 只引用摘要里真实出现的数字, 提取不到就用中性框架, 绝不凭空造细节
  const hit = /(\d[\d,]*(?:\.\d+)?)\s*(美元|美金|USDT|%|个百分点)/.exec(text);
  // 原文里数字与单位间可能带空格(如 "70,000 美元"), 统一去掉再接中文, 避免出现 "70,000 美元 只是"
  const snapshot = hit
    ? `文中提到的 ${hit[0].replace(/\s+/g, "")}只是当下快照。`
    : "";
  return "这条属于消息面驱动。" + snapshot
    + "值得跟踪的是后续成交量能否放大、以及这则消息在未来 24–48 小时是否被数据验证；"
    + "单日消息本身很难改写趋势，我不据此推断方向。";
}

function buildTake(m) {
  switch (m.kind) {
    case "market": return marketTake(m);
    case "newCoin": return newCoinTake(m);
    case "trending": return trendingTake(m);
    case "movers": return moversTake(m);
    // 翻译失败回退英文原帖时不加中文解读, 避免再叠加中文
    case "news": return m.lang === "en" ? "" : newsTake(m);
    default: return "";
  }
}

module.exports = { buildTake };
