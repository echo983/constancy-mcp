/**
 * Voyage AI Multimodal Embedding Client (1024 dimensions)
 * Model: voyage-multimodal-3.5
 * Supports pure text, base64 images, image URLs, and interleaved multimodal inputs.
 */

export interface VoyageEnv {
  VOYAGE_API_KEY: string;
}

export interface MultimodalContentPart {
  type: "text" | "image_base64" | "image_url";
  text?: string;
  image_base64?: string;
  image_url?: string;
}

export interface MultimodalEmbeddingOptions {
  text?: string;
  imageBase64?: string; // Raw base64 string or data: URI
  mimeType?: string;     // e.g. "image/png"
  imageUrl?: string;
}

export type EmbeddingInput = string | MultimodalEmbeddingOptions | MultimodalContentPart[];

export const SUPPORTED_IMAGE_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif"
]);

export async function getEmbedding(
  input: EmbeddingInput,
  env: VoyageEnv,
  inputType: "document" | "query" = "document"
): Promise<number[]> {
  const apiKey = env.VOYAGE_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("VOYAGE_API_KEY is not configured");
  }

  const content: MultimodalContentPart[] = [];

  if (typeof input === "string") {
    content.push({ type: "text", text: input.slice(0, 32000) });
  } else if (Array.isArray(input)) {
    content.push(...input);
  } else if (input && typeof input === "object") {
    if (input.text) {
      content.push({ type: "text", text: input.text.slice(0, 32000) });
    }
    if (input.imageUrl) {
      content.push({ type: "image_url", image_url: input.imageUrl });
    } else if (input.imageBase64) {
      const mime = (input.mimeType || "image/png").toLowerCase();
      if (SUPPORTED_IMAGE_MIMES.has(mime)) {
        let b64 = input.imageBase64;
        if (!b64.startsWith("data:")) {
          const normMime = mime === "image/jpg" ? "image/jpeg" : mime;
          b64 = `data:${normMime};base64,${b64}`;
        }
        content.push({ type: "image_base64", image_base64: b64 });
      }
    }
  }

  if (content.length === 0) {
    content.push({ type: "text", text: "empty" });
  }

  const makeVoyageRequest = async (payloadContent: MultimodalContentPart[]) => {
    return await fetch("https://api.voyageai.com/v1/multimodalembeddings", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "voyage-multimodal-3.5",
        inputs: [{ content: payloadContent }],
        input_type: inputType
      })
    });
  };

  let res = await makeVoyageRequest(content);

  // If multimodal request failed and we included an image, gracefully fall back to text-only
  if (!res.ok && content.some(c => c.type === "image_base64" || c.type === "image_url")) {
    const textOnly = content.filter(c => c.type === "text");
    if (textOnly.length > 0) {
      console.warn(`[voyage] Multimodal embedding failed with status ${res.status}, falling back to text-only`);
      res = await makeVoyageRequest(textOnly);
    }
  }

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Voyage AI API error (${res.status}): ${errText}`);
  }

  const data: any = await res.json();
  const vector = data?.data?.[0]?.embedding;
  if (!Array.isArray(vector) || vector.length !== 1024) {
    throw new Error(`Invalid embedding vector dimension: expected 1024, got ${vector?.length}`);
  }

  return vector;
}
