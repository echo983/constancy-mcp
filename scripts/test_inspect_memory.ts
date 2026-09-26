import fs from "fs";
import { executeToolCall, McpEnv } from "../src/mcp";
import { getPointById, deleteMemoryPoints, CONCERNS_COLLECTION } from "../src/qdrant";

async function run() {
  console.log("🚀 Starting inspect_memory Comprehensive Integration Test...");

  const qdrantKey = fs.readFileSync("/home/edwin/ramws/any/secret/Qdrant-api-key@vec.kufof.uk.txt", "utf-8").trim();
  const voyageKey = fs.readFileSync("/home/edwin/ramws/any/secret/Voyageai-api-key@vec.kufof.uk.txt", "utf-8").trim();

  const env: McpEnv = {
    QDRANT_URL: "https://vec.kufof.uk",
    QDRANT_API_KEY: qdrantKey,
    VOYAGE_API_KEY: voyageKey,
    DOMAIN: "mcp.kufof.uk"
  };

  const userA = `test_inspect_user_a_${Date.now()}`;
  const userB = `test_inspect_user_b_${Date.now()}`;
  console.log(`👤 User A: ${userA}, User B: ${userB}`);

  const pointsToDelete: string[] = [];

  try {
    // -------------------------------------------------------------
    // Test 1: Negative Validation & Cross-Tenant Rejection
    // -------------------------------------------------------------
    console.log("\n--- [Test 1] Negative Validation & Multi-Tenant Isolation ---");
    try {
      await executeToolCall("inspect_memory", {}, userA, env);
      throw new Error("Expected validation error for missing id");
    } catch (err: any) {
      console.log(`✅ Caught expected error on missing id: ${err.message}`);
    }

    try {
      await executeToolCall("inspect_memory", { id: "non-existent-uuid-9999" }, userA, env);
      throw new Error("Expected error for non-existent memory");
    } catch (err: any) {
      console.log(`✅ Caught expected error on non-existent memory: ${err.message}`);
    }

    // User A creates a private memory
    const userAMem = await executeToolCall("log_memory", {
      content: "机密信息：User A 的绝密密码代号是 QuantumCobalt_9918",
      c_h: 10.0,
      source: "user_stated"
    }, userA, env);
    pointsToDelete.push(userAMem.id);

    // User B attempts to inspect User A's memory
    try {
      await executeToolCall("inspect_memory", { id: userAMem.id }, userB, env);
      throw new Error("Expected cross-tenant access to be blocked!");
    } catch (err: any) {
      console.log(`✅ Cross-tenant inspect_memory blocked as expected: ${err.message}`);
    }

    // -------------------------------------------------------------
    // Test 2: Single-Point Deep Inspection & In-place Revisions
    // -------------------------------------------------------------
    console.log("\n--- [Test 2] Single-Point Deep Inspection & In-place Revisions ---");
    const noteRes = await executeToolCall("save_note", {
      title: "数据中心冷通道温度规范",
      content: "初始版本：冷通道进风温度标准设定为 22°C - 24°C",
      tags: ["datacenter", "cooling"],
      c_h: 9.5
    }, userA, env);
    const noteId = noteRes.id;
    pointsToDelete.push(noteId);

    // Update note to produce an in-place revision snapshot
    await executeToolCall("update_note", {
      id: noteId,
      title: "数据中心冷通道温度规范 v2",
      content: "更新版本：冷通道进风温度标准上调为 23°C - 25°C，以提升 PUE 能效比"
    }, userA, env);

    const inspectNote = await executeToolCall("inspect_memory", { id: noteId }, userA, env);
    console.log("Inspect single note response:", {
      success: inspectNote.success,
      id: inspectNote.target_details?.id,
      ch_dynamic: inspectNote.target_details?.ch_dynamic,
      resonant_heat: inspectNote.target_details?.resonant_heat,
      revisions_count: inspectNote.target_details?.revisions_count,
      total_generations: inspectNote.genealogy?.total_generations
    });

    if (!inspectNote.success) throw new Error("Expected inspect_memory to succeed");
    if (inspectNote.target_details?.id !== noteId) throw new Error("Target ID mismatch");
    if (inspectNote.target_details?.revisions_count !== 1) {
      throw new Error(`Expected 1 revision, got ${inspectNote.target_details?.revisions_count}`);
    }
    if (inspectNote.genealogy?.total_generations !== 1) {
      throw new Error(`Expected single generation, got ${inspectNote.genealogy?.total_generations}`);
    }
    console.log("✅ Single-point inspection & revisions audit verified!");

    // -------------------------------------------------------------
    // Test 3: Multi-Generation Causal Lineage Tracing (Gen 1 -> Gen 2 -> Gen 3)
    // -------------------------------------------------------------
    console.log("\n--- [Test 3] Multi-Generation Causal Lineage Tracing (3 Generations) ---");
    // Gen 1: initial fact
    const gen1 = await executeToolCall("log_memory", {
      content: "【核心事实: 用户住址】用户居住于北京市海淀区中关村南大街",
      c_h: 9.8,
      source: "user_stated"
    }, userA, env);
    const gen1Id = gen1.id;
    pointsToDelete.push(gen1Id);

    // Gen 1 -> Gen 2: Doctor UPDATE
    await executeToolCall("submit_concern", {
      memory_id: gen1Id,
      reason: "用户已从中关村迁往望京",
      evidence: "用户原话：我搬家到望京了",
      severity: "high"
    }, userA, env);

    const update1 = await executeToolCall("resolve_maintenance_case", {
      case_id: `CASE-${gen1Id.slice(0, 8).toUpperCase()}`,
      memory_id: gen1Id,
      verdict: "RESOLVED",
      treatment: "UPDATE",
      updated_content: "【核心事实: 用户住址】用户现居住于北京市朝阳区望京SOHO",
      doctor_notes: "根据最新原话更新住址为望京"
    }, userA, env);

    const gen2Id = update1.new_memory_id;
    if (!gen2Id) throw new Error("Failed to obtain Gen 2 ID from update1");
    pointsToDelete.push(gen2Id);

    // Gen 2 -> Gen 3: Doctor UPDATE
    await executeToolCall("submit_concern", {
      memory_id: gen2Id,
      reason: "用户迁往上海浦东",
      evidence: "用户原话：我现在定居上海浦东陆家嘴了",
      severity: "high"
    }, userA, env);

    const update2 = await executeToolCall("resolve_maintenance_case", {
      case_id: `CASE-${gen2Id.slice(0, 8).toUpperCase()}`,
      memory_id: gen2Id,
      verdict: "RESOLVED",
      treatment: "UPDATE",
      updated_content: "【核心事实: 用户住址】用户现已长期定居于上海市浦东新区陆家嘴",
      doctor_notes: "两次跨会话原话确凿证实跨城定居，升级为第三世代"
    }, userA, env);

    const gen3Id = update2.new_memory_id;
    if (!gen3Id) throw new Error("Failed to obtain Gen 3 ID from update2");
    pointsToDelete.push(gen3Id);

    // Now query inspect_memory on the middle node (Gen 2)!
    console.log(`\n🔍 Inspecting Middle Node Gen 2 (${gen2Id})...`);
    const inspectGen2 = await executeToolCall("inspect_memory", { id: gen2Id }, userA, env);

    console.log("Genealogy summary:", {
      root_id: inspectGen2.genealogy?.root_id,
      latest_active_id: inspectGen2.genealogy?.latest_active_id,
      target_generation: inspectGen2.genealogy?.target_generation,
      total_generations: inspectGen2.genealogy?.total_generations,
      chain_length: inspectGen2.genealogy?.lineage_chain?.length
    });

    if (inspectGen2.genealogy?.total_generations !== 3) {
      throw new Error(`Expected 3 generations, got ${inspectGen2.genealogy?.total_generations}`);
    }
    if (inspectGen2.genealogy?.target_generation !== 2) {
      throw new Error(`Expected target_generation to be 2, got ${inspectGen2.genealogy?.target_generation}`);
    }
    if (inspectGen2.genealogy?.root_id !== gen1Id) {
      throw new Error(`Expected root_id to be Gen 1 (${gen1Id}), got ${inspectGen2.genealogy?.root_id}`);
    }
    if (inspectGen2.genealogy?.latest_active_id !== gen3Id) {
      throw new Error(`Expected latest_active_id to be Gen 3 (${gen3Id}), got ${inspectGen2.genealogy?.latest_active_id}`);
    }

    const chain = inspectGen2.genealogy.lineage_chain;
    // Gen 1 checks
    if (chain[0].id !== gen1Id || chain[0].generation !== 1 || chain[0].status !== "expired") {
      throw new Error("Gen 1 node attributes mismatch in lineage chain");
    }
    // Gen 2 checks
    if (chain[1].id !== gen2Id || chain[1].generation !== 2 || !chain[1].is_current_target || chain[1].status !== "expired") {
      throw new Error("Gen 2 node attributes mismatch in lineage chain");
    }
    // Gen 3 checks
    if (chain[2].id !== gen3Id || chain[2].generation !== 3 || chain[2].status !== "active") {
      throw new Error("Gen 3 node attributes mismatch in lineage chain");
    }

    // Verify source preservation across the entire lineage
    for (const node of chain) {
      if (node.source !== "user_stated") {
        throw new Error(`Expected source 'user_stated' across all generations, got ${node.source} at gen ${node.generation}`);
      }
      console.log(`   - Gen ${node.generation} [${node.id.slice(0, 8)}]: status=${node.status}, source=${node.source_badge}, dynamic_ch=${node.ch_dynamic}, heat=${node.resonant_heat}`);
    }

    console.log("✅ 3-Generation Causal Lineage successfully traced from middle node!");

    // -------------------------------------------------------------
    // Test 4: Polymorphic ID (CASE- Prefix & Short Hex Prefix) Resolution
    // -------------------------------------------------------------
    console.log("\n--- [Test 4] Polymorphic ID (CASE- Prefix & Hex Prefix) Resolution ---");
    const caseIdQuery = `CASE-${gen3Id.slice(0, 8).toUpperCase()}`;
    const inspectByCaseId = await executeToolCall("inspect_memory", { id: caseIdQuery }, userA, env);
    if (!inspectByCaseId.success || inspectByCaseId.target_details?.id !== gen3Id) {
      throw new Error(`Expected inspection by CASE- ID to resolve to ${gen3Id}`);
    }
    console.log(`✅ Polymorphic ID '${caseIdQuery}' correctly resolved to target memory ${gen3Id}!`);

    const rawHexPrefix = gen3Id.slice(0, 8);
    const inspectByHex = await executeToolCall("inspect_memory", { id: rawHexPrefix }, userA, env);
    if (!inspectByHex.success || inspectByHex.target_details?.id !== gen3Id) {
      throw new Error(`Expected inspection by hex prefix '${rawHexPrefix}' to resolve to ${gen3Id}`);
    }
    console.log(`✅ Raw hex prefix '${rawHexPrefix}' correctly resolved to target memory ${gen3Id}!`);

    // Verify spectrum transparency (stored vs decayed)
    if (!Array.isArray(inspectByHex.target_details?.h_spectrum_stored) || inspectByHex.target_details.h_spectrum_stored.length !== 7) {
      throw new Error("h_spectrum_stored missing or malformed in target_details");
    }
    if (!Array.isArray(inspectByHex.target_details?.h_spectrum_decayed) || inspectByHex.target_details.h_spectrum_decayed.length !== 7) {
      throw new Error("h_spectrum_decayed missing or malformed in target_details");
    }
    console.log("✅ Spectrum transparency verified: h_spectrum_stored and h_spectrum_decayed present!");

    console.log("\n🎉 ALL INSPECT_MEMORY TESTS PASSED WITH 100% SUCCESS!");

  } finally {
    console.log("\n--- Cleaning up test points ---");
    if (pointsToDelete.length > 0) {
      try {
        await deleteMemoryPoints(pointsToDelete, env);
        console.log(`Cleaned up memories: ${pointsToDelete.join(", ")}`);
      } catch (e: any) {
        console.warn("Cleanup memories error:", e.message);
      }
    }

    const qFetch = async (url: string, opts: any) => fetch(url, {
      ...opts,
      headers: { "api-key": qdrantKey, "Content-Type": "application/json" }
    });
    for (const u of [userA, userB]) {
      try {
        await qFetch(`${env.QDRANT_URL}/collections/${CONCERNS_COLLECTION}/points/delete?wait=true`, {
          method: "POST",
          body: JSON.stringify({
            filter: { must: [{ key: "user_id", match: { value: u } }] }
          })
        });
      } catch (e: any) {}
    }
  }
}

run().catch((err) => {
  console.error("❌ Test failed:", err);
  process.exit(1);
});
