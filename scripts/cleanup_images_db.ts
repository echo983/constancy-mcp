import fs from "fs";
import { getEmbedding } from "../src/voyage";
import { QdrantEnv } from "../src/qdrant";

async function run() {
  console.log("🧹 Running Images Collection Cleanup Script...\n");

  const qdrantKey = fs.readFileSync("/home/edwin/ramws/any/secret/Qdrant-api-key@vec.kufof.uk.txt", "utf-8").trim();
  const voyageKey = fs.readFileSync("/home/edwin/ramws/any/secret/Voyageai-api-key@vec.kufof.uk.txt", "utf-8").trim();

  const env: QdrantEnv & { VOYAGE_API_KEY: string } = {
    QDRANT_URL: "https://vec.kufof.uk",
    QDRANT_API_KEY: qdrantKey,
    VOYAGE_API_KEY: voyageKey
  };

  const headers = {
    "api-key": qdrantKey,
    "Content-Type": "application/json",
    "User-Agent": "curl/8.14.1 (constancy-cleanup)"
  };

  // 1. Delete stale duplicate points:
  // - 46fe2235-a422-4601-87a8-78092bb1bae4 (stale d0aac33f with "雄性")
  // - 4f6e9a2f-a27e-461c-9cd9-532bc8f3c5ee (stale duplicate of 3fe56470)
  const pointsToDelete = [
    "46fe2235-a422-4601-87a8-78092bb1bae4",
    "4f6e9a2f-a27e-461c-9cd9-532bc8f3c5ee"
  ];
  console.log("Deleting stale duplicate points:", pointsToDelete);

  const delRes = await fetch("https://vec.kufof.uk/collections/images/points/delete?wait=true", {
    method: "POST",
    headers,
    body: JSON.stringify({ points: pointsToDelete })
  });
  console.log(`Delete response: ${delRes.status} ${await delRes.text()}`);

  // 2. Clean up and restore c4729c46-8421-4ed6-865c-72bd22892048:
  const cleanDescription = `家中室内近距离拍摄的斯芬克斯母猫 Biubiu（用户 Edwin 的猫，集体记录：雌性，2019-08-08 生）。她卷身蜷在一只深灰色长毛绒圆形猫窝里，身体朝左侧、头向右上回头直视镜头，臀部抬高、前肢收在身下。

【体表与形貌】皮肤底色为暖粉肉色，头顶、颈侧、肩背与侧腹有连片灰紫/蓝灰色色素斑块；腹部偏亮、小腹圆润。颈部至肩部横向皮肤褶皱清晰，耳大而直立、耳廓内侧半透明暖橙褐色。眼睛浅黄绿色、瞳孔圆，口鼻粉肉色偏淡。这些形貌特征与实体记录及此前俯拍背影照片一致。

【环境】猫窝毛绒长而乱、灰蓝色；背景是淡木色水平板材/柜体底部与淡蓝灰墙面，左下角露出一角斑点地面。室内散射光，无明显窗外景。

【拍摄】文件名时间戳 2026-09-12 18:49:32（当地 CEST）。本地文件无可读 EXIF（对话相机上传常被剥离元数据），因此未写入 GPS 与相机参数；画面为家中室内猫窝。`;

  const fullTags = ["biubiu", "cat", "sphynx", "pet", "home", "indoor", "cat-bed", "portrait", "image"];
  const title = "Biubiu 卷在深灰毛绒窝里回头看镜头";

  console.log("Computing new Voyage Multimodal embedding for cleaned c4729c46...");
  const textToEmbed = `${title}\n${cleanDescription}\n${fullTags.join(" ")}`;
  const vector = await getEmbedding(textToEmbed, env, "document");

  const updatePayload = {
    user_id: "edwin.abel.3@gmail.com",
    image_id: "d0aac33f-a9fe-4049-7af8-acd939758a01",
    filename: "chat_camera_upload_20260912_184932_2578701916762147087.jpg",
    title,
    description: cleanDescription,
    tags: fullTags,
    exif: null,
    location: null,
    captured_at: "2026-09-12T16:49:32.000Z",
    created_at: "2026-09-12T16:51:39.931Z",
    updated_at: new Date().toISOString(),
    source: "claude"
  };

  const putRes = await fetch("https://vec.kufof.uk/collections/images/points?wait=true", {
    method: "PUT",
    headers,
    body: JSON.stringify({
      points: [
        {
          id: "c4729c46-8421-4ed6-865c-72bd22892048",
          vector,
          payload: updatePayload
        }
      ]
    })
  });
  console.log(`Update response: ${putRes.status} ${await putRes.text()}`);

  console.log("\n✅ Database cleanup executed successfully!");
}

run().catch(err => {
  console.error("Cleanup failed:", err);
  process.exit(1);
});
