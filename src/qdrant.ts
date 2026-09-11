/**
 * Qdrant Vector Client for constancy_memories Collection
 */

import { MemoryPointPayload } from "./actd";

export interface QdrantEnv {
  QDRANT_URL: string;
  QDRANT_API_KEY: string;
}

const COLLECTION_NAME = "constancy_memories";

async function qdrantFetch(url: string, env: QdrantEnv, options: RequestInit = {}) {
  const headers = {
    "api-key": env.QDRANT_API_KEY?.trim(),
    "Content-Type": "application/json",
    "User-Agent": "curl/8.14.1 (constancy-mcp worker)",
    ...(options.headers || {})
  };
  return fetch(url, { ...options, headers });
}

export async function upsertMemoryPoint(
  id: string,
  vector: number[],
  payload: MemoryPointPayload,
  env: QdrantEnv
) {
  const url = `${env.QDRANT_URL.replace(/\/+$/, "")}/collections/${COLLECTION_NAME}/points?wait=true`;
  const res = await qdrantFetch(url, env, {
    method: "PUT",
    body: JSON.stringify({
      points: [
        {
          id,
          vector,
          payload
        }
      ]
    })
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Qdrant upsert error (${res.status}): ${errText}`);
  }
}

export async function searchMemoryPoints(
  vector: number[],
  userId: string,
  limit: number = 10,
  env: QdrantEnv,
  extraFilter?: any
) {
  const url = `${env.QDRANT_URL.replace(/\/+$/, "")}/collections/${COLLECTION_NAME}/points/search`;
  
  const mustFilters: any[] = [
    { key: "user_id", match: { value: userId } }
  ];

  if (extraFilter?.type) {
    mustFilters.push({ key: "type", match: { value: extraFilter.type } });
  }
  if (extraFilter?.entity) {
    mustFilters.push({ key: "entities", match: { value: extraFilter.entity } });
  }

  const res = await qdrantFetch(url, env, {
    method: "POST",
    body: JSON.stringify({
      vector,
      limit,
      with_payload: true,
      score_threshold: 0.2,
      filter: {
        must: mustFilters
      }
    })
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Qdrant search error (${res.status}): ${errText}`);
  }

  const data: any = await res.json();
  return data.result || [];
}

export async function getTimelinePoints(
  userId: string,
  date: string,
  env: QdrantEnv
) {
  const url = `${env.QDRANT_URL.replace(/\/+$/, "")}/collections/${COLLECTION_NAME}/points/scroll`;
  const res = await qdrantFetch(url, env, {
    method: "POST",
    body: JSON.stringify({
      limit: 100,
      with_payload: true,
      with_vector: false,
      filter: {
        must: [
          { key: "user_id", match: { value: userId } },
          { key: "date", match: { value: date } }
        ]
      }
    })
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Qdrant scroll error (${res.status}): ${errText}`);
  }

  const data: any = await res.json();
  const points = data.result?.points || [];
  // Sort chronologically
  return points.sort((a: any, b: any) => 
    new Date(a.payload?.timestamp || 0).getTime() - new Date(b.payload?.timestamp || 0).getTime()
  );
}

export async function updatePointSpectrum(
  id: string,
  hSpectrum: number[],
  nowMs: number,
  isStrong: boolean,
  env: QdrantEnv
) {
  const url = `${env.QDRANT_URL.replace(/\/+$/, "")}/collections/${COLLECTION_NAME}/points/payload?wait=false`;
  const payloadUpdate: any = {
    h_spectrum: hSpectrum,
    t_last_update: nowMs
  };
  if (isStrong) {
    payloadUpdate.t_last_strong = nowMs;
  }

  await qdrantFetch(url, env, {
    method: "POST",
    body: JSON.stringify({
      points: [id],
      payload: payloadUpdate
    })
  });
}

export async function getPointById(
  id: string,
  env: QdrantEnv
): Promise<{ id: string; payload?: MemoryPointPayload } | null> {
  const url = `${env.QDRANT_URL.replace(/\/+$/, "")}/collections/${COLLECTION_NAME}/points/${id}`;
  const res = await qdrantFetch(url, env);
  if (!res.ok) {
    if (res.status === 404) return null;
    const errText = await res.text();
    throw new Error(`Qdrant getPointById error (${res.status}): ${errText}`);
  }
  const data: any = await res.json();
  return data.result || null;
}

export async function setPointPayload(
  id: string,
  payload: Partial<MemoryPointPayload> & Record<string, any>,
  env: QdrantEnv
) {
  const url = `${env.QDRANT_URL.replace(/\/+$/, "")}/collections/${COLLECTION_NAME}/points/payload?wait=true`;
  const res = await qdrantFetch(url, env, {
    method: "POST",
    body: JSON.stringify({
      points: [id],
      payload
    })
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Qdrant setPointPayload error (${res.status}): ${errText}`);
  }
}
