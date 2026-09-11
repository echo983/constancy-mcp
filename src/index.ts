/**
 * Constancy MCP Cloudflare Worker Entry Point
 * Protocol Support: Streamable HTTP (/mcp) + SSE (/sse) + OAuth 2.1 (RFC 8414 / RFC 7591)
 */

import {
  AuthEnv,
  getProtectedResourceMetadata,
  getAuthorizationServerMetadata,
  handleRegister,
  handleAuthorize,
  handleToken,
  authenticateRequest
} from "./auth";
import { handleMcpJsonRpc, McpEnv } from "./mcp";
import { handleBlobRequest } from "./blob";

export interface Env extends AuthEnv, McpEnv {
  QDRANT_API_KEY: string;
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id"
};

function jsonResponse(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...CORS_HEADERS
    }
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const domain = env.DOMAIN || url.host;

    // Handle OPTIONS Preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // 1. OAuth Metadata Discovery (RFC 8414 / RFC 9207)
    if (url.pathname === "/.well-known/oauth-protected-resource") {
      return jsonResponse(getProtectedResourceMetadata(domain));
    }
    if (
      url.pathname === "/.well-known/oauth-authorization-server" ||
      url.pathname === "/.well-known/openid-configuration"
    ) {
      return jsonResponse(getAuthorizationServerMetadata(domain));
    }

    // 2. OAuth Endpoints
    if (url.pathname === "/oauth2/register" && request.method === "POST") {
      return handleRegister(request, env);
    }
    if (url.pathname === "/oauth2/authorize" && (request.method === "GET" || request.method === "POST")) {
      return handleAuthorize(request, env);
    }
    if (url.pathname === "/oauth2/token" && request.method === "POST") {
      return handleToken(request, env);
    }

    // 3. MCP Streamable HTTP Transport (/mcp) - Recommended by Anthropic
    if (url.pathname === "/mcp") {
      // Authenticate
      const userId = await authenticateRequest(request, env);
      if (!userId) {
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: {
            "Content-Type": "application/json",
            "WWW-Authenticate": `Bearer realm="https://${domain}", resource_metadata="https://${domain}/.well-known/oauth-protected-resource"`,
            ...CORS_HEADERS
          }
        });
      }

      if (request.method === "POST") {
        const body: any = await request.json().catch(() => ({}));
        const responseJson = await handleMcpJsonRpc(body, userId, env, ctx);
        if (!responseJson) {
          return new Response(null, { status: 204, headers: CORS_HEADERS });
        }
        return jsonResponse(responseJson);
      }

      // GET /mcp probe
      return jsonResponse({
        status: "ok",
        transport: "Streamable HTTP",
        authenticated_user: userId
      });
    }

    // 4. Legacy SSE Transport (/sse and /message)
    if (url.pathname === "/sse" && request.method === "GET") {
      const userId = await authenticateRequest(request, env);
      if (!userId) {
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: {
            "Content-Type": "application/json",
            "WWW-Authenticate": `Bearer realm="https://${domain}"`,
            ...CORS_HEADERS
          }
        });
      }

      const sessionId = crypto.randomUUID();
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const encoder = new TextEncoder();

      // Write initial endpoint event
      const endpointData = `event: endpoint\ndata: /message?sessionId=${sessionId}\n\n`;
      writer.write(encoder.encode(endpointData));

      // Keep-alive heartbeat every 25s
      const timer = setInterval(() => {
        writer.write(encoder.encode(`: keepalive\n\n`)).catch(() => clearInterval(timer));
      }, 25000);

      return new Response(readable, {
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
          ...CORS_HEADERS
        }
      });
    }

    if (url.pathname === "/message" && request.method === "POST") {
      const userId = await authenticateRequest(request, env);
      if (!userId) {
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: CORS_HEADERS
        });
      }

      const body: any = await request.json().catch(() => ({}));
      const responseJson = await handleMcpJsonRpc(body, userId, env, ctx);
      return jsonResponse(responseJson || {});
    }

    // 5. Binary Capability Transfer Endpoints (/blob/:id)
    if (url.pathname.startsWith("/blob/")) {
      const blobId = url.pathname.slice("/blob/".length);
      return handleBlobRequest(request, blobId, env);
    }

    // 6. System Health Check (/api/health)
    if (url.pathname === "/api/health") {
      return jsonResponse({
        status: "healthy",
        version: "1.4.0",
        domain,
        time: new Date().toISOString(),
        qdrant_target: env.QDRANT_URL
      });
    }

    // 7. Web UI Dashboard & Discovery Root (/)
    if (url.pathname === "/" || url.pathname === "/index.html") {
      const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>🧬 Constancy MCP Server (ACTD v1.0)</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: #0f172a; color: #f8fafc; padding: 2rem; line-height: 1.6; }
    .card { max-width: 800px; margin: 0 auto; background: #1e293b; padding: 2.5rem; border-radius: 1rem; box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.3); border: 1px solid #334155; }
    h1 { color: #38bdf8; margin-top: 0; font-size: 1.8rem; display: flex; align-items: center; gap: 0.5rem; }
    .badge { background: #0284c7; color: white; font-size: 0.8rem; padding: 0.2rem 0.6rem; border-radius: 9999px; }
    .status-ok { color: #4ade80; font-weight: 600; }
    .box { background: #0f172a; padding: 1rem 1.25rem; border-radius: 0.5rem; border-left: 4px solid #38bdf8; font-family: monospace; font-size: 0.9rem; margin: 1.5rem 0; overflow-x: auto; }
    a { color: #38bdf8; text-decoration: none; }
    a:hover { text-decoration: underline; }
    ul { padding-left: 1.5rem; }
    li { margin-bottom: 0.75rem; color: #cbd5e1; }
    b { color: #f1f5f9; }
  </style>
</head>
<body>
  <div class="card">
    <h1>🧬 Constancy MCP Server <span class="badge">ACTD v1.0</span></h1>
    <p>基于<b>人基常热动力学（Anthropocentric Chrono-Thermal Dynamics）</b>的数字海马体记忆外脑。支持“主动记、自动忘、懂分寸、读空气”，基于 <code>Voyage-Multimodal-3.5</code> 统一度量衡实现图文同构检索。</p>
    
    <p>运行状态：<span class="status-ok">● 正常运行 (Online)</span> | 域名：<code>${domain}</code></p>

    <h3>Claude Custom Connector 配置地址</h3>
    <div class="box">
      <pre>https://${domain}/mcp (Streamable HTTP)
https://${domain}/sse (Legacy SSE)</pre>
    </div>

    <h3>内置核心工具 (15 Tools)</h3>
    <ul>
      <li><b>log_memory / search_memory</b>: 认知来源定性、待办/决策硬门禁拦截、时空结构化过滤、多模态检索与 ACTD 时效仲裁</li>
      <li><b>confirm_memory / retire_memory / annotate_memory</b>: 强信号复核加温、墓碑失效归档与非破坏性不可变勘误注记（保证因果可证伪性）</li>
      <li><b>save_note / get_note / list_notes / update_note</b>: 极简便签记事本、标签枚举待办与多版本修订审计</li>
      <li><b>get_blob_url / create_upload_url</b>: 便签二进制 Capability 直传直下，沙箱零 Token 传输二进制</li>
      <li><b>request_image_upload / commit_image_record</b>: 高画质多模态图片直传流水线、EXIF 时空元数据与视觉特征向量入库</li>
      <li><b>get_daily_timeline</b>: 提取某日时间线碎片，供大模型生成每日研发日记（DevLog）</li>
      <li><b>upsert_entity</b>: 维护跨周期核心实体百科清单（百年基石级 C_H ≥ 11）</li>
    </ul>

    <p style="margin-top: 2rem; font-size: 0.85rem; color: #64748b; text-align: center;">
      开源协议：MIT | 架构源码：<a href="https://github.com/echo983/constancy-mcp" target="_blank">echo983/constancy-mcp</a>
    </p>
  </div>
</body>
</html>`;
      return new Response(html, {
        headers: { "Content-Type": "text/html; charset=utf-8" }
      });
    }

    return new Response("Not Found", { status: 404 });
  }
};
