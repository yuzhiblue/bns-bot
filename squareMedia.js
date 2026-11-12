// 币安广场图片上传: presignedUrl -> PUT S3 -> imageStatus 轮询拿到 imageUrl
// 接口参数来自官方 binance-skills-hub 的 square-post/scripts/lib.mjs
// （V2 上传接口 + V1 content/add 发布）。全程走币安自己的接口, 不需要图床或第三方服务。
const BAPI_V2 = "https://www.binance.com/bapi/composite/v2/public/pgc/openApi";

async function api(url, apiKey, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "X-Square-OpenAPI-Key": apiKey,
      "Content-Type": "application/json",
      "clienttype": "binanceSkill",
    },
    body: JSON.stringify(body),
  });
  // 官方脚本对 /content/add 的 504 按「成功但无帖子 ID」处理, 不重试。
  // 这里把同一容错保留给上传/发布链路共用。
  if (res.status === 504) return { id: null, publishStatus: "success_without_post_id" };
  const json = await res.json();
  if (json && json.code && json.code !== "000000" && json.code !== 0) {
    throw new Error(`square api ${json.code}: ${json.message}`);
  }
  return json;
}

// buffer: PNG/JPEG 二进制; ext: "png" | "jpg"
// 返回可直接塞进 content/add 的 imageUrl
async function uploadImage(apiKey, buffer, ext = "png") {
  const contentType = ext === "png" ? "image/png" : "image/jpeg";

  // 1. 拿预签名地址和 fileTicket
  const pre = await api(`${BAPI_V2}/image/presignedUrl`, apiKey, { imageName: `card.${ext}` });
  const preData = pre && pre.data ? pre.data : pre;
  const presignedUrl = preData.presignedUrl;
  const fileTicket = preData.fileTicket;
  if (!presignedUrl || !fileTicket) throw new Error("presignedUrl 返回缺少字段");

  // 2. 直接 PUT 二进制到返回的 S3 地址(不要带币安 header)
  const put = await fetch(presignedUrl, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body: buffer,
  });
  if (!put.ok) throw new Error(`S3 PUT 失败 HTTP ${put.status}`);

  // 3. 轮询处理状态, 最多 10 次 / 3 秒间隔 (官方脚本 MAX_POLL_RETRIES=10, POLL_INTERVAL=3s)
  for (let i = 0; i < 10; i++) {
    const st = await api(`${BAPI_V2}/image/imageStatus`, apiKey, { fileTicket });
    const d = st && st.data ? st.data : st;
    if (d.status === 1) return d.imageUrl;
    if (d.status === 2) throw new Error(`图片处理失败: ${d.failedReason ?? ""}`);
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error("图片状态轮询超时");
}

module.exports = { uploadImage };
