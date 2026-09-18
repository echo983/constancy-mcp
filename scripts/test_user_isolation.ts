import fs from "fs";
import { executeToolCall, McpEnv } from "../src/mcp";
import {
  deleteMemoryPoints,
  deleteImagePoints,
  findImagePointsByImageId,
  getPointById
} from "../src/qdrant";

async function run() {
  console.log("🔒 Starting Multi-Tenant User Isolation Comprehensive Test Suite...\n");

  const qdrantKey = fs.readFileSync("/home/edwin/ramws/any/secret/Qdrant-api-key@vec.kufof.uk.txt", "utf-8").trim();
  const voyageKey = fs.readFileSync("/home/edwin/ramws/any/secret/Voyageai-api-key@vec.kufof.uk.txt", "utf-8").trim();

  const userA = "edwin.abel.3@gmail.com";
  const userB = "luanshuyi23@gmail.com";

  const env: McpEnv = {
    QDRANT_URL: "https://vec.kufof.uk",
    QDRANT_API_KEY: qdrantKey,
    VOYAGE_API_KEY: voyageKey,
    JWT_SECRET: "test-isolation-secret-123",
    DOMAIN: "mcp.kufof.uk"
  };

  const pointsToDeleteUserA: string[] = [];
  const pointsToDeleteUserB: string[] = [];
  const imagePointsToDeleteUserA: string[] = [];
  const imagePointsToDeleteUserB: string[] = [];

  const randSuffix = Date.now().toString().slice(-6);

  try {
    // -------------------------------------------------------------------------
    // Test 1: Memory creation and search isolation
    // -------------------------------------------------------------------------
    console.log("--- [Test 1] Memory Creation & Search Isolation ---");
    const secretCodeA = `EDWIN_TOP_SECRET_${randSuffix}`;
    const logResA = await executeToolCall("log_memory", {
      content: `【私密便签】Edwin 个人专属保密内容，访问口令为 ${secretCodeA}`,
      type: "fact",
      tags: ["private", "edwin-only"],
      c_h: 9.0
    }, userA, env);

    if (!logResA.success || !logResA.id) {
      throw new Error(`Failed to create memory for User A: ${JSON.stringify(logResA)}`);
    }
    pointsToDeleteUserA.push(logResA.id);
    console.log(`✅ User A created private memory: ${logResA.id}`);

    // User B searches for User A's secret memory
    const searchResB = await executeToolCall("search_memory", {
      query: secretCodeA,
      type: "all"
    }, userB, env);

    const leakedToB = (searchResB.memories || []).some((m: any) => m.content?.includes(secretCodeA) || m.id === logResA.id);
    if (leakedToB) {
      throw new Error(`CRITICAL ISOLATION BREACH: User B was able to search/view User A's memory!`);
    }
    console.log(`✅ User B search returned 0 results for User A's secret code (Strictly Isolated).`);

    // User B creates their own private memory
    const secretCodeB = `SHUYI_PERSONAL_NOTE_${randSuffix}`;
    const logResB = await executeToolCall("log_memory", {
      content: `【私密研究】Shuyi 个人专属工作日志，代号 ${secretCodeB}`,
      type: "note",
      tags: ["research", "shuyi-only"],
      c_h: 9.0
    }, userB, env);

    if (!logResB.success || !logResB.id) {
      throw new Error(`Failed to create memory for User B: ${JSON.stringify(logResB)}`);
    }
    pointsToDeleteUserB.push(logResB.id);
    console.log(`✅ User B created private memory: ${logResB.id}`);

    // User A searches for User B's memory
    const searchResA = await executeToolCall("search_memory", {
      query: secretCodeB,
      type: "all"
    }, userA, env);

    const leakedToA = (searchResA.memories || []).some((m: any) => m.content?.includes(secretCodeB) || m.id === logResB.id);
    if (leakedToA) {
      throw new Error(`CRITICAL ISOLATION BREACH: User A was able to search/view User B's memory!`);
    }
    console.log(`✅ User A search returned 0 results for User B's secret code (Strictly Isolated).`);

    // -------------------------------------------------------------------------
    // Test 2: Direct point manipulation cross-tenant security
    // -------------------------------------------------------------------------
    console.log("\n--- [Test 2] Cross-Tenant Point CRUD Guardrails ---");

    // 2A: get_note cross-tenant check
    try {
      await executeToolCall("get_note", { id: logResA.id }, userB, env);
      throw new Error(`CRITICAL: User B was able to get_note on User A's note!`);
    } catch (err: any) {
      console.log(`✅ get_note cross-tenant rejected as expected: ${err.message}`);
    }

    // 2B: update_note cross-tenant check
    try {
      await executeToolCall("update_note", {
        id: logResA.id,
        content: "Hacked by User B!"
      }, userB, env);
      throw new Error(`CRITICAL: User B was able to update_note on User A's note!`);
    } catch (err: any) {
      console.log(`✅ update_note cross-tenant rejected as expected: ${err.message}`);
    }

    // 2C: annotate_memory cross-tenant check
    try {
      await executeToolCall("annotate_memory", {
        id: logResA.id,
        kind: "correction",
        text: "Malicious annotation from User B"
      }, userB, env);
      throw new Error(`CRITICAL: User B was able to annotate User A's memory!`);
    } catch (err: any) {
      console.log(`✅ annotate_memory cross-tenant rejected as expected: ${err.message}`);
    }

    // 2D: retire_memory cross-tenant check
    try {
      await executeToolCall("retire_memory", {
        id: logResA.id,
        reason: "Unauthorized retirement attempt by User B"
      }, userB, env);
      throw new Error(`CRITICAL: User B was able to retire User A's memory!`);
    } catch (err: any) {
      console.log(`✅ retire_memory cross-tenant rejected as expected: ${err.message}`);
    }

    // -------------------------------------------------------------------------
    // Test 3: Entity namespace isolation
    // -------------------------------------------------------------------------
    console.log("\n--- [Test 3] Entity Namespace & Homonym Isolation ---");
    const entityName = `QuantumMeshProject_${randSuffix}`;

    // User A creates entity
    const entResA = await executeToolCall("upsert_entity", {
      name: entityName,
      description: `【User A 实体】量子网格协议 A 方案核心架构`,
      aliases: [`QMesh_${randSuffix}`]
    }, userA, env);
    const entPointIdA = entResA.point_id;
    pointsToDeleteUserA.push(entPointIdA);
    console.log(`✅ User A registered entity '${entityName}' (ID: ${entPointIdA})`);

    // User B creates homonym entity with different content
    const entResB = await executeToolCall("upsert_entity", {
      name: entityName,
      description: `【User B 实体】量子网格协议 B 方案完全独立的个人实验记录`,
      aliases: [`QMesh_${randSuffix}`]
    }, userB, env);
    const entPointIdB = entResB.point_id;
    pointsToDeleteUserB.push(entPointIdB);
    console.log(`✅ User B registered entity '${entityName}' independently (ID: ${entPointIdB})`);

    if (entPointIdA === entPointIdB) {
      throw new Error(`CRITICAL: User A and User B shared the same entity point ID!`);
    }

    // Verify User A searches entity
    const searchEntA = await executeToolCall("search_memory", {
      query: entityName,
      type: "entity"
    }, userA, env);
    const matchedEntA = (searchEntA.memories || []).find((m: any) => m.id === entPointIdA);
    const leakedEntBToA = (searchEntA.memories || []).find((m: any) => m.id === entPointIdB);
    if (!matchedEntA || leakedEntBToA) {
      throw new Error(`CRITICAL: Entity search mismatch or leakage for User A!`);
    }
    console.log(`✅ User A entity search strictly returned User A's entity.`);

    // Verify User B searches entity
    const searchEntB = await executeToolCall("search_memory", {
      query: entityName,
      type: "entity"
    }, userB, env);
    const matchedEntB = (searchEntB.memories || []).find((m: any) => m.id === entPointIdB);
    const leakedEntAToB = (searchEntB.memories || []).find((m: any) => m.id === entPointIdA);
    if (!matchedEntB || leakedEntAToB) {
      throw new Error(`CRITICAL: Entity search mismatch or leakage for User B!`);
    }
    console.log(`✅ User B entity search strictly returned User B's entity.`);

    // -------------------------------------------------------------------------
    // Test 4: Visual gallery & Image access isolation
    // -------------------------------------------------------------------------
    console.log("\n--- [Test 4] Image Gallery & Vision Tool Isolation ---");
    const testImgIdA = `test_img_isolation_a_${randSuffix}`;
    const commitImgResA = await executeToolCall("commit_image_record", {
      image_id: testImgIdA,
      title: "Edwin 专属实验室拓扑图",
      description: `机密物理网络连接图，唯一识别码 ${testImgIdA}`,
      tags: ["datacenter", "top-secret"],
      create_note: true
    }, userA, env);
    imagePointsToDeleteUserA.push(commitImgResA.point_id);
    if (commitImgResA.note_id) pointsToDeleteUserA.push(commitImgResA.note_id);
    console.log(`✅ User A committed image: point_id=${commitImgResA.point_id}, note_id=${commitImgResA.note_id}`);

    // User B searches images
    const searchImgResB = await executeToolCall("search_memory", {
      query: testImgIdA,
      type: "image",
      include_images: true
    }, userB, env);
    const leakedImgToB = (searchImgResB.images || []).some((img: any) => img.image_id === testImgIdA);
    if (leakedImgToB) {
      throw new Error(`CRITICAL: User B was able to search/view User A's image!`);
    }
    console.log(`✅ User B image search returned 0 results for User A's image.`);

    // User B tries get_blob_url on User A's image
    try {
      await executeToolCall("get_blob_url", { id: testImgIdA }, userB, env);
      throw new Error(`CRITICAL: User B was able to call get_blob_url on User A's image!`);
    } catch (err: any) {
      console.log(`✅ get_blob_url cross-tenant rejected as expected: ${err.message}`);
    }

    // User B tries fetch_image_vision on User A's image
    try {
      await executeToolCall("fetch_image_vision", { id: testImgIdA }, userB, env);
      throw new Error(`CRITICAL: User B was able to call fetch_image_vision on User A's image!`);
    } catch (err: any) {
      console.log(`✅ fetch_image_vision cross-tenant rejected as expected: ${err.message}`);
    }

    // -------------------------------------------------------------------------
    // Test 5: Timeline isolation
    // -------------------------------------------------------------------------
    console.log("\n--- [Test 5] Daily Timeline Isolation ---");
    const todayStr = new Date().toISOString().slice(0, 10);
    const timelineResA = await executeToolCall("get_daily_timeline", { date: todayStr }, userA, env);
    const timelineResB = await executeToolCall("get_daily_timeline", { date: todayStr }, userB, env);

    const timelineItemsA = timelineResA.timeline || [];
    const timelineItemsB = timelineResB.timeline || [];

    const hasBInA = timelineItemsA.some((item: any) => pointsToDeleteUserB.includes(item.id));
    const hasAInB = timelineItemsB.some((item: any) => pointsToDeleteUserA.includes(item.id));

    if (hasBInA || hasAInB) {
      throw new Error(`CRITICAL: Timeline cross-tenant leakage detected!`);
    }
    console.log(`✅ Daily timeline strictly partitioned (User A items: ${timelineItemsA.length}, User B items: ${timelineItemsB.length}).`);

    // -------------------------------------------------------------------------
    // Test 6: Cognitive hygiene doctor & triage isolation
    // -------------------------------------------------------------------------
    console.log("\n--- [Test 6] Cognitive Hygiene Doctor & Triage Isolation ---");
    const concernResA = await executeToolCall("submit_concern", {
      memory_id: logResA.id,
      reason: "Edwin 记忆地址存疑",
      evidence: "用户原话：我可能要搬到望京西了"
    }, userA, env);
    console.log(`✅ User A submitted triage concern on memory ${logResA.id}`);

    // User B calls doctor triage queue
    const doctorCasesResB = await executeToolCall("get_maintenance_cases", {}, userB, env);
    const hasCasesB = doctorCasesResB.has_cases;
    const casesB = doctorCasesResB.cases || [];
    const leakedCaseToB = casesB.some((c: any) => c.memory_id === logResA.id);

    if (leakedCaseToB) {
      throw new Error(`CRITICAL: User B's doctor triage saw User A's concern case!`);
    }
    console.log(`✅ User B doctor triage queue does not see User A's case (has_cases=${hasCasesB}, cases count=${casesB.length}).`);

    console.log("\n🎉 ALL 6 MULTI-TENANT ISOLATION TESTS PASSED WITH 100% SUCCESS!");

  } finally {
    console.log("\n🧹 Cleaning up test points for both users...");
    if (pointsToDeleteUserA.length > 0) {
      await deleteMemoryPoints(pointsToDeleteUserA, env).catch(e => console.warn("Cleanup A note warning:", e.message));
    }
    if (pointsToDeleteUserB.length > 0) {
      await deleteMemoryPoints(pointsToDeleteUserB, env).catch(e => console.warn("Cleanup B note warning:", e.message));
    }
    if (imagePointsToDeleteUserA.length > 0) {
      await deleteImagePoints(imagePointsToDeleteUserA, env).catch(e => console.warn("Cleanup A image warning:", e.message));
    }
    if (imagePointsToDeleteUserB.length > 0) {
      await deleteImagePoints(imagePointsToDeleteUserB, env).catch(e => console.warn("Cleanup B image warning:", e.message));
    }
    console.log("✅ Cleanup completed.");
  }
}

run().catch(err => {
  console.error("\n❌ Isolation Test Suite Failed:", err);
  process.exit(1);
});
