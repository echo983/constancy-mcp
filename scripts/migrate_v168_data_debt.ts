import fs from "fs";
import { setPointPayload, getPointById, QdrantEnv } from "../src/qdrant";

async function main() {
  console.log("🛠️ Starting v1.6.8 Historical Data Debt Migration...");

  const qdrantKey = fs.readFileSync("/home/edwin/ramws/any/secret/Qdrant-api-key@vec.kufof.uk.txt", "utf-8").trim();
  const env: QdrantEnv = {
    QDRANT_URL: "https://vec.kufof.uk",
    QDRANT_API_KEY: qdrantKey
  };

  // 1. Repair b67f5c30 (Shuyi Luan active entity generation)
  const b67Id = "b67f5c30-3bae-4f30-b38e-1c8a73d4616a";
  const b67Point = await getPointById(b67Id, env);
  if (b67Point && b67Point.payload) {
    console.log("Found b67f5c30, patching entity_name, aliases, source, and inherited spectrum...");
    const inheritedSpectrum = [
      1,
      0.6065306597126334,
      0.36787944117144233,
      0.22313882667763804,
      0.618126676248655,
      1.4824623679543965,
      1.580781319328923
    ];
    await setPointPayload(b67Id, {
      entity_name: "Shuyi Luan（用户妻子）",
      aliases: ["Shuyi", "妻子", "老婆"],
      relations: ["Edwin"],
      source: "user_stated",
      h_spectrum: inheritedSpectrum,
      t_last_update: 1790267677515, // 2026-09-24T16:34:37.515Z
      t_last_strong: 1790267677515
    }, env);
    console.log("✅ Successfully repaired b67f5c30!");
  } else {
    console.warn("b67f5c30 not found");
  }

  // 2. Repair a2ade8ed (Predecessor retirement clock reset bug fix)
  const a2Id = "a2ade8ed-1847-4976-926e-6a6afe438702";
  const a2Point = await getPointById(a2Id, env);
  if (a2Point && a2Point.payload) {
    console.log("Found a2ade8ed, restoring t_last_update to original creation time 2026-09-12...");
    await setPointPayload(a2Id, {
      t_last_update: 1789211608760 // 2026-09-12T11:13:28.760Z
    }, env);
    console.log("✅ Successfully repaired a2ade8ed decay clock!");
  } else {
    console.warn("a2ade8ed not found");
  }

  // 3. Repair 1ef5a631 (Image note chronological inversion fix)
  const imgNoteId = "1ef5a631-9c57-41d9-81b6-29ae604d66b7";
  const imgPoint = await getPointById(imgNoteId, env);
  if (imgPoint && imgPoint.payload) {
    console.log("Found 1ef5a631, fixing created_at and timestamp to precede annotations (21:55:00Z)...");
    await setPointPayload(imgNoteId, {
      created_at: "2026-09-11T21:55:00.000Z",
      timestamp: "2026-09-11T21:55:00.000Z",
      captured_at: "2026-09-11T23:14:11.000Z"
    }, env);
    console.log("✅ Successfully repaired 1ef5a631 timestamps!");
  } else {
    console.warn("1ef5a631 not found");
  }

  console.log("\n🎉 All historical data debts repaired successfully!");
}

main().catch(console.error);
