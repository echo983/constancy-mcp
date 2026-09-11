/**
 * OAuth 2.1 / RFC 8414 / RFC 7591 Authentication Provider for Claude Connectors
 * Integrated with Cloudflare Access (Zero Trust) Email OTP
 */

export interface AuthEnv {
  DOMAIN: string;
  JWT_SECRET: string;
  CONSTANCY_KV: KVNamespace;
  ALLOWED_EMAILS?: string;
}

// 1. Helpers for base64url and HMAC-SHA256 JWT
function base64UrlEncode(str: string): string {
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(str: string): string {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  return atob(str);
}

async function hmacSha256(key: string, data: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(data));
  const binary = String.fromCharCode(...new Uint8Array(signature));
  return base64UrlEncode(binary);
}

export async function createJwt(payload: any, secret: string): Promise<string> {
  const header = { alg: "HS256", typ: "JWT" };
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signature = await hmacSha256(secret, `${encodedHeader}.${encodedPayload}`);
  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

export async function verifyJwt(token: string, secret: string): Promise<any | null> {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [header, payload, signature] = parts;
    const expectedSignature = await hmacSha256(secret, `${header}.${payload}`);
    if (signature !== expectedSignature) return null;

    const data = JSON.parse(base64UrlDecode(payload));
    if (data.exp && data.exp < Math.floor(Date.now() / 1000)) {
      return null; // Expired
    }
    return data;
  } catch {
    return null;
  }
}

// PKCE S256 verification
async function verifyPkce(codeVerifier: string, codeChallenge: string): Promise<boolean> {
  if (!codeChallenge) return true;
  const enc = new TextEncoder();
  const hash = await crypto.subtle.digest("SHA-256", enc.encode(codeVerifier));
  const binary = String.fromCharCode(...new Uint8Array(hash));
  const computed = base64UrlEncode(binary);
  return computed === codeChallenge;
}

// 2. Metadata Handlers
export function getProtectedResourceMetadata(domain: string) {
  return {
    resource: `https://${domain}`,
    authorization_servers: [`https://${domain}`],
    bearer_methods_supported: ["header"],
    scopes_supported: ["memory:read", "memory:write"],
    resource_documentation: `https://${domain}`
  };
}

export function getAuthorizationServerMetadata(domain: string) {
  return {
    issuer: `https://${domain}`,
    authorization_endpoint: `https://${domain}/oauth2/authorize`,
    token_endpoint: `https://${domain}/oauth2/token`,
    registration_endpoint: `https://${domain}/oauth2/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256", "plain"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"]
  };
}

// 3. Dynamic Client Registration (RFC 7591)
export async function handleRegister(request: Request, env: AuthEnv): Promise<Response> {
  const body: any = await request.json().catch(() => ({}));
  const clientId = "client_" + crypto.randomUUID().replace(/-/g, "");
  const clientSecret = "secret_" + crypto.randomUUID().replace(/-/g, "");

  const clientData = {
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uris: body.redirect_uris || [],
    client_name: body.client_name || "Claude Custom Connector",
    created_at: Date.now()
  };

  await env.CONSTANCY_KV.put(`client:${clientId}`, JSON.stringify(clientData));

  return new Response(JSON.stringify(clientData), {
    status: 201,
    headers: { "Content-Type": "application/json" }
  });
}

// 4. Authorization Endpoint (/oauth2/authorize)
export async function handleAuthorize(request: Request, env: AuthEnv): Promise<Response> {
  const url = new URL(request.url);
  const redirectUri = url.searchParams.get("redirect_uri");
  const state = url.searchParams.get("state") || "";
  const codeChallenge = url.searchParams.get("code_challenge") || "";
  const codeChallengeMethod = url.searchParams.get("code_challenge_method") || "S256";

  if (!redirectUri) {
    return new Response("Missing redirect_uri", { status: 400 });
  }

  // Check Cloudflare Access authenticated email header
  let userEmail = request.headers.get("cf-access-authenticated-user-email");

  // Fallback for direct browser testing or manual auth param
  if (!userEmail) {
    userEmail = url.searchParams.get("user") || url.searchParams.get("email");
  }

  // Whitelist Verification (Double Defense)
  if (userEmail && env.ALLOWED_EMAILS) {
    const whitelist = env.ALLOWED_EMAILS.split(",")
      .map(e => e.trim().toLowerCase())
      .filter(Boolean);
    if (!whitelist.includes(userEmail.toLowerCase().trim())) {
      return new Response(
        `<!DOCTYPE html><html><body style="font-family:sans-serif;background:#0f172a;color:#f87171;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;"><div style="background:#1e293b;padding:2rem;border-radius:1rem;max-width:400px;text-align:center;"><h2>❌ 403 访问受限</h2><p style="color:#94a3b8;">邮箱 <b>${userEmail}</b> 不在白名单授权列表中。</p></div></body></html>`,
        { status: 403, headers: { "Content-Type": "text/html; charset=utf-8" } }
      );
    }
  }

  const clientId = url.searchParams.get("client_id") || "";

  // If still not authenticated, show lightweight authorization confirmation screen
  if (!userEmail) {
    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Constancy MCP 授权确认</title>
  <style>
    body { font-family: -apple-system, sans-serif; background: #0f172a; color: #f8fafc; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
    .card { background: #1e293b; padding: 2.5rem; border-radius: 1rem; box-shadow: 0 10px 25px rgba(0,0,0,0.5); max-width: 420px; width: 90%; border: 1px solid #334155; }
    h2 { margin-top: 0; color: #38bdf8; display: flex; align-items: center; gap: 0.5rem; }
    p { color: #94a3b8; font-size: 0.95rem; line-height: 1.5; }
    input[type="email"] { width: 100%; padding: 0.75rem; border-radius: 0.5rem; border: 1px solid #475569; background: #0f172a; color: #fff; box-sizing: border-box; margin-bottom: 1.25rem; font-size: 1rem; }
    button { width: 100%; padding: 0.85rem; border-radius: 0.5rem; border: none; background: #38bdf8; color: #0f172a; font-weight: bold; font-size: 1rem; cursor: pointer; transition: background 0.2s; }
    button:hover { background: #7dd3fc; }
  </style>
</head>
<body>
  <div class="card">
    <h2>🧬 Constancy MCP</h2>
    <p>Claude 请求连接到您的<b>人基常热认知外脑 (ACTD)</b>。<br>请输入您绑定的管理员邮箱以完成单设备 1 年长效授权：</p>
    <form method="GET" action="/oauth2/authorize">
      <input type="hidden" name="client_id" value="${clientId}">
      <input type="hidden" name="redirect_uri" value="${redirectUri}">
      <input type="hidden" name="state" value="${state}">
      <input type="hidden" name="code_challenge" value="${codeChallenge}">
      <input type="hidden" name="code_challenge_method" value="${codeChallengeMethod}">
      <input type="email" name="user" placeholder="your-email@example.com" required autofocus>
      <button type="submit">授权连接 Claude (1 年免密)</button>
    </form>
  </div>
</body>
</html>`;
    return new Response(html, {
      headers: { "Content-Type": "text/html; charset=utf-8" }
    });
  }

  // Issue Authorization Code
  const code = "code_" + crypto.randomUUID().replace(/-/g, "");
  const codeData = {
    user_id: userEmail.toLowerCase().trim(),
    code_challenge: codeChallenge,
    code_challenge_method: codeChallengeMethod,
    redirect_uri: redirectUri
  };

  await env.CONSTANCY_KV.put(`auth_code:${code}`, JSON.stringify(codeData), {
    expirationTtl: 300 // 5 minutes
  });

  const targetUrl = new URL(redirectUri);
  targetUrl.searchParams.set("code", code);
  if (state) targetUrl.searchParams.set("state", state);

  return Response.redirect(targetUrl.toString(), 302);
}

// 5. Token Exchange (/oauth2/token)
export async function handleToken(request: Request, env: AuthEnv): Promise<Response> {
  let params: any = {};
  const contentType = request.headers.get("content-type") || "";

  if (contentType.includes("application/json")) {
    params = await request.json().catch(() => ({}));
  } else {
    const formData = await request.formData().catch(() => new FormData());
    for (const [key, value] of formData.entries()) {
      params[key] = value.toString();
    }
  }

  const grantType = params.grant_type;

  // Branch A: authorization_code exchange
  if (grantType === "authorization_code") {
    const code = params.code;
    const codeVerifier = params.code_verifier || "";

    if (!code) {
      return new Response(JSON.stringify({ error: "invalid_request", error_description: "Missing code" }), { status: 400 });
    }

    const codeRaw = await env.CONSTANCY_KV.get(`auth_code:${code}`);
    if (!codeRaw) {
      return new Response(JSON.stringify({ error: "invalid_grant", error_description: "Code expired or not found" }), { status: 400 });
    }

    // Single-use code
    await env.CONSTANCY_KV.delete(`auth_code:${code}`);
    const codeData = JSON.parse(codeRaw);

    // Verify PKCE
    if (codeData.code_challenge) {
      const valid = await verifyPkce(codeVerifier, codeData.code_challenge);
      if (!valid) {
        return new Response(JSON.stringify({ error: "invalid_grant", error_description: "PKCE verification failed" }), { status: 400 });
      }
    }

    const userId = codeData.user_id;

    // Issue 1-Year Access Token (31,536,000 seconds)
    const expiresIn = 31536000;
    const accessToken = await createJwt({
      sub: userId,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + expiresIn
    }, env.JWT_SECRET);

    // Issue Refresh Token
    const refreshToken = "rt_" + crypto.randomUUID().replace(/-/g, "");
    await env.CONSTANCY_KV.put(`refresh:${refreshToken}`, userId);

    return new Response(JSON.stringify({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: expiresIn,
      refresh_token: refreshToken
    }), {
      headers: { "Content-Type": "application/json" }
    });
  }

  // Branch B: refresh_token silent renewal
  if (grantType === "refresh_token") {
    const refreshToken = params.refresh_token;
    if (!refreshToken) {
      return new Response(JSON.stringify({ error: "invalid_request", error_description: "Missing refresh_token" }), { status: 400 });
    }

    const userId = await env.CONSTANCY_KV.get(`refresh:${refreshToken}`);
    if (!userId) {
      return new Response(JSON.stringify({ error: "invalid_grant", error_description: "Invalid refresh token" }), { status: 400 });
    }

    const expiresIn = 31536000;
    const newAccessToken = await createJwt({
      sub: userId,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + expiresIn
    }, env.JWT_SECRET);

    const newRefreshToken = "rt_" + crypto.randomUUID().replace(/-/g, "");
    await env.CONSTANCY_KV.delete(`refresh:${refreshToken}`);
    await env.CONSTANCY_KV.put(`refresh:${newRefreshToken}`, userId);

    return new Response(JSON.stringify({
      access_token: newAccessToken,
      token_type: "Bearer",
      expires_in: expiresIn,
      refresh_token: newRefreshToken
    }), {
      headers: { "Content-Type": "application/json" }
    });
  }

  return new Response(JSON.stringify({ error: "unsupported_grant_type" }), { status: 400 });
}

// 6. Token Verification Middleware
export async function authenticateRequest(request: Request, env: AuthEnv): Promise<string | null> {
  const authHeader = request.headers.get("authorization") || "";
  let token = "";

  if (authHeader.startsWith("Bearer ")) {
    token = authHeader.substring(7).trim();
  } else {
    const url = new URL(request.url);
    token = url.searchParams.get("token") || url.searchParams.get("key") || "";
  }

  if (!token) return null;

  const payload = await verifyJwt(token, env.JWT_SECRET);
  if (!payload || !payload.sub) return null;

  return payload.sub as string;
}
