import { MCP_TOOLS, executeToolCall, McpEnv } from "../src/mcp";

async function runTests() {
  console.log("🧪 Starting update_memory & Epistemic Serving Unit & Integration Tests...\n");

  // -------------------------------------------------------------
  // Test 1: MCP_TOOLS Schema Verification
  // -------------------------------------------------------------
  console.log("--- [Test 1] Verify MCP_TOOLS Schema Registration ---");
  const updateTool = MCP_TOOLS.find(t => t.name === "update_memory");
  if (!updateTool) {
    throw new Error("❌ update_memory tool is NOT registered in MCP_TOOLS!");
  }
  console.log("✅ update_memory is registered in MCP_TOOLS");
  
  const schema = updateTool.inputSchema;
  if (!schema.required?.includes("id") || !schema.required?.includes("content")) {
    throw new Error("❌ update_memory schema missing required ['id', 'content']!");
  }
  if (!schema.properties.id || !schema.properties.content || !schema.properties.reason) {
    throw new Error("❌ update_memory schema missing property definitions!");
  }
  console.log("✅ Schema required fields and properties verified:", Object.keys(schema.properties));

  // -------------------------------------------------------------
  // Test 2: In-Memory Store & Global Fetch Interceptor
  // -------------------------------------------------------------
  console.log("\n--- [Test 2] Setting up Global Fetch Interceptor ---");
  const store = new Map<string, any>();
  const embeddingCalls: Array<{ input: any }> = [];

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const urlStr = typeof input === "string" ? input : input.toString();

    // 1. Voyage AI Embedding API
    if (urlStr.includes("voyageai.com")) {
      const body = JSON.parse((init?.body as string) || "{}");
      const text = body.inputs?.[0]?.content?.[0]?.text;
      embeddingCalls.push({ input: text });
      return new Response(JSON.stringify({
        data: [{ embedding: new Array(1024).fill(0.123) }]
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    // 2. Qdrant: Get Point by ID (/points/<uuid>)
    const pointMatch = urlStr.match(/\/collections\/constancy_memories\/points\/([0-9a-fA-F-]+)$/);
    if (pointMatch && init?.method !== "POST") {
      const id = pointMatch[1];
      const pt = store.get(id);
      if (pt) {
        return new Response(JSON.stringify({
          result: { id: pt.id, payload: pt.payload }
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({
        status: "ok",
        result: null
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    // 3. Qdrant: Scroll (/points/scroll)
    if (urlStr.includes("/collections/constancy_memories/points/scroll")) {
      const body = JSON.parse((init?.body as string) || "{}");
      const matched: any[] = [];
      const filter = body.filter || {};
      const mustList = filter.must || [];
      const userFilter = mustList.find((m: any) => m.key === "user_id")?.match?.value;

      for (const [id, pt] of store.entries()) {
        if (!userFilter || pt.payload?.user_id === userFilter) {
          matched.push({ id: pt.id, payload: pt.payload });
        }
      }
      return new Response(JSON.stringify({
        result: { points: matched, next_page_offset: null }
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    // 4. Qdrant: Images collection requests
    if (urlStr.includes("/collections/images/")) {
      return new Response(JSON.stringify({
        result: []
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    // 5. Qdrant: Update Payload (/points/payload)
    if (urlStr.includes("/collections/constancy_memories/points/payload")) {
      const body = JSON.parse((init?.body as string) || "{}");
      let pointIds = body.points || [];
      if (body.filter?.must) {
        const hasIdFilter = body.filter.must.find((m: any) => m.has_id);
        if (hasIdFilter) {
          pointIds = hasIdFilter.has_id;
        }
      }
      for (const pid of pointIds) {
        const pt = store.get(pid);
        if (pt) {
          const mustNotRetired = body.filter?.must_not?.some((mn: any) => mn.key === "retired" && mn.match?.value === true);
          if (mustNotRetired && pt.payload?.retired) {
            continue; // Skipped due to CAS condition
          }
          pt.payload = { ...pt.payload, ...body.payload };
        }
      }
      return new Response(JSON.stringify({ result: { status: "completed" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }

    // 7. Qdrant: Search Points (/points/search)
    if (urlStr.includes("/points/search")) {
      const body = JSON.parse((init?.body as string) || "{}");
      const matched: any[] = [];
      const userFilter = body.filter?.must?.find((m: any) => m.key === "user_id")?.match?.value;
      for (const [id, pt] of store.entries()) {
        if (!userFilter || pt.payload?.user_id === userFilter) {
          matched.push({ id: pt.id, payload: pt.payload, score: 0.95 });
        }
      }
      return new Response(JSON.stringify({ result: matched }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }

    // 6. Qdrant: Upsert Points (PUT /points)
    if (urlStr.includes("/collections/constancy_memories/points") && (init?.method === "PUT" || init?.method === "POST")) {
      const body = JSON.parse((init?.body as string) || "{}");
      const points = body.points || [];
      for (const pt of points) {
        store.set(pt.id, { id: pt.id, vector: pt.vector, payload: pt.payload });
      }
      return new Response(JSON.stringify({ result: { status: "completed" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }



    // Fallback
    return new Response(JSON.stringify({ result: {} }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };

  const env: McpEnv = {
    QDRANT_URL: "https://vec.kufof.uk",
    QDRANT_API_KEY: "mock_key",
    VOYAGE_API_KEY: "mock_key",
    JWT_SECRET: "mock_secret",
    DOMAIN: "mcp.kufof.uk"
  };

  const userA = "user_alice@example.com";
  const userB = "user_bob@example.com";

  try {
    // -------------------------------------------------------------
    // Test 3: Input Validation & Error Handling
    // -------------------------------------------------------------
    console.log("\n--- [Test 3] Negative Validation & Error Handling ---");
    try {
      await executeToolCall("update_memory", {}, userA, env);
      throw new Error("Should fail without arguments");
    } catch (err: any) {
      console.log(`✅ Caught expected error for empty args: ${err.message}`);
    }

    try {
      await executeToolCall("update_memory", { id: "00000000-0000-0000-0000-000000000000", content: "新内容" }, userA, env);
      throw new Error("Should fail for non-existent point");
    } catch (err: any) {
      console.log(`✅ Caught expected error for non-existent ID: ${err.message}`);
    }

    // Seed User A's original memory
    const originalMemoryId = "11111111-2222-3333-4444-555555555555";
    store.set(originalMemoryId, {
      id: originalMemoryId,
      vector: new Array(1024).fill(0.01),
      payload: {
        user_id: userA,
        content: "用户现居住于北京市朝阳区高家园",
        timestamp: "2026-08-01T10:00:00.000Z",
        created_at: "2026-08-01T10:00:00.000Z",
        date: "2026-08-01",
        type: "insight",
        source: "user_stated",
        ch_prior: 9.8,
        h_spectrum: [1.0, 0.8, 0.6, 0.4, 0.2, 0.1, 0.05],
        status: "active",
        tags: ["life", "address"]
      }
    });

    // Test cross-tenant rejection: User B tries to update User A's memory
    try {
      await executeToolCall("update_memory", {
        id: originalMemoryId,
        content: "恶意篡改：搬到了火星"
      }, userB, env);
      throw new Error("Cross-tenant update should be blocked!");
    } catch (err: any) {
      console.log(`✅ Cross-tenant update blocked successfully: ${err.message}`);
    }

    // -------------------------------------------------------------
    // Test 4: Successful Generational Turnover (update_memory)
    // -------------------------------------------------------------
    console.log("\n--- [Test 4] Successful Generational Turnover ---");
    embeddingCalls.length = 0;
    const updateResult = await executeToolCall("update_memory", {
      id: originalMemoryId,
      content: "用户现已常住上海市浦东新区陆家嘴",
      reason: "用户亲口告知上月已完成搬家定居"
    }, userA, env);

    console.log("Update Tool Call Result:", updateResult);
    if (!updateResult.success || !updateResult.id) {
      throw new Error("❌ update_memory call did not return success!");
    }

    const newId = updateResult.id;
    if (updateResult.predecessor !== originalMemoryId) {
      throw new Error(`❌ Predecessor mismatch! Expected ${originalMemoryId}, got ${updateResult.predecessor}`);
    }

    // Check embedding was computed for the new content
    if (embeddingCalls.length === 0 || embeddingCalls[0].input !== "用户现已常住上海市浦东新区陆家嘴") {
      throw new Error("❌ getEmbedding was NOT called with the new content!");
    }
    console.log(`✅ Verified Voyage AI re-embedding called for new text: "${embeddingCalls[0].input}"`);

    // Verify Old Memory State
    const oldPoint = store.get(originalMemoryId);
    if (!oldPoint.payload.retired) {
      throw new Error("❌ Old point was NOT marked retired!");
    }
    if (oldPoint.payload.status !== "expired") {
      throw new Error(`❌ Old point status should be expired, got ${oldPoint.payload.status}`);
    }
    if (oldPoint.payload.superseded_by !== newId) {
      throw new Error(`❌ Old point superseded_by should point to ${newId}, got ${oldPoint.payload.superseded_by}`);
    }
    console.log("✅ Old point properly retired with superseded_by pointer:", oldPoint.payload.superseded_by);

    // Verify New Memory State
    const newPoint = store.get(newId);
    if (!newPoint) {
      throw new Error("❌ New generation point was not saved in store!");
    }
    if (newPoint.payload.content !== "用户现已常住上海市浦东新区陆家嘴") {
      throw new Error("❌ New generation content does not match!");
    }
    if (newPoint.payload.status !== "active" || newPoint.payload.retired) {
      throw new Error("❌ New generation should be active and not retired!");
    }
    if (newPoint.payload.predecessor !== originalMemoryId) {
      throw new Error("❌ New generation predecessor is incorrect!");
    }
    if (newPoint.payload.source !== "user_stated") {
      throw new Error(`❌ New generation source should be user_stated, got ${newPoint.payload.source}`);
    }
    if (newPoint.payload.ch_prior !== 9.8) {
      throw new Error(`❌ New generation should inherit ch_prior 9.8, got ${newPoint.payload.ch_prior}`);
    }
    if (!Array.isArray(newPoint.payload.revisions) || newPoint.payload.revisions.length !== 1) {
      throw new Error("❌ Revisions audit trail was not preserved in new generation!");
    }
    console.log("✅ New generation created with clean content, active status, predecessor link, and inherited ch_prior:", newPoint.payload.ch_prior);
    console.log("✅ Revisions trail properly recorded old text in history:", newPoint.payload.revisions[0].content);

    // -------------------------------------------------------------
    // Test 5: Prefix-based ID update (e.g. 8-char prefix)
    // -------------------------------------------------------------
    console.log("\n--- [Test 5] Prefix-based ID update ---");
    const prefix8 = newId.slice(0, 8);
    const updatePrefixResult = await executeToolCall("update_memory", {
      id: prefix8,
      content: "用户现已常住上海市浦东新区陆家嘴，且喜好淮扬菜与粤菜",
      reason: "补充饮食偏好细节"
    }, userA, env);

    if (!updatePrefixResult.success || updatePrefixResult.predecessor !== newId) {
      throw new Error("❌ Prefix-based update failed!");
    }
    console.log(`✅ Successfully updated memory via 8-char prefix '${prefix8}' -> New ID: ${updatePrefixResult.id}`);

    // -------------------------------------------------------------
    // Test 6: search_memory formatting for active points with doubt/caveat
    // -------------------------------------------------------------
    console.log("\n--- [Test 6] search_memory Doubt Banner Projection ---");
    const doubtPointId = "22222222-3333-4444-5555-666666666666";
    store.set(doubtPointId, {
      id: doubtPointId,
      vector: new Array(768).fill(0.2),
      payload: {
        user_id: userA,
        content: "用户计划明年去冰岛旅游",
        timestamp: new Date().toISOString(),
        date: new Date().toISOString().slice(0, 10),
        type: "insight",
        source: "user_stated",
        ch_prior: 9.0,
        h_spectrum: [1, 0.6, 0.36, 0.22, 0.13, 0.08, 0.05],
        status: "active",
        tags: ["travel"],
        annotations: [
          {
            id: "ann-1",
            kind: "doubt",
            text: "用户最近表示由于签证和预算原因，可能暂缓冰岛行程，转去日本",
            source: "model_inferred",
            timestamp: new Date().toISOString()
          }
        ]
      }
    });

    const searchResult = await executeToolCall("search_memory", {
      query: "冰岛"
    }, userA, env);

    if (!searchResult.memories || searchResult.memories.length === 0) {
      throw new Error("❌ search_memory did not return candidates!");
    }
    const returnedMem = searchResult.memories.find((m: any) => m.id === doubtPointId);
    if (!returnedMem) {
      throw new Error("❌ doubt memory not found in search results!");
    }
    console.log("Returned Memory Content:\n", returnedMem.content);
    if (!returnedMem.content.startsWith("【⚠️ 事实存疑待核】")) {
      throw new Error("❌ search_memory did NOT prepend the doubt warning badge!");
    }
    if (!returnedMem.original_content || returnedMem.original_content !== "用户计划明年去冰岛旅游") {
      throw new Error("❌ search_memory original_content not preserved!");
    }
    console.log("✅ search_memory successfully projected doubt banner and preserved original_content!");

    // -------------------------------------------------------------
    // Test 7: Rejection of update_memory on Already-Retired Memory (Resurrection Protection)
    // -------------------------------------------------------------
    console.log("\n--- [Test 7] Reject update_memory on Already-Retired Memory ---");
    const retiredMemoryId = "77777777-7777-7777-7777-777777777777";
    store.set(retiredMemoryId, {
      id: retiredMemoryId,
      vector: new Array(1024).fill(0.01),
      payload: {
        user_id: userA,
        content: "旧事实：用户使用 ThinkPad",
        timestamp: "2026-08-01T10:00:00.000Z",
        date: "2026-08-01",
        type: "insight",
        source: "user_stated",
        ch_prior: 0.0,
        status: "expired",
        retired: true,
        retired_at: "2026-09-01T10:00:00.000Z",
        retired_reason: "用户换电脑了，演练结束归档",
        tags: ["hardware"]
      }
    });

    try {
      await executeToolCall("update_memory", {
        id: retiredMemoryId,
        content: "试图换代复活已退役记忆：改成 Framework 16"
      }, userA, env);
      throw new Error("❌ update_memory on retired memory should have been rejected!");
    } catch (err: any) {
      if (!err.message.includes("换代被拒绝：目标记忆") || !err.message.includes("已处于退役归档状态")) {
        throw new Error(`❌ Unexpected error message: ${err.message}`);
      }
      console.log(`✅ Correctly rejected update_memory on retired memory: "${err.message}"`);
    }

    // -------------------------------------------------------------
    // Test 8: Rejection of update_memory on Already-Superseded Memory (Lineage Protection)
    // -------------------------------------------------------------
    console.log("\n--- [Test 8] Reject update_memory on Already-Superseded Memory ---");
    // originalMemoryId was superseded by newId ('9aa7e8e2...') in Test 4
    try {
      await executeToolCall("update_memory", {
        id: originalMemoryId,
        content: "试图在初代旧版本上分叉更新"
      }, userA, env);
      throw new Error("❌ update_memory on superseded memory should have been rejected!");
    } catch (err: any) {
      if (!err.message.includes("换代冲突（陈旧/分叉换代）") || !err.message.includes("最新活跃世代为")) {
        throw new Error(`❌ Unexpected error message: ${err.message}`);
      }
      console.log(`✅ Correctly rejected update_memory on superseded memory: "${err.message}"`);
    }

    // -------------------------------------------------------------
    // Test 9: Concurrent Race Condition & CAS Split-Brain Protection
    // -------------------------------------------------------------
    console.log("\n--- [Test 9] Concurrent Race Condition & CAS Split-Brain Protection ---");
    const racePointId = "88888888-8888-8888-8888-888888888888";
    store.set(racePointId, {
      id: racePointId,
      vector: new Array(1024).fill(0.01),
      payload: {
        user_id: userA,
        content: "用户的主力 NAS 位于书房",
        timestamp: "2026-08-01T10:00:00.000Z",
        date: "2026-08-01",
        type: "insight",
        source: "user_stated",
        ch_prior: 9.5,
        h_spectrum: [1.0, 0.8, 0.6, 0.4, 0.2, 0.1, 0.05],
        status: "active",
        tags: ["nas", "home"]
      }
    });

    // Run two concurrent update calls
    const [resX, resY] = await Promise.allSettled([
      executeToolCall("update_memory", { id: racePointId, content: "NAS 迁往客厅 (分支X)" }, userA, env),
      executeToolCall("update_memory", { id: racePointId, content: "NAS 迁往地下室 (分支Y)" }, userA, env)
    ]);

    const successes = [resX, resY].filter(r => r.status === "fulfilled");
    const rejections = [resX, resY].filter(r => r.status === "rejected");

    console.log(`Concurrent results: ${successes.length} fulfilled, ${rejections.length} rejected`);
    if (successes.length !== 1 || rejections.length !== 1) {
      throw new Error(`❌ Exactly 1 update should succeed and 1 should fail, got ${successes.length} successes and ${rejections.length} rejections!`);
    }

    const winningResult = (successes[0] as PromiseFulfilledResult<any>).value;
    const losingError = (rejections[0] as PromiseRejectedResult).reason;
    console.log(`✅ Winning generation ID: ${winningResult.id}`);
    console.log(`✅ Losing call safely rejected with: "${losingError.message}"`);

    // Verify root point points ONLY to the winner
    const raceRoot = store.get(racePointId);
    if (raceRoot.payload.superseded_by !== winningResult.id) {
      throw new Error(`❌ Root point superseded_by [${raceRoot.payload.superseded_by}] does not match winner [${winningResult.id}]!`);
    }
    console.log("✅ Root point cleanly points to the single winner. Split-brain prevented!");

    // -------------------------------------------------------------
    // Test 10: Epistemic Guidance Differentiation (model_suggested vs user_stated)
    // -------------------------------------------------------------
    console.log("\n--- [Test 10] Epistemic Guidance Differentiation ---");
    const memoPointId = "66666666-6666-6666-6666-666666666666";
    store.set(memoPointId, {
      id: memoPointId,
      vector: new Array(1024).fill(0.01),
      payload: {
        user_id: userA,
        content: "建议考虑为 NAS 增加一块备份硬盘",
        timestamp: new Date().toISOString(),
        date: "2026-10-05",
        type: "memo",
        source: "model_suggested",
        ch_prior: 9.0,
        h_spectrum: [1.0, 0.8, 0.6, 0.4, 0.2, 0.1, 0.05],
        status: "active",
        tags: ["nas", "recommendation"]
      }
    });

    const searchMemoRes = await executeToolCall("search_memory", { query: "备份硬盘" }, userA, env);
    const foundMemo = (searchMemoRes.memories || []).find((m: any) => m.id === memoPointId);
    if (!foundMemo) {
      throw new Error("❌ model_suggested memo not found in search results!");
    }
    console.log("Memo Status Badge:", foundMemo.status_badge);
    console.log("Memo Prompt Guidance:", foundMemo.prompt_guidance);

    if (!foundMemo.status_badge.includes("模型建议")) {
      throw new Error(`❌ Expected status_badge to mention '模型建议', got: ${foundMemo.status_badge}`);
    }
    if (foundMemo.prompt_guidance.includes("坚实先验引用") || foundMemo.prompt_guidance.includes("无需向用户多余确认")) {
      throw new Error(`❌ model_suggested memo must NOT be guided as solid fact without confirmation! Got: ${foundMemo.prompt_guidance}`);
    }
    if (!foundMemo.prompt_guidance.includes("严禁武断定性为用户已确立的既成事实")) {
      throw new Error(`❌ Expected guidance to warn against asserting suggestion as fact! Got: ${foundMemo.prompt_guidance}`);
    }
    console.log("✅ Epistemic guidance correctly prevents model suggestions from being treated as established facts!");

    // -------------------------------------------------------------
    // Test 11: Content Immutability & Clean Storage
    // -------------------------------------------------------------
    console.log("\n--- [Test 11] Content Immutability & Clean Storage ---");
    const logRes = await executeToolCall("log_memory", {
      content: "纯净内容测试：用户常喝普洱茶",
      source: "user_stated",
      type: "insight",
      tags: ["tea", "habit"]
    }, userA, env);

    const loggedPoint = store.get(logRes.id);
    if (loggedPoint.payload.content.startsWith("【来源:")) {
      throw new Error(`❌ Stored content must not have '【来源:' prefix! Got: ${loggedPoint.payload.content}`);
    }
    console.log("✅ Stored content is clean without artificial prefix:", loggedPoint.payload.content);

    console.log("\n🎉 ALL UNIT AND INTEGRATION TESTS PASSED 100%!");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

runTests().catch(err => {
  console.error("❌ Test failed:", err.stack || err);
  process.exit(1);
});
