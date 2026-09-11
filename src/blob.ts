/**
 * Binary Capability URLs & Direct Transfer Module (/blob/:id)
 * Bypasses LLM token window by allowing direct HTTP GET and PUT of binary attachments.
 */

import { getPointById, setPointPayload, QdrantEnv } from "./qdrant";

export interface BlobEnv extends QdrantEnv {
  JWT_SECRET: string;
  DOMAIN: string;
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Mcp-Session-Id"
};

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function base64UrlEncode(str: string): string {
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64ToUint8Array(base64: string): Uint8Array {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

export function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binaryStr = "";
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binaryStr += String.fromCharCode(bytes[i]);
  }
  return btoa(binaryStr);
}

export async function computeBase64Sha256(base64Str: string): Promise<string> {
  const bytes = base64ToUint8Array(base64Str);
  const hashBuf = await crypto.subtle.digest("SHA-256", bytes);
  const hashArray = Array.from(new Uint8Array(hashBuf));
  return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
}

export async function computeBufferSha256(buffer: ArrayBuffer): Promise<string> {
  const hashBuf = await crypto.subtle.digest("SHA-256", buffer);
  const hashArray = Array.from(new Uint8Array(hashBuf));
  return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
}

export async function generateBlobSig(
  method: string,
  id: string,
  userId: string,
  exp: number,
  secret: string
): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const data = `${method.toUpperCase()}:${id}:${userId}:${exp}`;
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(data));
  const binary = String.fromCharCode(...new Uint8Array(signature));
  return base64UrlEncode(binary);
}

export async function verifyBlobSig(
  method: string,
  id: string,
  userId: string,
  exp: number,
  sig: string,
  secret: string
): Promise<boolean> {
  const nowSec = Math.floor(Date.now() / 1000);
  if (exp < nowSec) {
    return false; // Expired
  }

  // Strict method-bound signature check: METHOD:id:userId:exp
  const expectedWithMethod = await generateBlobSig(method, id, userId, exp, secret);
  return timingSafeEqual(sig, expectedWithMethod);
}

export async function handleBlobRequest(
  request: Request,
  blobId: string,
  env: BlobEnv
): Promise<Response> {
  // CORS Preflight
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const url = new URL(request.url);
  const exp = parseInt(url.searchParams.get("exp") || "0", 10);
  const sig = url.searchParams.get("sig") || "";

  if (!blobId) {
    return new Response(JSON.stringify({ error: "Missing blob ID" }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS }
    });
  }

  if (!exp || !sig) {
    return new Response(JSON.stringify({ error: "Missing required 'exp' or 'sig' capability parameters" }), {
      status: 401,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS }
    });
  }

  if (exp < Math.floor(Date.now() / 1000)) {
    return new Response(JSON.stringify({ error: "Capability URL has expired" }), {
      status: 403,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS }
    });
  }

  // Fetch target point from Qdrant to obtain owner user_id
  const point = await getPointById(blobId, env);
  if (!point || !point.payload) {
    return new Response(JSON.stringify({ error: "Target note not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS }
    });
  }

  const userId = point.payload.user_id;

  // 1. GET /blob/:id - Direct download binary payload
  if (request.method === "GET") {
    const isValid = await verifyBlobSig("GET", blobId, userId, exp, sig, env.JWT_SECRET);
    if (!isValid) {
      return new Response(JSON.stringify({ error: "Invalid or forged capability signature" }), {
        status: 403,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS }
      });
    }

    if (!point.payload.base64) {
      return new Response(JSON.stringify({ error: "Note contains no binary payload" }), {
        status: 404,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS }
      });
    }

    const bytes = base64ToUint8Array(point.payload.base64);
    const mimeType = point.payload.mime_type || "application/octet-stream";
    const sha256 = point.payload.sha256 || "";

    return new Response(bytes, {
      status: 200,
      headers: {
        "Content-Type": mimeType,
        "Content-Length": String(bytes.byteLength),
        "Content-Disposition": "attachment",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "sandbox; default-src 'none'",
        "ETag": `"${sha256}"`,
        "Cache-Control": "private, max-age=300",
        ...CORS_HEADERS
      }
    });
  }

  // 2. PUT /blob/:id - Direct upload binary payload (up to 10KB)
  if (request.method === "PUT") {
    const isValid = await verifyBlobSig("PUT", blobId, userId, exp, sig, env.JWT_SECRET);
    if (!isValid) {
      return new Response(JSON.stringify({ error: "Invalid or forged capability signature" }), {
        status: 403,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS }
      });
    }

    const arrayBuffer = await request.arrayBuffer();
    if (arrayBuffer.byteLength === 0) {
      return new Response(JSON.stringify({ error: "Cannot upload empty binary payload" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS }
      });
    }

    if (arrayBuffer.byteLength > 10240) {
      return new Response(
        JSON.stringify({
          error: `Payload exceeds 10KB cap (received ${arrayBuffer.byteLength} bytes). Large files should use dedicated object storage.`
        }),
        {
          status: 413,
          headers: { "Content-Type": "application/json", ...CORS_HEADERS }
        }
      );
    }

    const uint8 = new Uint8Array(arrayBuffer);
    const base64 = uint8ArrayToBase64(uint8);
    const sha256 = await computeBufferSha256(arrayBuffer);

    let mimeType = request.headers.get("content-type") || "";
    if (!mimeType || mimeType === "application/octet-stream") {
      mimeType = point.payload.mime_type || "application/octet-stream";
    }

    const nowMs = Date.now();
    await setPointPayload(
      blobId,
      {
        base64,
        sha256,
        mime_type: mimeType,
        t_last_update: nowMs,
        t_last_strong: nowMs
      },
      env
    );

    return new Response(
      JSON.stringify({
        success: true,
        id: blobId,
        bytes_received: arrayBuffer.byteLength,
        sha256,
        mime_type: mimeType,
        message: `Binary payload successfully uploaded (${arrayBuffer.byteLength} bytes, SHA-256: ${sha256})`
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS }
      }
    );
  }

  return new Response(JSON.stringify({ error: "Method not allowed" }), {
    status: 405,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS }
  });
}
