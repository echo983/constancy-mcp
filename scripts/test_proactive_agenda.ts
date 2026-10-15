import fs from "fs";
import { executeToolCall, McpEnv, MCP_TOOLS } from "../src/mcp";
import { AGENDAS_COLLECTION } from "../src/qdrant";

async function run() {
  console.log("🚀 Starting Proactive Agenda Center Integration Test...\n");

  const qdrantKey = fs.readFileSync("/home/edwin/ramws/any/secret/Qdrant-api-key@vec.kufof.uk.txt", "utf-8").trim();
  const voyageKey = fs.readFileSync("/home/edwin/ramws/any/secret/Voyageai-api-key@vec.kufof.uk.txt", "utf-8").trim();

  const env: McpEnv = {
    QDRANT_URL: "https://vec.kufof.uk",
    QDRANT_API_KEY: qdrantKey,
    VOYAGE_API_KEY: voyageKey,
    DOMAIN: "mcp.kufof.uk"
  };

  const testUserId = `test_agenda_user_${Date.now()}`;
  console.log(`👤 Using test user ID: ${testUserId}`);

  const createdAgendaIds: string[] = [];

  try {
    // -------------------------------------------------------------
    // Test 1: Tool Registration and Schema Validation
    // -------------------------------------------------------------
    console.log("--- [Test 1] Tool Registration & Schema Validation ---");
    const postTool = MCP_TOOLS.find(t => t.name === "post_proactive_agenda");
    const checkTool = MCP_TOOLS.find(t => t.name === "check_proactive_agenda");
    const resolveTool = MCP_TOOLS.find(t => t.name === "resolve_proactive_agenda");

    if (!postTool || !checkTool || !resolveTool) {
      throw new Error("❌ One or more proactive agenda tools are NOT registered in MCP_TOOLS!");
    }
    console.log("✅ All 3 proactive agenda tools registered in MCP_TOOLS");

    if (!postTool.inputSchema?.required?.includes("title") || !postTool.inputSchema?.required?.includes("content")) {
      throw new Error("❌ post_proactive_agenda schema missing required fields!");
    }
    if (!resolveTool.inputSchema?.required?.includes("agenda_id") || !resolveTool.inputSchema?.required?.includes("status")) {
      throw new Error("❌ resolve_proactive_agenda schema missing required fields!");
    }
    console.log("✅ Input schemas validated successfully");

    // -------------------------------------------------------------
    // Test 2: Initial Check - Empty Queue
    // -------------------------------------------------------------
    console.log("\n--- [Test 2] Check Proactive Agenda (Initial Empty Queue) ---");
    const initialCheck = await executeToolCall("check_proactive_agenda", {}, testUserId, env);
    console.log("Initial check response:", JSON.stringify(initialCheck));
    if (initialCheck.has_agenda !== false || initialCheck.total_count !== 0 || initialCheck.agendas.length !== 0) {
      throw new Error("❌ Expected empty queue for new user!");
    }
    console.log("✅ Initial check correctly returned has_agenda: false");

    // -------------------------------------------------------------
    // Test 3: Post Normal Agenda
    // -------------------------------------------------------------
    console.log("\n--- [Test 3] Post Normal Agenda ---");
    const post1 = await executeToolCall("post_proactive_agenda", {
      title: "待签合同提醒",
      content: "法务部发来了补充协议草案，需确认第二条款",
      urgent: false
    }, testUserId, env);
    console.log("Post 1 response:", JSON.stringify(post1));
    if (!post1.agenda_id || post1.status !== "pending" || post1.is_new !== true) {
      throw new Error("❌ Failed to post normal agenda");
    }
    createdAgendaIds.push(post1.agenda_id);
    console.log(`✅ Normal agenda created: ${post1.agenda_id}`);

    // -------------------------------------------------------------
    // Test 4: Post Urgent Agenda & Priority Sorting
    // -------------------------------------------------------------
    console.log("\n--- [Test 4] Post Urgent Agenda & Priority Sorting ---");
    const post2 = await executeToolCall("post_proactive_agenda", {
      title: "东航机票变动紧急确认",
      content: "10月18日航班提前至14:30起飞，需今晚前确认",
      urgent: true
    }, testUserId, env);
    console.log("Post 2 response:", JSON.stringify(post2));
    if (!post2.agenda_id || post2.status !== "pending") {
      throw new Error("❌ Failed to post urgent agenda");
    }
    createdAgendaIds.push(post2.agenda_id);

    // Now check queue: urgent item MUST be at index 0
    const checkAfterPost = await executeToolCall("check_proactive_agenda", {}, testUserId, env);
    console.log("Check after post count:", checkAfterPost.total_count);
    if (!checkAfterPost.has_agenda || checkAfterPost.total_count !== 2) {
      throw new Error(`❌ Expected 2 pending agendas, got ${checkAfterPost.total_count}`);
    }
    if (checkAfterPost.agendas[0].agenda_id !== post2.agenda_id) {
      throw new Error("❌ Urgent agenda was NOT sorted to the front!");
    }
    if (!checkAfterPost.agendas[0].urgent) {
      throw new Error("❌ First agenda item is missing urgent: true!");
    }
    console.log("✅ Urgent agenda correctly sorted first:", checkAfterPost.agendas[0].title);

    // -------------------------------------------------------------
    // Test 5: Dedup Key Merge / Idempotency
    // -------------------------------------------------------------
    console.log("\n--- [Test 5] Dedup Key Merge & Idempotency ---");
    const dedupKey = `msg_test_${Date.now()}`;
    const dedup1 = await executeToolCall("post_proactive_agenda", {
      title: "Fastmail巡检事项",
      content: "发件人: accounting@corp.com，主题: 9月账单初稿",
      dedup_key: dedupKey
    }, testUserId, env);
    console.log("Dedup 1 response:", JSON.stringify(dedup1));
    if (!dedup1.is_new || dedup1.dedup_action !== "created") {
      throw new Error("❌ Expected dedup1 to be created as new!");
    }
    createdAgendaIds.push(dedup1.agenda_id);

    // Re-post with same dedup_key but updated content
    const dedup2 = await executeToolCall("post_proactive_agenda", {
      title: "Fastmail巡检事项 (已更新)",
      content: "发件人: accounting@corp.com，主题: 9月账单终稿已上传",
      dedup_key: dedupKey,
      urgent: true
    }, testUserId, env);
    console.log("Dedup 2 response:", JSON.stringify(dedup2));
    if (dedup2.is_new !== false || dedup2.dedup_action !== "updated") {
      throw new Error("❌ Expected dedup2 to be merged and updated!");
    }
    if (dedup2.agenda_id !== dedup1.agenda_id) {
      throw new Error("❌ Expected same agenda_id for deduplicated post!");
    }

    // Verify in check_proactive_agenda
    const checkDedup = await executeToolCall("check_proactive_agenda", {}, testUserId, env);
    const updatedItem = checkDedup.agendas.find((a: any) => a.agenda_id === dedup1.agenda_id);
    if (!updatedItem || !updatedItem.title.includes("已更新") || !updatedItem.urgent) {
      throw new Error("❌ Deduplicated item did not reflect updated payload in check!");
    }
    console.log("✅ Dedup merge verified successfully, item updated in-place");

    // -------------------------------------------------------------
    // Test 6: Future schedule_after (Delayed Surfacing)
    // -------------------------------------------------------------
    console.log("\n--- [Test 6] Future schedule_after Filtering ---");
    const futureTime = new Date(Date.now() + 2 * 3600 * 1000).toISOString(); // +2 hours
    const futurePost = await executeToolCall("post_proactive_agenda", {
      title: "下午会议前提醒",
      content: "下午对齐前请确认PPT第三页数据",
      schedule_after: futureTime
    }, testUserId, env);
    createdAgendaIds.push(futurePost.agenda_id);

    const checkFuture = await executeToolCall("check_proactive_agenda", {}, testUserId, env);
    const foundFuture = checkFuture.agendas.some((a: any) => a.agenda_id === futurePost.agenda_id);
    if (foundFuture) {
      throw new Error("❌ Agenda with future schedule_after should NOT be surfaced!");
    }
    console.log("✅ Future schedule_after successfully hidden from immediate check");

    // -------------------------------------------------------------
    // Test 7: Resolve Agenda (status: 'done')
    // -------------------------------------------------------------
    console.log("\n--- [Test 7] Resolve Agenda (status: 'done') ---");
    const resolveDoneRes = await executeToolCall("resolve_proactive_agenda", {
      agenda_id: post1.agenda_id,
      status: "done",
      note: "用户已在会话中当场确认签署"
    }, testUserId, env);
    console.log("Resolve done response:", JSON.stringify(resolveDoneRes));
    if (resolveDoneRes.status !== "done") {
      throw new Error(`❌ Expected status='done', got ${resolveDoneRes.status}`);
    }

    // Verify it is no longer returned
    const checkAfterDone = await executeToolCall("check_proactive_agenda", {}, testUserId, env);
    const stillPresent = checkAfterDone.agendas.some((a: any) => a.agenda_id === post1.agenda_id);
    if (stillPresent) {
      throw new Error("❌ Resolved agenda is still appearing in check_proactive_agenda!");
    }
    console.log("✅ Agenda resolved and successfully removed from pending queue");

    // -------------------------------------------------------------
    // Test 8: Resolve Agenda (status: 'snooze')
    // -------------------------------------------------------------
    console.log("\n--- [Test 8] Resolve Agenda (status: 'snooze') ---");
    const snoozeUntil = new Date(Date.now() + 3600 * 1000).toISOString(); // +1 hour
    const snoozeRes = await executeToolCall("resolve_proactive_agenda", {
      agenda_id: post2.agenda_id,
      status: "snooze",
      snooze_until: snoozeUntil,
      note: "用户正在开会，要求1小时后提醒"
    }, testUserId, env);
    console.log("Snooze response:", JSON.stringify(snoozeRes));
    if (snoozeRes.status !== "snoozed") {
      throw new Error(`❌ Expected status='snoozed', got ${snoozeRes.status}`);
    }

    // Verify it is NOT returned because it is snoozed into the future
    const checkAfterSnooze = await executeToolCall("check_proactive_agenda", {}, testUserId, env);
    const snoozedSurfaced = checkAfterSnooze.agendas.some((a: any) => a.agenda_id === post2.agenda_id);
    if (snoozedSurfaced) {
      throw new Error("❌ Snoozed agenda is still appearing before snooze_until time!");
    }
    console.log("✅ Snoozed agenda successfully hidden until snooze_until");

    // -------------------------------------------------------------
    // Test 9: Negative Validation Tests
    // -------------------------------------------------------------
    console.log("\n--- [Test 9] Negative Validation Tests ---");
    let threw = false;
    try {
      await executeToolCall("post_proactive_agenda", { title: "" }, testUserId, env);
    } catch (e: any) {
      threw = true;
      console.log("✅ Caught expected error for empty title:", e.message);
    }
    if (!threw) throw new Error("❌ Expected validation error for empty title!");

    threw = false;
    try {
      await executeToolCall("resolve_proactive_agenda", {
        agenda_id: "non_existent_id",
        status: "done"
      }, testUserId, env);
    } catch (e: any) {
      threw = true;
      console.log("✅ Caught expected error for non-existent agenda:", e.message);
    }
    if (!threw) throw new Error("❌ Expected error when resolving non-existent agenda!");

    threw = false;
    try {
      await executeToolCall("resolve_proactive_agenda", {
        agenda_id: post2.agenda_id,
        status: "snooze"
        // missing snooze_until
      }, testUserId, env);
    } catch (e: any) {
      threw = true;
      console.log("✅ Caught expected error for missing snooze_until:", e.message);
    }
    if (!threw) throw new Error("❌ Expected error when snoozing without snooze_until!");

    // Clean up remaining test agenda items by resolving them as done
    for (const id of createdAgendaIds) {
      try {
        await executeToolCall("resolve_proactive_agenda", { agenda_id: id, status: "done" }, testUserId, env);
      } catch (_) {}
    }

    console.log("\n🎉 ALL 9 PROACTIVE AGENDA INTEGRATION TESTS PASSED PERFECTLY!");
  } catch (err: any) {
    console.error("\n❌ Test failed with error:", err);
    process.exit(1);
  }
}

run();
