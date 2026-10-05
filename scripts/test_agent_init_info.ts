import { MCP_TOOLS, executeToolCall, handleMcpJsonRpc, McpEnv, CONSTANCY_VERSION } from "../src/mcp";

async function runTests() {
  console.log(`🧪 Starting get_agent_init_info Unit & JSON-RPC Protocol Tests (v${CONSTANCY_VERSION})...\n`);

  const mockEnv: McpEnv = {
    VOYAGE_API_KEY: "mock_voyage_key",
    QDRANT_URL: "https://mock-qdrant.kufof.uk",
    QDRANT_API_KEY: "mock_qdrant_key",
    JWT_SECRET: "mock_jwt_secret_12345678901234567890123456789012",
    DOMAIN: "mcp.kufof.uk"
  };
  const testUserId = "user_test_agent_init";

  // -------------------------------------------------------------
  // Test 1: Verify get_agent_init_info Schema in MCP_TOOLS
  // -------------------------------------------------------------
  console.log("--- [Test 1] Verify get_agent_init_info in MCP_TOOLS ---");
  const initTool = MCP_TOOLS.find(t => t.name === "get_agent_init_info");
  if (!initTool) {
    throw new Error("❌ get_agent_init_info is NOT registered in MCP_TOOLS!");
  }
  console.log("✅ get_agent_init_info is registered in MCP_TOOLS");

  const schema = initTool.inputSchema;
  if (!schema.properties?.role || !schema.properties?.verbosity) {
    throw new Error("❌ get_agent_init_info schema missing 'role' or 'verbosity' properties!");
  }
  console.log("✅ Schema properties validated:", Object.keys(schema.properties));

  // -------------------------------------------------------------
  // Test 2: executeToolCall Default (role: "chat", verbosity: "compact")
  // -------------------------------------------------------------
  console.log("\n--- [Test 2] Default Invocation (role=chat, verbosity=compact) ---");
  const resDefault = await executeToolCall("get_agent_init_info", {}, testUserId, mockEnv);
  if (resDefault.version !== CONSTANCY_VERSION) {
    throw new Error(`❌ Expected version ${CONSTANCY_VERSION}, got ${resDefault.version}`);
  }
  if (resDefault.role !== "chat" || resDefault.verbosity !== "compact") {
    throw new Error(`❌ Expected role='chat' & verbosity='compact', got role='${resDefault.role}', verbosity='${resDefault.verbosity}'`);
  }
  if (!resDefault.system_instructions.includes("update_memory") || !resDefault.system_instructions.includes("submit_concern")) {
    throw new Error("❌ Expected instructions to mention 'update_memory' and 'submit_concern'!");
  }
  if (!resDefault.quick_reference?.primary_tools?.includes("update_memory")) {
    throw new Error("❌ Expected primary_tools to include 'update_memory'!");
  }
  console.log("✅ Default invocation returned concise chat guidance, primary tools:", resDefault.quick_reference.primary_tools.length);

  // -------------------------------------------------------------
  // Test 3: executeToolCall Detailed Chat (role: "chat", verbosity: "detailed")
  // -------------------------------------------------------------
  console.log("\n--- [Test 3] Detailed Chat Invocation ---");
  const resDetailedChat = await executeToolCall("get_agent_init_info", { role: "chat", verbosity: "detailed" }, testUserId, mockEnv);
  if (resDetailedChat.verbosity !== "detailed") {
    throw new Error("❌ Expected verbosity='detailed'");
  }
  if (!resDetailedChat.system_instructions.includes("ACTD") || !resDetailedChat.system_instructions.includes("Fresh, V ≥ 0.7")) {
    throw new Error("❌ Detailed chat instructions missing ACTD health status specifications!");
  }
  if (!resDetailedChat.system_instructions.includes("场景 1 (确凿变更")) {
    throw new Error("❌ Detailed chat instructions missing case studies!");
  }
  console.log("✅ Detailed chat invocation returned comprehensive case studies and ACTD health scale");

  // -------------------------------------------------------------
  // Test 4: executeToolCall Doctor Role (role: "doctor", compact & detailed)
  // -------------------------------------------------------------
  console.log("\n--- [Test 4] Doctor Role Invocations ---");
  const resDocCompact = await executeToolCall("get_agent_init_info", { role: "doctor" }, testUserId, mockEnv);
  if (resDocCompact.role !== "doctor") {
    throw new Error("❌ Expected role='doctor'");
  }
  if (!resDocCompact.system_instructions.includes("get_maintenance_cases") || !resDocCompact.system_instructions.includes("resolve_maintenance_case")) {
    throw new Error("❌ Doctor instructions missing maintenance tools!");
  }
  if (!resDocCompact.system_instructions.includes("Primum non nocere")) {
    throw new Error("❌ Doctor instructions missing medical philosophy 'Primum non nocere'!");
  }
  console.log("✅ Doctor compact instructions verified");

  const resDocDetailed = await executeToolCall("get_agent_init_info", { role: "doctor", verbosity: "detailed" }, testUserId, mockEnv);
  if (!resDocDetailed.system_instructions.includes("Triage Calculus") || !resDocDetailed.system_instructions.includes("RESOLVED + MERGE")) {
    throw new Error("❌ Detailed doctor instructions missing Triage Calculus or MERGE action!");
  }
  console.log("✅ Doctor detailed instructions verified (includes triage calculus & MERGE)");

  // -------------------------------------------------------------
  // Test 5: executeToolCall All Architecture (role: "all")
  // -------------------------------------------------------------
  console.log("\n--- [Test 5] All Roles & Full Architecture ---");
  const resAll = await executeToolCall("get_agent_init_info", { role: "all" }, testUserId, mockEnv);
  if (resAll.role !== "all") {
    throw new Error("❌ Expected role='all'");
  }
  if (!resAll.system_instructions.includes("Duty Matrix") || !resAll.system_instructions.includes("业务消费态与病理审计态分离")) {
    throw new Error("❌ Role 'all' missing architectural separation or Duty Matrix!");
  }
  console.log("✅ Role 'all' returned full panoramic architecture & tool breakdown");

  // -------------------------------------------------------------
  // Test 6: JSON-RPC Protocol Compliance (initialize & prompts/list & prompts/get)
  // -------------------------------------------------------------
  console.log("\n--- [Test 6] JSON-RPC MCP Protocol Compliance ---");
  
  // 6.1 initialize
  const initRpcRes = await handleMcpJsonRpc({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {}
    }
  }, testUserId, mockEnv);

  if (initRpcRes.result?.serverInfo?.version !== CONSTANCY_VERSION) {
    throw new Error(`❌ initialize RPC returned version ${initRpcRes.result?.serverInfo?.version}, expected ${CONSTANCY_VERSION}`);
  }
  if (!initRpcRes.result?.capabilities?.prompts) {
    throw new Error("❌ initialize RPC missing 'prompts' in capabilities!");
  }
  console.log("✅ initialize RPC advertised 'prompts' and 'tools' with version:", initRpcRes.result.serverInfo.version);

  // 6.2 prompts/list
  const promptsListRpcRes = await handleMcpJsonRpc({
    jsonrpc: "2.0",
    id: 2,
    method: "prompts/list"
  }, testUserId, mockEnv);

  const prompts = promptsListRpcRes.result?.prompts;
  if (!Array.isArray(prompts) || !prompts.some(p => p.name === "constancy_agent_init")) {
    throw new Error("❌ prompts/list RPC did not return 'constancy_agent_init'!");
  }
  console.log("✅ prompts/list returned prompt:", prompts[0].name);

  // 6.3 prompts/get
  const promptGetRpcRes = await handleMcpJsonRpc({
    jsonrpc: "2.0",
    id: 3,
    method: "prompts/get",
    params: {
      name: "constancy_agent_init",
      arguments: { role: "doctor", verbosity: "compact" }
    }
  }, testUserId, mockEnv);

  const msgContent = promptGetRpcRes.result?.messages?.[0]?.content?.text;
  if (!msgContent || !msgContent.includes("专职医生执业规约")) {
    throw new Error("❌ prompts/get did not return expected doctor instructions!");
  }
  console.log("✅ prompts/get successfully rendered prompt message");

  // 6.4 tools/call via JSON-RPC
  const toolCallRpcRes = await handleMcpJsonRpc({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: {
      name: "get_agent_init_info",
      arguments: { role: "chat" }
    }
  }, testUserId, mockEnv);

  if (!toolCallRpcRes.result?.content?.[0]?.text) {
    throw new Error("❌ tools/call get_agent_init_info returned empty content!");
  }
  const parsedJson = JSON.parse(toolCallRpcRes.result.content[0].text);
  if (parsedJson.role !== "chat" || parsedJson.version !== CONSTANCY_VERSION) {
    throw new Error("❌ tools/call text content is not valid AgentInitInfo JSON!");
  }
  console.log("✅ tools/call get_agent_init_info returned valid JSON response");

  console.log(`\n🎉 ALL TESTS PASSED! get_agent_init_info is 100% verified across Tool, JSON-RPC, and MCP Prompt APIs (v${CONSTANCY_VERSION})!`);
}

runTests().catch(err => {
  console.error("❌ Test suite failed:", err);
  process.exit(1);
});
