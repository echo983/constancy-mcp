import fs from "fs";
import { executeToolCall, McpEnv } from "../src/mcp";
import {
  findImagePointsByImageId,
  deleteImagePoints,
  deleteMemoryPoints,
  findNoteByImageId
} from "../src/qdrant";

async function run() {
  console.log("🚀 Starting Image Gallery Governance & Upsert Test Suite...\n");

  const qdrantKey = fs.readFileSync("/home/edwin/ramws/any/secret/Qdrant-api-key@vec.kufof.uk.txt", "utf-8").trim();
  const voyageKey = fs.readFileSync("/home/edwin/ramws/any/secret/Voyageai-api-key@vec.kufof.uk.txt", "utf-8").trim();

  const testUserId = `test_gov_${Date.now()}`;
  const env: McpEnv = {
    QDRANT_URL: "https://vec.kufof.uk",
    QDRANT_API_KEY: qdrantKey,
    VOYAGE_API_KEY: voyageKey,
    JWT_SECRET: "test-secret-key-123",
    DOMAIN: "mcp.kufof.uk"
  };

  const testImageId = `test_cf_img_${Date.now()}`;
  const pointsToDelete: string[] = [];
  const imagePointsToDelete: string[] = [];

  try {
    // -------------------------------------------------------------
    // Test 1: FIX-1 First insert via commit_image_record
    // -------------------------------------------------------------
    console.log("--- [Test 1] First insert via commit_image_record ---");
    const insertRes = await executeToolCall("commit_image_record", {
      image_id: testImageId,
      title: "测试测试设备机柜",
      description: "数据中心机房测试机架第一版描述（初始版）",
      tags: ["datacenter", "rack", "server"],
      create_note: true
    }, testUserId, env);

    if (!insertRes.success || insertRes.is_update) {
      throw new Error(`Expected first call to be a new insert, got: ${JSON.stringify(insertRes)}`);
    }
    const firstPointId = insertRes.point_id;
    const firstNoteId = insertRes.note_id;
    imagePointsToDelete.push(firstPointId);
    if (firstNoteId) pointsToDelete.push(firstNoteId);
    console.log(`✅ First insert successful: point_id=${firstPointId}, note_id=${firstNoteId}`);

    // Verify exactly 1 point in images collection
    const pointsAfterInsert = await findImagePointsByImageId(testImageId, testUserId, env);
    if (pointsAfterInsert.length !== 1) {
      throw new Error(`Expected exactly 1 image point, found ${pointsAfterInsert.length}`);
    }
    console.log("✅ Verified exactly 1 point in Qdrant images collection");

    // -------------------------------------------------------------
    // Test 2: FIX-1 True Upsert on same image_id (原地 Update)
    // -------------------------------------------------------------
    console.log("\n--- [Test 2] True Upsert on same image_id (原地 Update) ---");
    const updateRes = await executeToolCall("commit_image_record", {
      image_id: testImageId,
      title: "测试测试设备机柜 (更名版)",
      description: "数据中心机房测试机架第二版描述（修正版：已更正主交换机型号）",
      tags: ["datacenter", "network", "cisco"],
      create_note: true
    }, testUserId, env);

    if (!updateRes.success || !updateRes.is_update) {
      throw new Error(`Expected second call to be an update, got: ${JSON.stringify(updateRes)}`);
    }
    if (updateRes.point_id !== firstPointId) {
      throw new Error(`Expected point_id to be preserved in place (${firstPointId}), got: ${updateRes.point_id}`);
    }
    console.log(`✅ In-place update successful: point_id preserved (${updateRes.point_id}), is_update=true`);

    // Verify still strictly 1 point in images collection (zero duplicate!)
    const pointsAfterUpdate = await findImagePointsByImageId(testImageId, testUserId, env);
    if (pointsAfterUpdate.length !== 1) {
      throw new Error(`CRITICAL: Found ${pointsAfterUpdate.length} duplicate points after update! Expected 1.`);
    }
    if (!pointsAfterUpdate[0].payload.description.includes("第二版描述")) {
      throw new Error(`Description did not update: ${pointsAfterUpdate[0].payload.description}`);
    }
    console.log("✅ Verified strictly 1 point in Qdrant images collection with updated description!");

    // -------------------------------------------------------------
    // Test 3: FIX-2 Resilient Tags parsing & Inheritance
    // -------------------------------------------------------------
    console.log("\n--- [Test 3] Resilient tags parsing & inheritance ---");
    // 3A: Update with comma-separated string tags
    const stringTagsRes = await executeToolCall("commit_image_record", {
      image_id: testImageId,
      description: "第三版描述：测试字符串标签",
      tags: "firewall, juniper, security",
      create_note: true
    }, testUserId, env);
    if (!stringTagsRes.tags.includes("firewall") || !stringTagsRes.tags.includes("juniper")) {
      throw new Error(`Failed to parse string tags: ${JSON.stringify(stringTagsRes.tags)}`);
    }
    console.log("✅ Comma-separated tags parsed correctly:", stringTagsRes.tags);

    // 3B: Update without passing tags -> should inherit previous tags!
    const inheritTagsRes = await executeToolCall("commit_image_record", {
      image_id: testImageId,
      description: "第四版描述：测试未传标签时的继承",
      create_note: true
    }, testUserId, env);
    if (!inheritTagsRes.tags.includes("firewall") || !inheritTagsRes.tags.includes("juniper")) {
      throw new Error(`Failed to inherit tags on update: ${JSON.stringify(inheritTagsRes.tags)}`);
    }
    console.log("✅ Tags inherited correctly when not provided:", inheritTagsRes.tags);

    // -------------------------------------------------------------
    // Test 4: FIX-3 Polymorphic annotate_memory with image_id
    // -------------------------------------------------------------
    console.log("\n--- [Test 4] Polymorphic annotate_memory with image_id ---");
    const annotateRes = await executeToolCall("annotate_memory", {
      id: testImageId, // passing image_id directly!
      kind: "correction",
      text: "更正：该机柜实际部署于望京B机房而非主数据中心",
      source: "user_stated"
    }, testUserId, env);

    if (!annotateRes.success || !annotateRes.annotation_id) {
      throw new Error(`Failed to annotate via image_id: ${JSON.stringify(annotateRes)}`);
    }
    console.log("✅ annotate_memory via image_id succeeded:", annotateRes.message);

    // -------------------------------------------------------------
    // Test 5: FIX-3 search_memory(type='image') reflects note description & annotations (方案 B)
    // -------------------------------------------------------------
    console.log("\n--- [Test 5] search_memory(type='image') 方案 B live note linkage ---");
    const searchRes = await executeToolCall("search_memory", {
      query: "数据中心机房测试机架",
      type: "image",
      include_images: true
    }, testUserId, env);

    const images = searchRes.images || [];
    const matchedImg = images.find((img: any) => img.image_id === testImageId);
    if (!matchedImg) {
      throw new Error(`Failed to find image ${testImageId} in search_memory results`);
    }

    if (!matchedImg.has_annotations || !matchedImg.annotations || matchedImg.annotations.length === 0) {
      throw new Error(`Expected annotations on image search result, got: ${JSON.stringify(matchedImg)}`);
    }
    if (matchedImg.status_badge !== "🟡 存疑更正") {
      throw new Error(`Expected status_badge '🟡 存疑更正', got: ${matchedImg.status_badge}`);
    }
    console.log("✅ search_memory(type='image') successfully returned authoritative note annotations and status_badge:");
    console.log(`   - Status badge: ${matchedImg.status_badge}`);
    console.log(`   - Annotation text: ${matchedImg.annotations[0].text}`);

    // Verify zero duplicates in search_memory
    const allMatches = images.filter((img: any) => img.image_id === testImageId);
    if (allMatches.length !== 1) {
      throw new Error(`CRITICAL: search_memory returned ${allMatches.length} duplicates for ${testImageId}! Expected 1.`);
    }
    console.log("✅ Verified search_memory returns strictly 1 deduplicated record per image_id!");

    // -------------------------------------------------------------
    // Test 6: FIX-3 Polymorphic submit_concern with image_id
    // -------------------------------------------------------------
    console.log("\n--- [Test 6] Polymorphic submit_concern with image_id ---");
    const concernRes = await executeToolCall("submit_concern", {
      memory_id: testImageId, // passing image_id directly
      reason: "机房物理地址有变动",
      evidence: "用户原话：这台机柜已经整体搬迁至亦庄了"
    }, testUserId, env);

    if (!concernRes.success || !concernRes.concern_id) {
      throw new Error(`Failed to submit concern via image_id: ${JSON.stringify(concernRes)}`);
    }
    console.log("✅ submit_concern via image_id succeeded:", concernRes.message);

    // -------------------------------------------------------------
    // Test 7: FIX-3 Polymorphic retire_memory with image_id
    // -------------------------------------------------------------
    console.log("\n--- [Test 7] Polymorphic retire_memory with image_id ---");
    const retireRes = await executeToolCall("retire_memory", {
      id: testImageId,
      reason: "机房设备已整体报废下线"
    }, testUserId, env);

    if (!retireRes.success) {
      throw new Error(`Failed to retire via image_id: ${JSON.stringify(retireRes)}`);
    }
    console.log("✅ retire_memory via image_id succeeded:", retireRes.message);

    // Verify search_memory without include_retired filters it out
    const searchAfterRetire = await executeToolCall("search_memory", {
      query: "数据中心机房测试机架",
      type: "image",
      include_retired: false
    }, testUserId, env);
    const retiredFound = (searchAfterRetire.images || []).some((img: any) => img.image_id === testImageId);
    if (retiredFound) {
      throw new Error("Retired image was still returned in search_memory with include_retired: false!");
    }
    console.log("✅ Verified retired image is filtered out when include_retired: false");

    console.log("\n🎉 ALL IMAGE GOVERNANCE TESTS PASSED WITH 100% SUCCESS!");
  } finally {
    console.log("\n🧹 Cleaning up test artifacts...");
    if (imagePointsToDelete.length > 0) {
      await deleteImagePoints(imagePointsToDelete, env).catch(err => console.warn("Image cleanup warning:", err.message));
    }
    if (pointsToDelete.length > 0) {
      await deleteMemoryPoints(pointsToDelete, env).catch(err => console.warn("Note cleanup warning:", err.message));
    }
    console.log("✅ Cleanup completed.");
  }
}

run().catch(err => {
  console.error("\n❌ Test Suite Failed with Error:", err);
  process.exit(1);
});
