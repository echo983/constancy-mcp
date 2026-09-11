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

export async function scrollNotes(
  userId: string,
  tag?: string,
  limit: number = 20,
  includeRetired: boolean = false,
  env: QdrantEnv = {} as any
): Promise<Array<{ id: string; payload: MemoryPointPayload }>> {
  const url = `${env.QDRANT_URL.replace(/\/+$/, "")}/collections/${COLLECTION_NAME}/points/scroll`;

  const mustFilters: any[] = [
    { key: "user_id", match: { value: userId } },
    { key: "type", match: { value: "note" } }
  ];

  if (tag && tag.trim()) {
    mustFilters.push({ key: "tags", match: { value: tag.trim() } });
  }

  const filterBody: any = {
    must: mustFilters
  };

  if (!includeRetired) {
    filterBody.must_not = [
      { key: "retired", match: { value: true } }
    ];
  }

  const fetchLimit = Math.min(Math.max(limit * 3, 50), 200);

  const res = await qdrantFetch(url, env, {
    method: "POST",
    body: JSON.stringify({
      limit: fetchLimit,
      with_payload: true,
      with_vector: false,
      filter: filterBody
    })
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Qdrant scrollNotes error (${res.status}): ${errText}`);
  }

  const data: any = await res.json();
  const points: Array<{ id: string; payload: MemoryPointPayload }> = data.result?.points || [];

  // Sort by timestamp descending (newest notes first)
  points.sort((a, b) => {
    const tA = new Date(a.payload?.timestamp || 0).getTime();
    const tB = new Date(b.payload?.timestamp || 0).getTime();
    return tB - tA;
  });

  return points.slice(0, limit);
}

export async function searchImagePoints(
  vector: number[],
  userId: string,
  limit: number = 6,
  env: QdrantEnv
): Promise<Array<{ id: string; score: number; payload: any }>> {
  const url = `${env.QDRANT_URL.replace(/\/+$/, "")}/collections/images/points/search`;
  const res = await qdrantFetch(url, env, {
    method: "POST",
    body: JSON.stringify({
      vector,
      limit,
      with_payload: true,
      score_threshold: 0.1,
      filter: {
        must: [
          { key: "user_id", match: { value: userId } }
        ]
      }
    })
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Qdrant searchImagePoints error (${res.status}): ${errText}`);
  }

  const data: any = await res.json();
  return data.result || [];
}

export async function getImagePoint(
  targetId: string,
  userId: string,
  env: QdrantEnv
): Promise<{ id: string; payload?: any } | null> {
  const qdrantUrl = env.QDRANT_URL.replace(/\/+$/, "");

  // 1. Try direct point ID fetch first
  const directUrl = `${qdrantUrl}/collections/images/points/${targetId}`;
  const directRes = await qdrantFetch(directUrl, env);
  if (directRes.ok) {
    const directData: any = await directRes.json();
    if (directData.result && directData.result.payload?.user_id === userId) {
      return directData.result;
    }
  }

  // 2. Try matching image_id in payload
  const scrollUrl = `${qdrantUrl}/collections/images/points/scroll`;
  const scrollRes = await qdrantFetch(scrollUrl, env, {
    method: "POST",
    body: JSON.stringify({
      limit: 1,
      with_payload: true,
      with_vector: false,
      filter: {
        must: [
          { key: "user_id", match: { value: userId } },
          { key: "image_id", match: { value: targetId } }
        ]
      }
    })
  });

  if (scrollRes.ok) {
    const scrollData: any = await scrollRes.json();
    const points = scrollData.result?.points || [];
    if (points.length > 0) {
      return points[0];
    }
  }

  return null;
}

