/**
 * 帖子解读段: 只从素材已有字段 / 文本推导(资讯帖按标题+摘要分场景), 不编造数据、不给买卖建议。
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

// 资讯解读段按主题分场景: 对服务故障 / 监管人事说"成交量能否放大"是明显套话。
// 也不再抓摘要里的孤立数字当"当下快照"——"if ETH slides to around $1,700" 是假设触发价,
// 机械套数字会把条件读成现状。只根据素材文本分类, 不编造任何数据。
const NEWS_TOPICS = [
  {
    name: "incident", // 安全 / 故障 / 执法
    re: /(hack|exploit|theft|stolen|breach|outage|vulnerab|malware|deepfake|patch|seiz|freeze|黑客|被盗|窃取|漏洞|中断|故障|补丁|查获|冻结)/i,
    takes: [
      "这类事件的影响面取决于波及范围和处置进度，后续披露的细节往往比首报更重要。我会关注修复或调查进展，不把它当成价格信号。",
      "安全与服务类事件，先确认影响范围、以及是否仍在持续，比讨论市场反应更有意义。我会等官方口径和后续通报，不据此推断方向。",
    ],
  },
  {
    name: "policy", // 监管 / 政策 / 人事
    re: /(\bsec\b|\bcftc\b|regulat|nominat|nominee|\bbill\b|lawsuit|\bcourt\b|\bdoj\b|policy|监管|提名|法案|诉讼|法院|司法部|白宫|政策|国会)/i,
    takes: [
      "监管与人事变化的影响通常不在公布当天，而在后续的执行细则和落地节奏。我会盯配套文件与时间表，不把表态直接换算成行情。",
      "这类变化的关键变量是落地：有没有明确规则、适用范围和生效时间。细节出来前，影响范围很难估，我也不据此推断方向。",
    ],
  },
  {
    name: "company", // 机构 / 公司 / 借贷 / 持仓
    re: /(treasury|\bfirm\b|company|borrow|loan|debt|collateral|liquidat|stake|shares|13f|nasdaq|merger|acquisit|财务公司|借贷|贷款|抵押|清算|持仓|股份|并购|收购|上市)/i,
    takes: [
      "公司层面的动作，重点在资产负债表：持仓、借款和触发条件比标题里的金额更值得核对。我会看后续披露有没有改动这些条件。",
      "这类借贷与持仓结构，风险往往集中在抵押品和触发线上。我会关注后续公告是否调整了相关条款，而不是只看当天的价格反应。",
    ],
  },
  {
    name: "market", // 行情 / 价格 / 资金流: 只有这一类才谈成交量
    re: /(bitcoin|\bbtc\b|ether|\beth\b|price|\betf\b|outflow|inflow|rally|slide|fell|surge|volume|trading|价格|涨跌|跌破|涨破|成交|资金流)/i,
    takes: [
      "价格和资金面的单日变化，我会先看它是不是连续：连续几天的方向比某一天的涨跌幅更能说明问题。短窗口不足以确认趋势，我不据此推断方向。",
      "这类波动更像一次脉冲还是一段趋势，要看后续资金与成交能不能延续。只有单日数据时不急于下结论，我也不据此给方向。",
      "把一条价格变化放进更长的时间窗看，才知道是噪音还是结构变化。我会继续看后续几天的资金流与成交量，当下不下判断。",
    ],
  },
];
const NEWS_FALLBACK_TAKES = [
  "目前能确认的只有报道里给出的这些事实，还不足以判断影响范围。我会等后续数据或官方口径佐证，在此之前不做方向判断。",
  "这类资讯缺少可核对的后续指标，我会先看有没有独立数据或第二方确认，而不是急着给结论。",
];
// 用标题做稳定 hash 选变体: 同一条新闻始终同一句(可复现), 不同新闻尽量不重复, 保持纯函数
function pickTake(list, seed) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return list[h % list.length];
}
function newsTake(m) {
  const text = `${m.title ?? ""} ${m.summary ?? ""}`;
  const topic = NEWS_TOPICS.find((t) => t.re.test(text));
  return pickTake(topic ? topic.takes : NEWS_FALLBACK_TAKES, `${m.title ?? ""}`);
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
