/**
 * Voyage AI Embedding Client (1024 dimensions)
 */

export interface VoyageEnv {
  VOYAGE_API_KEY: string;
}

export async function getEmbedding(
  text: string,
  env: VoyageEnv,
  inputType: "document" | "query" = "document"
): Promise<number[]> {
  const apiKey = env.VOYAGE_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("VOYAGE_API_KEY is not configured");
  }

  const res = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "voyage-3",
      input: [text.slice(0, 8000)],
      input_type: inputType
    })
  });

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
