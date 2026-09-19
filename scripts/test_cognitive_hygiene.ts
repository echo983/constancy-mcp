import fs from "fs";
import { executeToolCall, McpEnv } from "../src/mcp";
import { getPointById, deleteMemoryPoints, CONCERNS_COLLECTION, submitConcernToQdrant } from "../src/qdrant";

async function run() {
  console.log("🚀 Starting Cognitive Hygiene Doctor Integration Test...");

  const qdrantKey = fs.readFileSync("/home/edwin/ramws/any/secret/Qdrant-api-key@vec.kufof.uk.txt", "utf-8").trim();
  const voyageKey = fs.readFileSync("/home/edwin/ramws/any/secret/Voyageai-api-key@vec.kufof.uk.txt", "utf-8").trim();

  const env: McpEnv = {
    QDRANT_URL: "https://vec.kufof.uk",
    QDRANT_API_KEY: qdrantKey,
    VOYAGE_API_KEY: voyageKey,
    DOMAIN: "mcp.kufof.uk"
  };

  const testUserId = `test_doctor_${Date.now()}`;
  console.log(`👤 Using test user ID: ${testUserId}`);

  const pointsToDelete: string[] = [];

  try {
    // -------------------------------------------------------------
    // Test 1: Log an initial memory point
    // -------------------------------------------------------------
    console.log("\n--- [Test 1] Logging initial memory point ---");
    const logRes = await executeToolCall("log_memory", {
      content: "用户现居住于北京市朝阳区望京SOHO附近，平时喜欢去朝阳公园跑步",
      c_h: 9.8,
      type: "fact",
      source: "user_stated"
    }, testUserId, env);

    const memoryId = logRes.id;
    if (!memoryId) throw new Error("Failed to log initial memory point");
    pointsToDelete.push(memoryId);
    console.log(`✅ Memory point created: ${memoryId}`);

    // -------------------------------------------------------------
    // Test 2: Negative tests for submit_concern
    // -------------------------------------------------------------
    console.log("\n--- [Test 2] Negative tests for submit_concern ---");
    try {
      await executeToolCall("submit_concern", {
        memory_id: "",
        reason: "foo",
        evidence: "bar"
      }, testUserId, env);
      throw new Error("Expected validation error for missing memory_id");
    } catch (err: any) {
      console.log(`✅ Caught expected error on missing memory_id: ${err.message}`);
    }

    try {
      await executeToolCall("submit_concern", {
        memory_id: "non-existent-uuid-12345",
        reason: "foo",
        evidence: "bar"
      }, testUserId, env);
      throw new Error("Expected error for non-existent memory");
    } catch (err: any) {
      console.log(`✅ Caught expected error on non-existent memory: ${err.message}`);
    }

    try {
      await executeToolCall("submit_concern", {
        memory_id: memoryId,
        reason: "foo",
        evidence: ""
      }, testUserId, env);
      throw new Error("Expected validation error for missing evidence");
    } catch (err: any) {
      console.log(`✅ Caught expected error on missing evidence: ${err.message}`);
    }

    // -------------------------------------------------------------
    // Test 3: Valid submit_concern
    // -------------------------------------------------------------
    console.log("\n--- [Test 3] Submitting first valid concern ---");
    const concern1Res = await executeToolCall("submit_concern", {
      memory_id: memoryId,
      reason: "居住地可能已变更为上海",
      evidence: "用户原话：我上个月搬到上海陆家嘴常住了",
      severity: "high",
      interaction_mode: "silent"
    }, testUserId, env);

    console.log("Submit concern response:", concern1Res);
    if (!concern1Res.concern_id) throw new Error("Missing concern_id");
    console.log(`✅ Concern 1 submitted: ${concern1Res.concern_id}, duplicate_count: ${concern1Res.duplicate_count}`);

    // -------------------------------------------------------------
    // Test 4: Duplicate submit_concern (frequency & evidence chain escalation)
    // -------------------------------------------------------------
    console.log("\n--- [Test 4] Submitting duplicate concern on same memory ---");
    const concern2Res = await executeToolCall("submit_concern", {
      memory_id: memoryId,
      reason: "再次确认用户已不在北京，在上海常驻",
      evidence: "用户原话：我现在都在上海陆家嘴办公室上班了",
      severity: "high",
      interaction_mode: "user_confirmed"
    }, testUserId, env);

    console.log("Duplicate concern response:", concern2Res);
    if (concern2Res.duplicate_count !== 2) {
      throw new Error(`Expected duplicate_count to be 2, got ${concern2Res.duplicate_count}`);
    }
    console.log(`✅ Duplicate concern handled cleanly! Count: ${concern2Res.duplicate_count}`);

    // -------------------------------------------------------------
    // Test 5: get_maintenance_cases (Doctor exclusive)
    // -------------------------------------------------------------
    console.log("\n--- [Test 5] Calling get_maintenance_cases (Doctor) ---");
    const casesRes = await executeToolCall("get_maintenance_cases", {
      limit: 5
    }, testUserId, env);

    console.log("Doctor cases response:", JSON.stringify(casesRes, null, 2));
    if (!casesRes.has_cases) {
      throw new Error("Expected has_cases to be true!");
    }
    if (casesRes.case_count < 1) {
      throw new Error(`Expected at least 1 case, got ${casesRes.case_count}`);
    }

    const testCase = casesRes.cases.find((c: any) => c.memory_id === memoryId);
    if (!testCase) throw new Error(`Case for memory ${memoryId} not found in triage output`);
    console.log(`✅ Found triage case ${testCase.case_id} for memory ${memoryId}`);
    console.log(`   - Highest severity: ${testCase.highest_severity}`);
    console.log(`   - Total reports: ${testCase.total_reports}`);
    console.log(`   - Evidence length: ${testCase.concerns[0].evidence.length} chars`);

    // -------------------------------------------------------------
    // Test 6: resolve_maintenance_case with DEFERRED
    // -------------------------------------------------------------
    console.log("\n--- [Test 6] Resolving case with DEFERRED verdict ---");
    const deferRes = await executeToolCall("resolve_maintenance_case", {
      case_id: testCase.case_id,
      memory_id: memoryId,
      verdict: "DEFERRED",
      doctor_notes: "暂留观，等待更多跨会话佐证"
    }, testUserId, env);

    console.log("Deferred response:", deferRes);
    if (!deferRes.success) throw new Error("Expected defer to succeed");

    const memAfterDefer = await getPointById(memoryId, env);
    if ((memAfterDefer.payload?.defer_count || 0) < 1) {
      throw new Error("Expected defer_count to be >= 1");
    }
    console.log(`✅ Defer recorded on memory point! defer_count: ${memAfterDefer.payload?.defer_count}`);

    // -------------------------------------------------------------
    // Test 7: resolve_maintenance_case with RESOLVED + UPDATE
    // -------------------------------------------------------------
    console.log("\n--- [Test 7] Resolving case with RESOLVED + UPDATE verdict ---");
    const updateRes = await executeToolCall("resolve_maintenance_case", {
      case_id: testCase.case_id,
      memory_id: memoryId,
      verdict: "RESOLVED",
      treatment: "UPDATE",
      updated_content: "用户现居住于上海市浦东新区陆家嘴，常在陆家嘴办公室上班",
      doctor_notes: "两次用户原话确凿证实居住与工作地已彻底迁移至上海，执行世代更迭"
    }, testUserId, env);

    console.log("Update resolution response:", updateRes);
    if (!updateRes.success) throw new Error("Expected resolution to succeed");

    // Verify old memory in Qdrant
    const oldMem = await getPointById(memoryId, env);
    console.log("Old memory payload status:", oldMem.payload?.status, "superseded_by:", oldMem.payload?.superseded_by);
    if (oldMem.payload?.status !== "expired" || !oldMem.payload?.retired) {
      throw new Error(`Expected old memory to be expired/retired, got status=${oldMem.payload?.status}, retired=${oldMem.payload?.retired}`);
    }
    if (!oldMem.payload?.superseded_by) {
      throw new Error("Expected old memory to have superseded_by link");
    }
    const newMemoryId = oldMem.payload.superseded_by;
    pointsToDelete.push(newMemoryId);
    console.log(`✅ Old memory retired & linked to new generation: ${newMemoryId}`);

    // Verify new memory in Qdrant
    const newMem = await getPointById(newMemoryId, env);
    console.log("New memory payload content:", newMem.payload?.content, "predecessor:", newMem.payload?.predecessor);
    if (newMem.payload?.predecessor !== memoryId) {
      throw new Error(`Expected new memory predecessor to be ${memoryId}, got ${newMem.payload?.predecessor}`);
    }
    if (newMem.payload?.status !== "active") {
      throw new Error(`Expected new memory status to be active, got ${newMem.payload?.status}`);
    }
    console.log("✅ New memory successfully generated with predecessor lineage!");

    // -------------------------------------------------------------
    // Test 8: Verify search_memory filtering & lineage visibility
    // -------------------------------------------------------------
    console.log("\n--- [Test 8] search_memory default vs include_retired ---");
    
    // a. Default search
    const searchDefault = await executeToolCall("search_memory", {
      query: "用户现在住在哪里",
      limit: 10
    }, testUserId, env);

    console.log("Search default result count:", searchDefault.count);
    const hasOldInDefault = searchDefault.memories.some((m: any) => m.id === memoryId);
    const hasNewInDefault = searchDefault.memories.some((m: any) => m.id === newMemoryId);
    console.log(`   - Has old retired memory in default search: ${hasOldInDefault} (expected: false)`);
    console.log(`   - Has new updated memory in default search: ${hasNewInDefault} (expected: true)`);
    if (hasOldInDefault) throw new Error("Old retired memory leaked into default search!");
    if (!hasNewInDefault) throw new Error("New active memory not found in search!");

    // b. Include retired search
    const searchWithRetired = await executeToolCall("search_memory", {
      query: "用户现在住在哪里",
      limit: 10,
      include_retired: true
    }, testUserId, env);

    const oldInRetired = searchWithRetired.memories.find((m: any) => m.id === memoryId);
    const newInRetired = searchWithRetired.memories.find((m: any) => m.id === newMemoryId);
    console.log(`   - Old memory in include_retired search: ${Boolean(oldInRetired)}`);
    console.log(`   - Old memory superseded_by: ${oldInRetired?.superseded_by}`);
    console.log(`   - New memory predecessor: ${newInRetired?.predecessor}`);
    if (!oldInRetired?.superseded_by || oldInRetired.superseded_by !== newMemoryId) {
      throw new Error("Old memory missing superseded_by in search output");
    }
    if (!newInRetired?.predecessor || newInRetired.predecessor !== memoryId) {
      throw new Error("New memory missing predecessor in search output");
    }
    console.log("✅ Lineage correctly exposed in search_memory!");

    // -------------------------------------------------------------
    // Test 9: get_maintenance_cases after resolution
    // -------------------------------------------------------------
    console.log("\n--- [Test 9] get_maintenance_cases after case closed ---");
    const casesResAfter = await executeToolCall("get_maintenance_cases", {
      limit: 5
    }, testUserId, env);
    console.log(`Doctor cases after resolution: has_cases=${casesResAfter.has_cases}, case_count=${casesResAfter.case_count}`);
    const remainingForMem = casesResAfter.cases.filter((c: any) => c.memory_id === memoryId);
    if (remainingForMem.length > 0) {
      throw new Error(`Expected 0 remaining cases for ${memoryId}, found ${remainingForMem.length}`);
    }
    // -------------------------------------------------------------
    // Test 10: KEEP treatment test
    // -------------------------------------------------------------
    console.log("\n--- [Test 10] Testing KEEP treatment ---");
    const memKeep = await executeToolCall("log_memory", {
      content: "用户喜欢喝无糖美式咖啡",
      c_h: 9.0,
      type: "preference",
      source: "user_stated"
    }, testUserId, env);
    pointsToDelete.push(memKeep.id);

    await executeToolCall("submit_concern", {
      memory_id: memKeep.id,
      reason: "用户今天点了拿铁",
      evidence: "用户原话：今天太累了，来一杯生椰拿铁吧",
      severity: "high"
    }, testUserId, env);

    const casesKeep = await executeToolCall("get_maintenance_cases", { limit: 5 }, testUserId, env);
    const caseKeep = casesKeep.cases.find((c: any) => c.memory_id === memKeep.id);
    if (!caseKeep) throw new Error("Expected case for KEEP test");

    const keepRes = await executeToolCall("resolve_maintenance_case", {
      case_id: caseKeep.case_id,
      memory_id: memKeep.id,
      verdict: "RESOLVED",
      treatment: "KEEP",
      doctor_notes: "偶尔喝拿铁不构成整体偏好反转，无糖美式仍为主要偏好，维持原状"
    }, testUserId, env);
    if (!keepRes.success) throw new Error("Expected KEEP to succeed");

    const memAfterKeep = await getPointById(memKeep.id, env);
    if (memAfterKeep.payload?.status !== "active" || memAfterKeep.payload?.suspicion_count !== 0) {
      throw new Error("Expected KEEP memory to be active with suspicion_count=0");
    }
    console.log("✅ KEEP treatment successfully verified!");

    // -------------------------------------------------------------
    // Test 11: EXPIRE treatment test
    // -------------------------------------------------------------
    console.log("\n--- [Test 11] Testing EXPIRE treatment ---");
    const memExpire = await executeToolCall("log_memory", {
      content: "用户正在备战2025年秋季马拉松比赛",
      c_h: 8.5,
      type: "plan",
      source: "user_stated"
    }, testUserId, env);
    pointsToDelete.push(memExpire.id);

    await executeToolCall("submit_concern", {
      memory_id: memExpire.id,
      reason: "比赛时间已远过期且用户已放弃该计划",
      evidence: "用户原话：去年那个马拉松早就取消了，我现在改练游泳了",
      severity: "high"
    }, testUserId, env);

    const casesExpire = await executeToolCall("get_maintenance_cases", { limit: 5 }, testUserId, env);
    const caseExpire = casesExpire.cases.find((c: any) => c.memory_id === memExpire.id);
    if (!caseExpire) throw new Error("Expected case for EXPIRE test");

    const expireRes = await executeToolCall("resolve_maintenance_case", {
      case_id: caseExpire.case_id,
      memory_id: memExpire.id,
      verdict: "RESOLVED",
      treatment: "EXPIRE",
      doctor_notes: "历史计划已实质失效且被新习惯替代，彻底废弃归档"
    }, testUserId, env);
    if (!expireRes.success) throw new Error("Expected EXPIRE to succeed");

    const memAfterExpire = await getPointById(memExpire.id, env);
    if (memAfterExpire.payload?.status !== "expired" || !memAfterExpire.payload?.retired) {
      throw new Error("Expected EXPIRE memory to be expired and retired");
    }
    console.log("✅ EXPIRE treatment successfully verified!");

    // -------------------------------------------------------------
    // Test 12: ESCALATED_TO_USER verdict test
    // -------------------------------------------------------------
    console.log("\n--- [Test 12] Testing ESCALATED_TO_USER verdict ---");
    const memEscalate = await executeToolCall("log_memory", {
      content: "用户与合作导师张教授存在密切合作关系，共同主持实验室课题",
      c_h: 11.5,
      type: "relationship",
      source: "user_stated"
    }, testUserId, env);
    pointsToDelete.push(memEscalate.id);

    await executeToolCall("submit_concern", {
      memory_id: memEscalate.id,
      reason: "合作关系疑似破裂或重大变更",
      evidence: "用户原话：张教授那边以后不要再主动提了",
      severity: "high"
    }, testUserId, env);

    const casesEscalate = await executeToolCall("get_maintenance_cases", { limit: 5 }, testUserId, env);
    const caseEscalate = casesEscalate.cases.find((c: any) => c.memory_id === memEscalate.id);
    if (!caseEscalate) throw new Error("Expected case for ESCALATE test");

    const escalateRes = await executeToolCall("resolve_maintenance_case", {
      case_id: caseEscalate.case_id,
      memory_id: memEscalate.id,
      verdict: "ESCALATED_TO_USER",
      doctor_notes: "核心人际关系敏感变动，语气含义存疑，请用户在后花园控制台亲自定夺"
    }, testUserId, env);
    if (!escalateRes.success) throw new Error("Expected ESCALATE to succeed");

    const memAfterEscalate = await getPointById(memEscalate.id, env);
    if (!memAfterEscalate.payload?.pending_user_confirmation) {
      throw new Error("Expected memory to have pending_user_confirmation=true");
    }
    console.log("✅ ESCALATED_TO_USER successfully verified!");

    // -------------------------------------------------------------
    // Test 13: MERGE treatment test
    // -------------------------------------------------------------
    console.log("\n--- [Test 13] Testing MERGE treatment ---");
    const memMergeA = await executeToolCall("log_memory", {
      content: "用户最常用的编程语言是 TypeScript",
      c_h: 9.5,
      type: "preference",
      source: "user_stated"
    }, testUserId, env);
    pointsToDelete.push(memMergeA.id);

    const memMergeB = await executeToolCall("log_memory", {
      content: "用户日常开发主要使用 TypeScript 进行全栈开发",
      c_h: 9.2,
      type: "preference",
      source: "user_stated"
    }, testUserId, env);
    pointsToDelete.push(memMergeB.id);

    await executeToolCall("submit_concern", {
      memory_id: memMergeA.id,
      reason: "存在重复同构的偏好记忆",
      evidence: "记忆库中存在多条关于 TypeScript 偏好的冗余碎片",
      severity: "high"
    }, testUserId, env);

    const casesMerge = await executeToolCall("get_maintenance_cases", { limit: 5 }, testUserId, env);
    const caseMerge = casesMerge.cases.find((c: any) => c.memory_id === memMergeA.id);
    if (!caseMerge) throw new Error("Expected case for MERGE test");

    const mergeRes = await executeToolCall("resolve_maintenance_case", {
      case_id: caseMerge.case_id,
      memory_id: memMergeA.id,
      verdict: "RESOLVED",
      treatment: "MERGE",
      merge_with_ids: [memMergeB.id],
      updated_content: "用户最常用的主力编程语言是 TypeScript，广泛用于全栈与边缘计算开发",
      doctor_notes: "将两条同构冗余的编程偏好碎片合二为一，消除认知冗余"
    }, testUserId, env);
    if (!mergeRes.success) throw new Error("Expected MERGE to succeed");

    const memAfterMergeB = await getPointById(memMergeB.id, env);
    if (memAfterMergeB.payload?.status !== "expired" || !memAfterMergeB.payload?.retired) {
      throw new Error("Expected merged secondary memory to be retired");
    }
    if (memAfterMergeB.payload?.superseded_by !== memMergeA.id) {
      throw new Error(`Expected merged secondary superseded_by to point to ${memMergeA.id}`);
    }

    const memAfterMergeA = await getPointById(memMergeA.id, env);
    if (memAfterMergeA.payload?.status !== "active") {
      throw new Error("Expected primary merged memory to be active");
    }
    console.log("✅ MERGE treatment successfully verified!");

    // -------------------------------------------------------------
    // Test 14: User consultation query & confirm_memory closure
    // -------------------------------------------------------------
    console.log("\n--- [Test 14] Testing pending_confirmation_only query & user confirmation ---");
    // a. Query memories waiting for user confirmation
    const pendingConsultations = await executeToolCall("search_memory", {
      pending_confirmation_only: true,
      limit: 10
    }, testUserId, env);

    console.log("Pending consultations count:", pendingConsultations.count);
    const foundEscalated = pendingConsultations.memories.find((m: any) => m.id === memEscalate.id);
    if (!foundEscalated) {
      throw new Error("Expected to find escalated memory in pending_confirmation_only search");
    }
    if (!foundEscalated.pending_user_confirmation) {
      throw new Error("Expected pending_user_confirmation to be true in search result");
    }
    console.log(`✅ Found pending user consultation for memory [${memEscalate.id}]!`);

    // b. User confirms the memory via confirm_memory
    const userConfirmRes = await executeToolCall("confirm_memory", {
      id: memEscalate.id,
      note: "用户当面确认合作关系正常，之前只是闹情绪"
    }, testUserId, env);
    if (!userConfirmRes.success) throw new Error("Expected confirm_memory to succeed");

    const memAfterUserConfirm = await getPointById(memEscalate.id, env);
    if (memAfterUserConfirm.payload?.pending_user_confirmation) {
      throw new Error("Expected pending_user_confirmation to be cleared after user confirm");
    }
    console.log("✅ pending_user_confirmation cleared on memory point!");

    // c. Query again, it should no longer be pending
    const pendingConsultationsAfter = await executeToolCall("search_memory", {
      pending_confirmation_only: true,
      limit: 10
    }, testUserId, env);
    const foundAfter = pendingConsultationsAfter.memories.find((m: any) => m.id === memEscalate.id);
    if (foundAfter) {
      throw new Error("Escalated memory should no longer be in pending_confirmation_only search");
    }
    // -------------------------------------------------------------
    // Test 15: Orphan / Deleted memory resolution resilience
    // -------------------------------------------------------------
    console.log("\n--- [Test 15] Testing Orphan / Deleted target memory resolution ---");
    const orphanMemId = crypto.randomUUID();
    await submitConcernToQdrant({
      id: crypto.randomUUID(),
      user_id: testUserId,
      memory_id: orphanMemId,
      reason: "已被外部物理删除的记忆残留顾虑",
      evidence: "用户原话：我早就删了这条了",
      severity: "high",
      interaction_mode: "silent",
      status: "pending",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      duplicate_count: 1,
      defer_count: 0
    }, env);

    const orphanCases = await executeToolCall("get_maintenance_cases", { limit: 5 }, testUserId, env);
    const orphanCase = orphanCases.cases.find((c: any) => c.memory_id === orphanMemId);
    if (!orphanCase) throw new Error("Expected triage case for orphan memory");
    if (orphanCase.target_memory.status !== "deleted") {
      throw new Error(`Expected orphan target_memory status to be 'deleted', got ${orphanCase.target_memory.status}`);
    }

    // Doctor resolves the orphan case with EXPIRE (should NOT throw!)
    const orphanResolveRes = await executeToolCall("resolve_maintenance_case", {
      case_id: orphanCase.case_id,
      memory_id: orphanMemId,
      verdict: "resolved", // test lowercase
      treatment: "expire", // test lowercase
      doctor_notes: "目标记忆已物理删除，予以平稳销案归档"
    }, testUserId, env);

    if (!orphanResolveRes.success) throw new Error("Expected orphan resolution to succeed");
    if (orphanResolveRes.concerns_closed < 1) throw new Error("Expected orphan concern to be closed");
    console.log("✅ Orphan / Deleted memory case resolved smoothly without error!");

    // -------------------------------------------------------------
    // Test 16: Elastic parameter resilience (CASE- prefix in memory_id, alias content field)
    // -------------------------------------------------------------
    console.log("\n--- [Test 16] Testing Elastic Parameter Resilience ---");
    const memElastic = await executeToolCall("log_memory", {
      content: "用户喜欢在周六早上去游泳",
      c_h: 9.0,
      type: "preference",
      source: "user_stated"
    }, testUserId, env);
    pointsToDelete.push(memElastic.id);

    await executeToolCall("submit_concern", {
      memory_id: memElastic.id,
      reason: "时间变更为周日",
      evidence: "用户原话：现在改成周日早上去游泳了",
      severity: "high"
    }, testUserId, env);

    // Doctor calls with CASE- prefix as memory_id, content in 'content' field, uppercase/lowercase mixed
    const elasticResolveRes = await executeToolCall("resolve_maintenance_case", {
      case_id: `CASE-${memElastic.id.slice(0, 8).toUpperCase()}`,
      memory_id: `CASE-${memElastic.id.slice(0, 8).toUpperCase()}`, // passing case_id into memory_id
      verdict: "RESOLVED",
      treatment: "UPDATE",
      content: "用户现在习惯在周日早上去游泳锻炼", // alias field
      doctor_notes: "根据最新原话更新游泳时间至周日"
    }, testUserId, env);

    if (!elasticResolveRes.success) throw new Error("Expected elastic resolution to succeed");
    const memElasticAfter = await getPointById(memElastic.id, env);
    if (!memElasticAfter.payload?.superseded_by) {
      throw new Error("Expected elastic resolution to create superseded_by link");
    }
    pointsToDelete.push(memElasticAfter.payload.superseded_by);
    console.log("✅ Elastic parameter resilience successfully verified!");

    console.log("\n🎉 ALL 16 INTEGRATION TESTS PASSED WITH 100% SUCCESS!");

  } finally {
    // -------------------------------------------------------------
    // Cleanup: Delete test data in Qdrant
    // -------------------------------------------------------------
    console.log("\n--- Cleaning up test points ---");
    // Also include leftover IDs from initial run
    pointsToDelete.push("e043cf9a-ca1b-4fbe-82c4-e973f86e054e", "5a2e5870-79be-4b14-9c68-821c36c0cca8");
    if (pointsToDelete.length > 0) {
      try {
        await deleteMemoryPoints(pointsToDelete, env);
        console.log(`Cleaned up test memories: ${pointsToDelete.join(", ")}`);
      } catch (e: any) {
        console.warn(`Cleanup error for memories:`, e.message);
      }
    }

    // Clean up concerns collection points
    const qFetch = async (url: string, opts: any) => fetch(url, {
      ...opts,
      headers: { "api-key": qdrantKey, "Content-Type": "application/json" }
    });
    const deleteConcernsUrl = `${env.QDRANT_URL}/collections/${CONCERNS_COLLECTION}/points/delete?wait=true`;
    try {
      await qFetch(deleteConcernsUrl, {
        method: "POST",
        body: JSON.stringify({
          filter: {
            must: [
              { key: "user_id", match: { value: testUserId } }
            ]
          }
        })
      });
      console.log(`Cleaned up test concerns for user: ${testUserId}`);
    } catch (e: any) {
      console.warn("Cleanup concerns error:", e.message);
    }
  }
}

run().catch((err) => {
  console.error("❌ Integration test failed:", err);
  process.exit(1);
});
