/**
 * OAuth 2.1 / RFC 8414 / RFC 7591 Authentication Provider for Claude Connectors
 * Integrated with Cloudflare Access (Zero Trust) Email OTP
 */

export interface AuthEnv {
  DOMAIN: string;
  JWT_SECRET: string;
  CONSTANCY_KV: KVNamespace;
  ALLOWED_EMAILS?: string;
  ADMIN_PASSKEY?: string;
}

// 1. Helpers for base64url, HMAC-SHA256 JWT, and HTML escaping
function escapeHtml(str: string | null | undefined): string {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

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

// PKCE S256 verification (OAuth 2.1 strictly requires non-empty PKCE)
async function verifyPkce(codeVerifier: string, codeChallenge: string): Promise<boolean> {
  if (!codeVerifier || !codeChallenge) return false;
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
    code_challenge_methods_supported: ["S256"],
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

  let redirectUri = url.searchParams.get("redirect_uri") || "";
  let state = url.searchParams.get("state") || "";
  let codeChallenge = url.searchParams.get("code_challenge") || "";
  let codeChallengeMethod = url.searchParams.get("code_challenge_method") || "S256";
  let clientId = url.searchParams.get("client_id") || "";
  let submittedEmail = "";
  let submittedPasskey = "";
  let isPostSubmission = false;

  if (request.method === "POST") {
    isPostSubmission = true;
    const contentType = request.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const body: any = await request.json().catch(() => ({}));
      submittedEmail = (body.email || body.user || "").trim().toLowerCase();
      submittedPasskey = (body.passkey || "").trim();
      if (body.redirect_uri) redirectUri = body.redirect_uri;
      if (body.state) state = body.state;
      if (body.code_challenge) codeChallenge = body.code_challenge;
      if (body.code_challenge_method) codeChallengeMethod = body.code_challenge_method;
      if (body.client_id) clientId = body.client_id;
    } else {
      const formData = await request.formData().catch(() => new FormData());
      submittedEmail = (formData.get("email") || formData.get("user") || "").toString().trim().toLowerCase();
      submittedPasskey = (formData.get("passkey") || "").toString().trim();
      if (formData.get("redirect_uri")) redirectUri = formData.get("redirect_uri")!.toString();
      if (formData.get("state")) state = formData.get("state")!.toString();
      if (formData.get("code_challenge")) codeChallenge = formData.get("code_challenge")!.toString();
      if (formData.get("code_challenge_method")) codeChallengeMethod = formData.get("code_challenge_method")!.toString();
      if (formData.get("client_id")) clientId = formData.get("client_id")!.toString();
    }
  }

  // Strict OAuth 2.1 validations
  if (!redirectUri) {
    return new Response("Missing redirect_uri", { status: 400 });
  }
  if (!codeChallenge || codeChallengeMethod !== "S256") {
    return new Response("OAuth 2.1 requires code_challenge with code_challenge_method=S256", { status: 400 });
  }

  // Function to render the authorization card with XSS protection
  const renderCard = (errorMessage?: string) => {
    const errorBanner = errorMessage
      ? `<div style="background:#450a0a;border:1px solid #ef4444;color:#fca5a5;padding:0.75rem 1rem;border-radius:0.5rem;margin-bottom:1.25rem;font-size:0.9rem;">${escapeHtml(errorMessage)}</div>`
      : "";

    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Constancy MCP 授权确认</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: #f8fafc; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 1rem; box-sizing: border-box; }
    .card { background: #1e293b; padding: 2.5rem; border-radius: 1rem; box-shadow: 0 10px 25px rgba(0,0,0,0.5); max-width: 440px; width: 100%; border: 1px solid #334155; box-sizing: border-box; }
    h2 { margin-top: 0; color: #38bdf8; display: flex; align-items: center; gap: 0.5rem; font-size: 1.4rem; }
    p { color: #94a3b8; font-size: 0.95rem; line-height: 1.5; margin-bottom: 1.25rem; }
    .field { margin-bottom: 1.25rem; text-align: left; }
    label { display: block; font-size: 0.85rem; color: #cbd5e1; margin-bottom: 0.4rem; font-weight: 500; }
    input { width: 100%; padding: 0.75rem 1rem; border-radius: 0.5rem; border: 1px solid #475569; background: #0f172a; color: #fff; box-sizing: border-box; font-size: 1rem; outline: none; transition: border-color 0.2s; }
    input:focus { border-color: #38bdf8; }
    button { width: 100%; padding: 0.85rem; border-radius: 0.5rem; border: none; background: #38bdf8; color: #0f172a; font-weight: bold; font-size: 1rem; cursor: pointer; transition: background 0.2s; margin-top: 0.5rem; }
    button:hover { background: #7dd3fc; }
  </style>
</head>
<body>
  <div class="card">
    <h2>🧬 Constancy MCP</h2>
    <p>Claude 请求连接到您的<b>人基常热认知外脑 (ACTD)</b>。<br>请输入管理员邮箱与授权口令完成单设备 1 年免密连接：</p>
    ${errorBanner}
    <form method="POST" action="/oauth2/authorize">
      <input type="hidden" name="client_id" value="${escapeHtml(clientId)}">
      <input type="hidden" name="redirect_uri" value="${escapeHtml(redirectUri)}">
      <input type="hidden" name="state" value="${escapeHtml(state)}">
      <input type="hidden" name="code_challenge" value="${escapeHtml(codeChallenge)}">
      <input type="hidden" name="code_challenge_method" value="${escapeHtml(codeChallengeMethod)}">
      <div class="field">
        <label>管理员邮箱 (Admin Email)</label>
        <input type="email" name="email" value="${escapeHtml(submittedEmail)}" placeholder="edwin.abel.3@gmail.com" required autofocus>
      </div>
      <div class="field">
        <label>授权口令 (Admin Passkey)</label>
        <input type="password" name="passkey" placeholder="请输入系统预设口令" required>
      </div>
      <button type="submit">授权连接 Claude (1 年免密)</button>
    </form>
  </div>
</body>
</html>`;
    return new Response(html, {
      status: errorMessage ? 401 : 200,
      headers: { "Content-Type": "text/html; charset=utf-8" }
    });
  };

  // If GET request, display authentication form directly (unauthenticated query param bypass is completely eliminated)
  if (!isPostSubmission) {
    return renderCard();
  }

  // POST Submission Verification
  // 1. Verify Passkey
  if (env.ADMIN_PASSKEY) {
    if (!submittedPasskey || submittedPasskey !== env.ADMIN_PASSKEY) {
      return renderCard("❌ 授权口令 (Passkey) 错误，拒绝颁发访问令牌。");
    }
  }

  // 2. Verify Email Whitelist
  if (!submittedEmail) {
    return renderCard("❌ 请输入有效的管理员邮箱。");
  }

  if (env.ALLOWED_EMAILS) {
    const whitelist = env.ALLOWED_EMAILS.split(",")
      .map(e => e.trim().toLowerCase())
      .filter(Boolean);
    if (!whitelist.includes(submittedEmail)) {
      return renderCard(`❌ 邮箱 "${submittedEmail}" 不在管理员白名单中，拒绝接入。`);
    }
  }

  // Issue Authorization Code
  const code = "code_" + crypto.randomUUID().replace(/-/g, "");
  const codeData = {
    user_id: submittedEmail,
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

    // Verify PKCE (Strict OAuth 2.1)
    if (!codeData.code_challenge || !codeVerifier) {
      return new Response(JSON.stringify({ error: "invalid_grant", error_description: "Missing PKCE challenge or verifier" }), { status: 400 });
    }
    const valid = await verifyPkce(codeVerifier, codeData.code_challenge);
    if (!valid) {
      return new Response(JSON.stringify({ error: "invalid_grant", error_description: "PKCE verification failed" }), { status: 400 });
    }

    const userId = codeData.user_id;

    // Check whitelist on token issuance
    if (env.ALLOWED_EMAILS) {
      const whitelist = env.ALLOWED_EMAILS.split(",").map(e => e.trim().toLowerCase()).filter(Boolean);
      if (!whitelist.includes(userId.toLowerCase())) {
        return new Response(JSON.stringify({ error: "access_denied", error_description: "User not in whitelist" }), { status: 403 });
      }
    }

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

    // Check whitelist on token renewal
    if (env.ALLOWED_EMAILS) {
      const whitelist = env.ALLOWED_EMAILS.split(",").map(e => e.trim().toLowerCase()).filter(Boolean);
      if (!whitelist.includes(userId.toLowerCase())) {
        await env.CONSTANCY_KV.delete(`refresh:${refreshToken}`);
        return new Response(JSON.stringify({ error: "access_denied", error_description: "User revoked or not in whitelist" }), { status: 403 });
      }
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

  // Real-time Whitelist Enforcement on EVERY request
  if (env.ALLOWED_EMAILS) {
    const whitelist = env.ALLOWED_EMAILS.split(",").map(e => e.trim().toLowerCase()).filter(Boolean);
    if (!whitelist.includes((payload.sub as string).toLowerCase().trim())) {
      return null;
    }
  }

  return payload.sub as string;
}
