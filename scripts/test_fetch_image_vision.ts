import fs from "fs";
import { handleMcpJsonRpc, executeToolCall, McpEnv, MCP_TOOLS } from "../src/mcp";
import { upsertMemoryPoint, deleteMemoryPoints } from "../src/qdrant";

async function run() {
  console.log("🚀 Starting fetch_image_vision Comprehensive Test Suite...\n");

  const qdrantKey = fs.readFileSync("/home/edwin/ramws/any/secret/Qdrant-api-key@vec.kufof.uk.txt", "utf-8").trim();
  const voyageKey = fs.readFileSync("/home/edwin/ramws/any/secret/Voyageai-api-key@vec.kufof.uk.txt", "utf-8").trim();

  const testUserId = `test_vision_${Date.now()}`;
  const pointsToDelete: string[] = [];

  const env: McpEnv = {
    QDRANT_URL: "https://vec.kufof.uk",
    QDRANT_API_KEY: qdrantKey,
    VOYAGE_API_KEY: voyageKey,
    JWT_SECRET: "test-secret-key-123",
    DOMAIN: "mcp.kufof.uk"
  };

  try {
    // -------------------------------------------------------------
    // Test 1: MCP initialize protocol version & serverInfo
    // -------------------------------------------------------------
    console.log("--- [Test 1] MCP initialize & version check ---");
    const initRes = await handleMcpJsonRpc({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {}
    }, testUserId, env);

    if (!initRes.result?.serverInfo?.version?.startsWith("1.6.")) {
      throw new Error(`Expected serverInfo.version to be 1.6.x, got: ${initRes.result?.serverInfo?.version}`);
    }
    console.log(`✅ Initialize response validated: version ${initRes.result?.serverInfo?.version}`);

    // -------------------------------------------------------------
    // Test 2: MCP tools/list includes fetch_image_vision with guardrails
    // -------------------------------------------------------------
    console.log("\n--- [Test 2] MCP tools/list declaration & guardrail schema ---");
    const listRes = await handleMcpJsonRpc({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {}
    }, testUserId, env);

    const tools = listRes.result?.tools || [];
    const visionTool = tools.find((t: any) => t.name === "fetch_image_vision");
    if (!visionTool) {
      throw new Error("fetch_image_vision tool not found in tools/list");
    }

    const variantEnum = visionTool.inputSchema?.properties?.variant?.enum || [];
    if (variantEnum.includes("public")) {
      throw new Error("CRITICAL FAILURE: 'public' variant found in fetch_image_vision schema! Must be banned.");
    }
    if (!variantEnum.includes("ai512") || !variantEnum.includes("ai768") || !variantEnum.includes("ai1024")) {
      throw new Error(`Expected ['ai512', 'ai768', 'ai1024'] in variant enum, got: ${JSON.stringify(variantEnum)}`);
    }
    console.log("✅ fetch_image_vision declared correctly: 'public' banned, variants:", variantEnum);

    // -------------------------------------------------------------
    // Test 3: Input validation & negative tests
    // -------------------------------------------------------------
    console.log("\n--- [Test 3] Negative validation tests ---");

    // 3A: Missing id
    const missingIdRes = await handleMcpJsonRpc({
      jsonrpc: "2.0",
      id: 301,
      method: "tools/call",
      params: { name: "fetch_image_vision", arguments: {} }
    }, testUserId, env);
    if (!missingIdRes.isError && !missingIdRes.result?.isError) {
      throw new Error("Expected missing id to return error");
    }
    console.log("✅ Caught expected error on missing id:", missingIdRes.result?.content?.[0]?.text);

    // 3B: Illegal variant 'public'
    const publicVariantRes = await handleMcpJsonRpc({
      jsonrpc: "2.0",
      id: 302,
      method: "tools/call",
      params: { name: "fetch_image_vision", arguments: { id: "test-id-1234", variant: "public" } }
    }, testUserId, env);
    if (!publicVariantRes.isError && !publicVariantRes.result?.isError) {
      throw new Error("Expected variant 'public' to return error");
    }
    console.log("✅ Caught expected error on 'public' variant rejection:", publicVariantRes.result?.content?.[0]?.text);

    // 3C: Malformed id with injection attempt
    const malformedIdRes = await handleMcpJsonRpc({
      jsonrpc: "2.0",
      id: 303,
      method: "tools/call",
      params: { name: "fetch_image_vision", arguments: { id: "bad/path/../injection;rm -rf" } }
    }, testUserId, env);
    if (!malformedIdRes.isError && !malformedIdRes.result?.isError) {
      throw new Error("Expected malformed id to return error");
    }
    console.log("✅ Caught expected error on malformed id:", malformedIdRes.result?.content?.[0]?.text);

    // -------------------------------------------------------------
    // Test 4: Note with pure text (no image) returns clean error
    // -------------------------------------------------------------
    console.log("\n--- [Test 4] Note without image error test ---");
    const textNoteId = crypto.randomUUID();
    pointsToDelete.push(textNoteId);
    await upsertMemoryPoint(textNoteId, new Array(1024).fill(0.01), {
      user_id: testUserId,
      title: "纯文本便签备忘",
      content: "这是一份普通的采购清单，没有任何图片附件或关联图片。",
      type: "note",
      tags: ["shopping", "todo"],
      ch_prior: 8.8,
      h_spectrum: [1, 0, 0, 0, 0, 0, 0],
      t_last_update: Date.now(),
      t_last_strong: Date.now()
    }, env);

    const noImgRes = await handleMcpJsonRpc({
      jsonrpc: "2.0",
      id: 401,
      method: "tools/call",
      params: { name: "fetch_image_vision", arguments: { id: textNoteId } }
    }, testUserId, env);
    if (!noImgRes.isError && !noImgRes.result?.isError) {
      throw new Error("Expected note without image to return error");
    }
    console.log("✅ Caught expected error for note without image:", noImgRes.result?.content?.[0]?.text);

    // -------------------------------------------------------------
    // Test 5: Note with native Base64 image attachment (Zero-network branch)
    // -------------------------------------------------------------
    console.log("\n--- [Test 5] Note with native Base64 image attachment ---");
    // 1x1 transparent PNG in base64
    const samplePngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const base64NoteId = crypto.randomUUID();
    pointsToDelete.push(base64NoteId);

    await upsertMemoryPoint(base64NoteId, new Array(1024).fill(0.01), {
      user_id: testUserId,
      title: "网络拓扑架构图截图",
      content: "系统核心网络拓扑结构抓图",
      type: "note",
      tags: ["network", "diagram"],
      ch_prior: 11.0,
      h_spectrum: [1, 0, 0, 0, 0, 0, 0],
      t_last_update: Date.now(),
      t_last_strong: Date.now(),
      base64: samplePngBase64,
      mime_type: "image/png",
      created_at: new Date().toISOString()
    }, env);

    // 5A: Call with include_metadata: true (default)
    const visionWithMeta = await handleMcpJsonRpc({
      jsonrpc: "2.0",
      id: 501,
      method: "tools/call",
      params: { name: "fetch_image_vision", arguments: { id: base64NoteId, include_metadata: true } }
    }, testUserId, env);

    if (!visionWithMeta.result || !Array.isArray(visionWithMeta.result.content)) {
      throw new Error("Expected result.content to be array");
    }
    const content = visionWithMeta.result.content;
    if (content.length !== 2) {
      throw new Error(`Expected 2 content blocks (text + image), got: ${content.length}`);
    }
    if (content[0].type !== "text" || !content[0].text.includes("网络拓扑架构图截图")) {
      throw new Error("Expected first block to be metadata text with title");
    }
    if (content[1].type !== "image" || content[1].data !== samplePngBase64 || content[1].mimeType !== "image/png") {
      throw new Error("Expected second block to be image block with exact base64 data and mimeType");
    }
    console.log("✅ Native base64 note parsed successfully with metadata text block + ImageContent block");

    // 5B: Call with include_metadata: false (pure image block)
    const visionNoMeta = await handleMcpJsonRpc({
      jsonrpc: "2.0",
      id: 502,
      method: "tools/call",
      params: { name: "fetch_image_vision", arguments: { id: base64NoteId, include_metadata: false } }
    }, testUserId, env);

    const noMetaContent = visionNoMeta.result?.content || [];
    if (noMetaContent.length !== 1 || noMetaContent[0].type !== "image") {
      throw new Error(`Expected exactly 1 image block when include_metadata: false, got: ${JSON.stringify(noMetaContent)}`);
    }
    console.log("✅ include_metadata: false returned exactly 1 ImageContent block without metadata text");

    // -------------------------------------------------------------
    // Test 6: Cloudflare Images signed fetch simulation with guardrails
    // -------------------------------------------------------------
    console.log("\n--- [Test 6] Cloudflare Images fetch & guardrails simulation ---");

    // Test 6A: Mock HTTP server / response providing a test image
    const mockImageId = "test-cf-image-uuid-9999";
    const mockEnvWithImages: McpEnv = {
      ...env,
      IMAGES: {
        hosted: {
          image: (id: string) => ({
            signedUrl: async ({ variant }: { variant: string }) => {
              // Return a data URL or mock accessible URL
              return `https://mock-image-server.internal/${id}/${variant}`;
            }
          })
        }
      }
    };

    // Replace global fetch temporarily to intercept mock URL
    const originalFetch = globalThis.fetch;
    try {
      (globalThis as any).fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const urlStr = typeof input === "string" ? input : input.toString();

        if (urlStr.includes("mock-image-server.internal")) {
          // Check Accept header
          const accept = (init?.headers as any)?.["Accept"] || (init?.headers as any)?.["accept"];
          if (!accept || accept.includes("image/avif")) {
            throw new Error(`CRITICAL: Accept header leaked or included AVIF! Headers: ${JSON.stringify(init?.headers)}`);
          }

          // Return valid JPEG image
          const testBuffer = Buffer.from(samplePngBase64, "base64");
          return new Response(testBuffer, {
            status: 200,
            headers: {
              "Content-Type": "image/jpeg",
              "Content-Length": testBuffer.byteLength.toString()
            }
          });
        }

        return originalFetch(input, init);
      };

      const cfRes = await handleMcpJsonRpc({
        jsonrpc: "2.0",
        id: 601,
        method: "tools/call",
        params: {
          name: "fetch_image_vision",
          arguments: { id: mockImageId, variant: "ai768" }
        }
      }, testUserId, mockEnvWithImages);

      if (!cfRes.result?.content || cfRes.result.content.length < 2) {
        throw new Error(`Expected valid multi-block result from mock Cloudflare Images, got: ${JSON.stringify(cfRes)}`);
      }
      const imgBlock = cfRes.result.content.find((b: any) => b.type === "image");
      if (!imgBlock || imgBlock.mimeType !== "image/jpeg" || !imgBlock.data) {
        throw new Error(`Failed to decode mock image block: ${JSON.stringify(imgBlock)}`);
      }
      console.log("✅ Cloudflare Images fetch succeeded: Accept header verified, ImageContent produced");

      // Test 6B: AVIF rejection guardrail
      (globalThis as any).fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const urlStr = typeof input === "string" ? input : input.toString();
        if (urlStr.includes("mock-image-server.internal")) {
          return new Response(Buffer.from("fake-avif"), {
            status: 200,
            headers: { "Content-Type": "image/avif" }
          });
        }
        return originalFetch(input, init);
      };

      const avifRes = await handleMcpJsonRpc({
        jsonrpc: "2.0",
        id: 602,
        method: "tools/call",
        params: { name: "fetch_image_vision", arguments: { id: mockImageId, variant: "ai768" } }
      }, testUserId, mockEnvWithImages);

      if (!avifRes.isError && !avifRes.result?.isError) {
        throw new Error("Expected AVIF response to be rejected with error");
      }
      console.log("✅ AVIF defense triggered successfully:", avifRes.result?.content?.[0]?.text);

      // Test 6C: 3MB limit guardrail
      (globalThis as any).fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const urlStr = typeof input === "string" ? input : input.toString();
        if (urlStr.includes("mock-image-server.internal")) {
          return new Response(new Uint8Array(4 * 1024 * 1024), {
            status: 200,
            headers: { "Content-Type": "image/jpeg", "Content-Length": (4 * 1024 * 1024).toString() }
          });
        }
        return originalFetch(input, init);
      };

      const bigRes = await handleMcpJsonRpc({
        jsonrpc: "2.0",
        id: 603,
        method: "tools/call",
        params: { name: "fetch_image_vision", arguments: { id: mockImageId, variant: "ai1024" } }
      }, testUserId, mockEnvWithImages);

      if (!bigRes.isError && !bigRes.result?.isError) {
        throw new Error("Expected >3MB image to be rejected with error");
      }
      console.log("✅ 3MB cap defense triggered successfully:", bigRes.result?.content?.[0]?.text);

    } finally {
      globalThis.fetch = originalFetch;
    }

    // -------------------------------------------------------------
    // Test 7: Regression test for existing tools
    // -------------------------------------------------------------
    console.log("\n--- [Test 7] Regression test for existing tools ---");
    const pingRes = await handleMcpJsonRpc({
      jsonrpc: "2.0",
      id: 701,
      method: "ping"
    }, testUserId, env);
    if (!pingRes.result) throw new Error("ping failed");

    const blobUrlRes = await handleMcpJsonRpc({
      jsonrpc: "2.0",
      id: 702,
      method: "tools/call",
      params: { name: "get_blob_url", arguments: { id: base64NoteId } }
    }, testUserId, env);

    if (blobUrlRes.isError) {
      throw new Error(`get_blob_url regression failed: ${JSON.stringify(blobUrlRes)}`);
    }
    const blobText = blobUrlRes.result?.content?.[0]?.text || "";
    const parsedBlob = JSON.parse(blobText);
    if (!parsedBlob.download_url || !parsedBlob.download_url.includes("/blob/")) {
      throw new Error(`get_blob_url did not return valid download_url: ${blobText}`);
    }
    console.log("✅ get_blob_url regression check passed: returned valid download_url");

    console.log("\n🎉 ALL 7 TESTS PASSED PERFECTLY!");
  } finally {
    // Cleanup created points
    if (pointsToDelete.length > 0) {
      console.log(`\n🧹 Cleaning up ${pointsToDelete.length} test points...`);
      await deleteMemoryPoints(pointsToDelete, env).catch(err => {
        console.warn("Cleanup warning:", err.message);
      });
      console.log("✅ Cleanup completed.");
    }
  }
}

run().catch(err => {
  console.error("\n❌ Test Suite Failed with Error:", err);
  process.exit(1);
});
