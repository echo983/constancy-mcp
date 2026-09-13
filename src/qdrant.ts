/**
 * Qdrant Vector Client for constancy_memories Collection
 */

import {
  MemoryPointPayload,
  MemoryAnnotation,
  CognitiveConcernPayload,
  DoctorCase,
  DoctorVerdict,
  DoctorTreatment,
  ConcernSeverity,
  ConcernStatus
} from "./actd";

export interface QdrantEnv {
  QDRANT_URL: string;
  QDRANT_API_KEY: string;
}

const COLLECTION_NAME = "constancy_memories";
export const CONCERNS_COLLECTION = "constancy_concerns";

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

export interface NearGeoFilter {
  latitude?: number;
  longitude?: number;
  lat?: number;
  lon?: number;
  radius_meters?: number;
  radius?: number;
  exclude?: boolean;
}

export interface StructuredSearchFilter {
  type?: string;
  entity?: string;
  date_from?: string;
  date_to?: string;
  near?: NearGeoFilter | null;
  pending_confirmation_only?: boolean;
}

export function parseDateFilter(dateStr?: string, isEnd = false): string | null {
  if (!dateStr || typeof dateStr !== "string") return null;
  const trimmed = dateStr.trim();
  if (!trimmed) return null;

  // Case 1: "YYYY-MM"
  const monthMatch = trimmed.match(/^(\d{4})-(\d{2})$/);
  if (monthMatch) {
    const year = parseInt(monthMatch[1], 10);
    const month = parseInt(monthMatch[2], 10);
    if (isEnd) {
      const lastDay = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));
      return lastDay.toISOString();
    } else {
      const firstDay = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0));
      return firstDay.toISOString();
    }
  }

  // Case 2: "YYYY-MM-DD"
  const dayMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dayMatch) {
    const year = parseInt(dayMatch[1], 10);
    const month = parseInt(dayMatch[2], 10);
    const day = parseInt(dayMatch[3], 10);
    if (isEnd) {
      return new Date(Date.UTC(year, month - 1, day, 23, 59, 59, 999)).toISOString();
    } else {
      return new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0)).toISOString();
    }
  }

  const d = new Date(trimmed);
  if (!isNaN(d.getTime())) {
    return d.toISOString();
  }
  return null;
}

export function parseNearFilter(nearInput: any): {
  latitude: number;
  longitude: number;
  radius_meters: number;
  exclude: boolean;
} | null {
  if (!nearInput || typeof nearInput !== "object") return null;
  const lat = nearInput.latitude ?? nearInput.lat;
  const lon = nearInput.longitude ?? nearInput.lon;
  if (typeof lat !== "number" || typeof lon !== "number" || isNaN(lat) || isNaN(lon)) {
    return null;
  }
  const radius = Number(nearInput.radius_meters ?? nearInput.radius ?? 1000.0);
  const exclude = Boolean(nearInput.exclude);
  return {
    latitude: lat,
    longitude: lon,
    radius_meters: Math.max(10, isNaN(radius) ? 1000.0 : radius),
    exclude
  };
}

export function normalizeIsoDate(input: any): string | null {
  if (!input) return null;
  if (input instanceof Date) {
    return isNaN(input.getTime()) ? null : input.toISOString();
  }
  const str = String(input).trim();
  if (!str) return null;

  const d = new Date(str);
  if (!isNaN(d.getTime())) {
    return d.toISOString();
  }

  const exifMatch = str.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(.*)$/);
  if (exifMatch) {
    const isoLike = `${exifMatch[1]}-${exifMatch[2]}-${exifMatch[3]}T${exifMatch[4]}:${exifMatch[5]}:${exifMatch[6]}${exifMatch[7].trim() || "Z"}`;
    const ed = new Date(isoLike);
    if (!isNaN(ed.getTime())) {
      return ed.toISOString();
    }
  }

  return null;
}

export async function searchMemoryPoints(
  vector: number[] | null,
  userId: string,
  limit: number = 10,
  env: QdrantEnv,
  extraFilter?: StructuredSearchFilter
) {
  const mustFilters: any[] = [
    { key: "user_id", match: { value: userId } }
  ];
  const mustNotFilters: any[] = [];

  if (extraFilter?.type && extraFilter.type !== "all") {
    mustFilters.push({ key: "type", match: { value: extraFilter.type } });
  }
  if (extraFilter?.entity) {
    mustFilters.push({ key: "entities", match: { value: extraFilter.entity } });
  }
  if (extraFilter?.pending_confirmation_only) {
    mustFilters.push({ key: "pending_user_confirmation", match: { value: true } });
  }

  // Structured Date Range Filter (applies to timestamp or captured_at)
  if (extraFilter?.date_from || extraFilter?.date_to) {
    const range: any = {};
    if (extraFilter.date_from) range.gte = extraFilter.date_from;
    if (extraFilter.date_to) range.lte = extraFilter.date_to;
    mustFilters.push({
      should: [
        { key: "timestamp", range },
        { key: "captured_at", range }
      ]
    });
  }

  // Structured Geo Filter (applies to location)
  if (extraFilter?.near) {
    const near = extraFilter.near;
    const lat = near.latitude ?? near.lat;
    const lon = near.longitude ?? near.lon;
    const radius = near.radius_meters ?? near.radius ?? 1000.0;
    if (typeof lat === "number" && typeof lon === "number") {
      const geoRadius = {
        key: "location",
        geo_radius: {
          center: { lat, lon },
          radius
        }
      };
      if (near.exclude) {
        mustNotFilters.push({ is_empty: { key: "location" } });
        mustNotFilters.push(geoRadius);
      } else {
        mustFilters.push(geoRadius);
      }
    }
  }

  const filterObj: any = { must: mustFilters };
  if (mustNotFilters.length > 0) {
    filterObj.must_not = mustNotFilters;
  }

  // If vector is provided: execute semantic vector search with filters
  if (vector && Array.isArray(vector) && vector.length > 0) {
    const url = `${env.QDRANT_URL.replace(/\/+$/, "")}/collections/${COLLECTION_NAME}/points/search`;
    const res = await qdrantFetch(url, env, {
      method: "POST",
      body: JSON.stringify({
        vector,
        limit,
        with_payload: true,
        score_threshold: 0.2,
        filter: filterObj
      })
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Qdrant search error (${res.status}): ${errText}`);
    }

    const data: any = await res.json();
    return data.result || [];
  }

  // Otherwise: execute pure structured scroll query
  const scrollUrl = `${env.QDRANT_URL.replace(/\/+$/, "")}/collections/${COLLECTION_NAME}/points/scroll`;
  const res = await qdrantFetch(scrollUrl, env, {
    method: "POST",
    body: JSON.stringify({
      limit,
      with_payload: true,
      with_vector: false,
      filter: filterObj
    })
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Qdrant scroll error (${res.status}): ${errText}`);
  }

  const data: any = await res.json();
  const points = data.result?.points || [];
  return points.map((pt: any) => ({
    id: pt.id,
    score: 1.0,
    payload: pt.payload
  }));
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
    if (res.status === 400 && errText.includes("Can not recognize")) return null;
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
  vector: number[] | null,
  userId: string,
  limit: number = 6,
  env: QdrantEnv,
  extraFilter?: StructuredSearchFilter
): Promise<Array<{ id: string; score: number; payload: any }>> {
  const mustFilters: any[] = [
    { key: "user_id", match: { value: userId } }
  ];
  const mustNotFilters: any[] = [];

  // Structured Date Range Filter (applies to captured_at or exif.dateTime)
  if (extraFilter?.date_from || extraFilter?.date_to) {
    const range: any = {};
    if (extraFilter.date_from) range.gte = extraFilter.date_from;
    if (extraFilter.date_to) range.lte = extraFilter.date_to;
    mustFilters.push({
      should: [
        { key: "captured_at", range },
        { key: "exif.dateTime", range }
      ]
    });
  }

  // Structured Geo Filter (applies to location)
  if (extraFilter?.near) {
    const near = extraFilter.near;
    const lat = near.latitude ?? near.lat;
    const lon = near.longitude ?? near.lon;
    const radius = near.radius_meters ?? near.radius ?? 1000.0;
    if (typeof lat === "number" && typeof lon === "number") {
      const geoRadius = {
        key: "location",
        geo_radius: {
          center: { lat, lon },
          radius
        }
      };
      if (near.exclude) {
        mustNotFilters.push({ is_empty: { key: "location" } });
        mustNotFilters.push(geoRadius);
      } else {
        mustFilters.push(geoRadius);
      }
    }
  }

  const filterObj: any = { must: mustFilters };
  if (mustNotFilters.length > 0) {
    filterObj.must_not = mustNotFilters;
  }

  // Vector similarity search if vector is present
  if (vector && Array.isArray(vector) && vector.length > 0) {
    const url = `${env.QDRANT_URL.replace(/\/+$/, "")}/collections/images/points/search`;
    const res = await qdrantFetch(url, env, {
      method: "POST",
      body: JSON.stringify({
        vector,
        limit,
        with_payload: true,
        score_threshold: 0.1,
        filter: filterObj
      })
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Qdrant searchImagePoints error (${res.status}): ${errText}`);
    }

    const data: any = await res.json();
    return data.result || [];
  }

  // Pure structured query without vector -> scroll
  const scrollUrl = `${env.QDRANT_URL.replace(/\/+$/, "")}/collections/images/points/scroll`;
  const res = await qdrantFetch(scrollUrl, env, {
    method: "POST",
    body: JSON.stringify({
      limit,
      with_payload: true,
      with_vector: false,
      filter: filterObj
    })
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Qdrant searchImagePoints scroll error (${res.status}): ${errText}`);
  }

  const data: any = await res.json();
  const points = data.result?.points || [];
  return points.map((pt: any) => ({
    id: pt.id,
    score: 1.0,
    payload: pt.payload
  }));
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

export async function findEntityPoints(
  entityName: string,
  userId: string,
  env: QdrantEnv
): Promise<Array<{ id: string; payload?: MemoryPointPayload }>> {
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
          { key: "type", match: { value: "entity" } }
        ],
        must_not: [
          { key: "retired", match: { value: true } }
        ]
      }
    })
  });

  if (!res.ok) {
    return [];
  }

  const data: any = await res.json();
  const points: Array<{ id: string; payload?: MemoryPointPayload }> = data.result?.points || [];
  const targetLower = entityName.toLowerCase().trim();

  return points.filter(p => {
    const payload = p.payload as any;
    if (!payload) return false;
    // 1. Match explicit entity_name field
    if (payload.entity_name && String(payload.entity_name).toLowerCase().trim() === targetLower) {
      return true;
    }
    // 2. Match content header 【核心实体: <name>】
    const content = String(payload.content || "");
    const headerMatch = content.match(/^【核心实体:\s*([^】]+)】/);
    if (headerMatch && headerMatch[1].toLowerCase().trim() === targetLower) {
      return true;
    }
    return false;
  });
}

export async function retireMemoryPoints(
  pointIds: string[],
  reason: string,
  env: QdrantEnv
): Promise<void> {
  if (!pointIds || pointIds.length === 0) return;
  const url = `${env.QDRANT_URL.replace(/\/+$/, "")}/collections/${COLLECTION_NAME}/points/payload?wait=true`;
  const res = await qdrantFetch(url, env, {
    method: "POST",
    body: JSON.stringify({
      points: pointIds,
      payload: {
        retired: true,
        retired_at: new Date().toISOString(),
        retired_reason: reason
      }
    })
  });
  if (!res.ok) {
    const errText = await res.text();
    console.error(`Qdrant retireMemoryPoints error (${res.status}): ${errText}`);
  }
}

export async function deleteMemoryPoints(
  pointIds: string[],
  env: QdrantEnv
): Promise<void> {
  if (!pointIds || pointIds.length === 0) return;
  const url = `${env.QDRANT_URL.replace(/\/+$/, "")}/collections/${COLLECTION_NAME}/points/delete?wait=true`;
  const res = await qdrantFetch(url, env, {
    method: "POST",
    body: JSON.stringify({
      points: pointIds
    })
  });
  if (!res.ok) {
    const errText = await res.text();
    console.error(`Qdrant deleteMemoryPoints error (${res.status}): ${errText}`);
  }
}

export async function appendMemoryAnnotation(
  pointId: string,
  annotation: MemoryAnnotation,
  env: QdrantEnv
): Promise<MemoryPointPayload> {
  const point = await getPointById(pointId, env);
  if (!point || !point.payload) {
    throw new Error(`Memory point '${pointId}' not found.`);
  }
  const currentAnnotations = Array.isArray(point.payload.annotations)
    ? [...point.payload.annotations]
    : [];

  currentAnnotations.push(annotation);

  await setPointPayload(pointId, { 
    annotations: currentAnnotations,
    t_last_update: Date.now()
  }, env);

  return {
    ...point.payload,
    annotations: currentAnnotations,
    t_last_update: Date.now()
  };
}

// ==================== Cognitive Hygiene & Doctor Queue Operations ====================

export async function ensureConcernsCollection(env: QdrantEnv): Promise<void> {
  const url = `${env.QDRANT_URL.replace(/\/+$/, "")}/collections/${CONCERNS_COLLECTION}`;
  const checkRes = await qdrantFetch(url, env, { method: "GET" });
  if (!checkRes.ok) {
    const createRes = await qdrantFetch(url, env, {
      method: "PUT",
      body: JSON.stringify({
        vectors: {
          size: 4,
          distance: "Cosine"
        }
      })
    });
    if (!createRes.ok && createRes.status !== 409) {
      const errText = await createRes.text();
      console.warn(`Could not create ${CONCERNS_COLLECTION}: ${errText}`);
    }
  }
}

export async function submitConcernToQdrant(
  concern: CognitiveConcernPayload,
  env: QdrantEnv
): Promise<{ id: string; duplicate_count: number; status: string; is_new: boolean }> {
  await ensureConcernsCollection(env);

  // Check if active concern already exists for this memory_id and user_id
  const scrollUrl = `${env.QDRANT_URL.replace(/\/+$/, "")}/collections/${CONCERNS_COLLECTION}/points/scroll`;
  const checkRes = await qdrantFetch(scrollUrl, env, {
    method: "POST",
    body: JSON.stringify({
      limit: 10,
      filter: {
        must: [
          { key: "user_id", match: { value: concern.user_id } },
          { key: "memory_id", match: { value: concern.memory_id } }
        ]
      },
      with_payload: true,
      with_vector: false
    })
  });

  let existingPoint: any = null;
  if (checkRes.ok) {
    const data: any = await checkRes.json();
    const activePoints = (data.result?.points || []).filter(
      (p: any) => p.payload?.status === "pending" || p.payload?.status === "deferred"
    );
    if (activePoints.length > 0) {
      existingPoint = activePoints[0];
    }
  }

  if (existingPoint) {
    // Deduplicate and escalate existing concern
    const oldPayload = existingPoint.payload as CognitiveConcernPayload;
    const newCount = (oldPayload.duplicate_count || 1) + 1;
    const severityOrder: Record<string, number> = { low: 1, medium: 2, high: 3 };
    const escalatedSeverity: ConcernSeverity =
      (severityOrder[concern.severity] || 1) > (severityOrder[oldPayload.severity] || 1)
        ? concern.severity
        : oldPayload.severity;

    const appendedEvidence = `${oldPayload.evidence || ""}\n---\n[追加证据 ${concern.created_at}] ${concern.evidence}`;
    const updatedPayload: Partial<CognitiveConcernPayload> = {
      duplicate_count: newCount,
      severity: escalatedSeverity,
      evidence: appendedEvidence,
      status: "pending", // Re-activate to pending if it was deferred
      updated_at: concern.created_at
    };

    const updateUrl = `${env.QDRANT_URL.replace(/\/+$/, "")}/collections/${CONCERNS_COLLECTION}/points/payload?wait=true`;
    await qdrantFetch(updateUrl, env, {
      method: "POST",
      body: JSON.stringify({
        points: [existingPoint.id],
        payload: updatedPayload
      })
    });

    return { id: String(existingPoint.id), duplicate_count: newCount, status: "pending", is_new: false };
  }

  // Insert new concern point with 4-dim dummy vector
  const upsertUrl = `${env.QDRANT_URL.replace(/\/+$/, "")}/collections/${CONCERNS_COLLECTION}/points?wait=true`;
  const insertRes = await qdrantFetch(upsertUrl, env, {
    method: "PUT",
    body: JSON.stringify({
      points: [
        {
          id: concern.id,
          vector: [0, 0, 0, 0],
          payload: concern
        }
      ]
    })
  });

  if (!insertRes.ok) {
    const errText = await insertRes.text();
    throw new Error(`Qdrant submitConcern error (${insertRes.status}): ${errText}`);
  }

  return { id: concern.id, duplicate_count: 1, status: concern.status, is_new: true };
}

export async function getDoctorTriageCases(
  userId: string,
  limit: number = 5,
  env: QdrantEnv
): Promise<{ has_cases: boolean; case_count: number; cases: DoctorCase[] }> {
  await ensureConcernsCollection(env);

  const scrollUrl = `${env.QDRANT_URL.replace(/\/+$/, "")}/collections/${CONCERNS_COLLECTION}/points/scroll`;
  const res = await qdrantFetch(scrollUrl, env, {
    method: "POST",
    body: JSON.stringify({
      limit: 100,
      filter: {
        must: [
          { key: "user_id", match: { value: userId } }
        ]
      },
      with_payload: true,
      with_vector: false
    })
  });

  if (!res.ok) {
    return { has_cases: false, case_count: 0, cases: [] };
  }

  const data: any = await res.json();
  const allPoints: any[] = data.result?.points || [];
  const now = Date.now();
  const currentHourUtc = new Date(now).getUTCHours();

  // Triage filter calculation
  const triageReadyPoints = allPoints.filter(pt => {
    const p = pt.payload as CognitiveConcernPayload;
    if (!p || (p.status !== "pending" && p.status !== "deferred")) return false;

    const createdAtMs = new Date(p.created_at || now).getTime();
    const updatedAtMs = new Date(p.updated_at || p.created_at || now).getTime();
    const ageHours = (now - createdAtMs) / (1000 * 60 * 60);

    // 1. High severity / user_confirmed / 3+ duplicates -> immediate (every hour)
    if (p.severity === "high" || p.interaction_mode === "user_confirmed" || (p.duplicate_count || 1) >= 3) {
      return true;
    }

    // 2. Medium severity: age >= 6h, or duplicate_count >= 2, or clock modulo 6h (00, 06, 12, 18)
    if (p.severity === "medium") {
      if (ageHours >= 6 || (p.duplicate_count || 1) >= 2 || currentHourUtc % 6 === 0) {
        return true;
      }
    }

    // 3. Low severity: age >= 24h, or daily check at 04:00 UTC
    if (p.severity === "low") {
      if (ageHours >= 24 || currentHourUtc === 4) {
        return true;
      }
    }

    // 4. Deferred review: if deferred >= 48h
    if (p.status === "deferred") {
      const deferAgeHours = (now - updatedAtMs) / (1000 * 60 * 60);
      if (deferAgeHours >= 48) return true;
    }

    return false;
  });

  if (triageReadyPoints.length === 0) {
    return { has_cases: false, case_count: 0, cases: [] };
  }

  // Group concerns by target memory_id into cases
  const caseMap = new Map<string, any[]>();
  for (const pt of triageReadyPoints) {
    const memId = pt.payload?.memory_id;
    if (!memId) continue;
    if (!caseMap.has(memId)) caseMap.set(memId, []);
    caseMap.get(memId)!.push(pt);
  }

  const doctorCases: DoctorCase[] = [];
  for (const [memId, pts] of caseMap.entries()) {
    if (doctorCases.length >= limit) break;

    // Fetch target memory details
    const targetPoint = await getPointById(memId, env);
    const targetPayload = targetPoint?.payload;

    const highestSeverity: ConcernSeverity = pts.some((x: any) => x.payload?.severity === "high")
      ? "high"
      : pts.some((x: any) => x.payload?.severity === "medium")
      ? "medium"
      : "low";

    const totalReports = pts.reduce((sum: number, x: any) => sum + (x.payload?.duplicate_count || 1), 0);

    doctorCases.push({
      case_id: `CASE-${memId.slice(0, 8).toUpperCase()}`,
      memory_id: memId,
      target_memory: {
        id: memId,
        content: targetPayload?.content || "（目标记忆已删除或不存在）",
        type: targetPayload?.type,
        c_h: targetPayload?.ch_prior,
        created_at: targetPayload?.timestamp || targetPayload?.date,
        annotations: targetPayload?.annotations || [],
        status: targetPayload?.status || "active"
      },
      concerns: pts.map((x: any) => ({
        id: String(x.id),
        reason: x.payload?.reason || "",
        evidence: x.payload?.evidence || "",
        severity: x.payload?.severity || "low",
        interaction_mode: x.payload?.interaction_mode || "silent",
        created_at: x.payload?.created_at || "",
        duplicate_count: x.payload?.duplicate_count || 1
      })),
      total_reports: totalReports,
      highest_severity: highestSeverity,
      triage_reason: highestSeverity === "high" ? "高危即时到期 (high priority)" : `${highestSeverity} 候诊窗口达标`,
      diagnostic_hint: `请核查该条记忆事实与最新用户原话证据，决定维持(KEEP)、修正(UPDATE)、废弃(EXPIRE)、归并(MERGE)、留观(DEFERRED)或请用户会诊(ESCALATED_TO_USER)`
    });
  }

  return {
    has_cases: doctorCases.length > 0,
    case_count: doctorCases.length,
    cases: doctorCases
  };
}

export async function updateCaseConcerns(
  userId: string,
  memoryId: string,
  caseId: string,
  verdict: DoctorVerdict,
  treatment: DoctorTreatment | undefined,
  doctorNotes: string,
  env: QdrantEnv
): Promise<number> {
  await ensureConcernsCollection(env);
  const nowIso = new Date().toISOString();

  // Scroll active concerns matching memory_id & user_id
  const scrollUrl = `${env.QDRANT_URL.replace(/\/+$/, "")}/collections/${CONCERNS_COLLECTION}/points/scroll`;
  const res = await qdrantFetch(scrollUrl, env, {
    method: "POST",
    body: JSON.stringify({
      limit: 50,
      filter: {
        must: [
          { key: "user_id", match: { value: userId } },
          { key: "memory_id", match: { value: memoryId } }
        ]
      },
      with_payload: true,
      with_vector: false
    })
  });

  if (!res.ok) return 0;

  const data: any = await res.json();
  const concernPoints: any[] = data.result?.points || [];
  const pointIds = concernPoints.map((p: any) => p.id);

  if (pointIds.length === 0) return 0;

  let newStatus: ConcernStatus = "resolved";
  if (verdict === "DEFERRED") newStatus = "deferred";
  if (verdict === "ESCALATED_TO_USER") newStatus = "escalated_to_user";

  const updatePayload: Partial<CognitiveConcernPayload> = {
    status: newStatus,
    doctor_case_id: caseId,
    doctor_verdict: verdict,
    doctor_treatment: treatment,
    doctor_notes: doctorNotes,
    updated_at: nowIso,
    resolved_at: verdict === "RESOLVED" ? nowIso : undefined
  };

  const payloadUrl = `${env.QDRANT_URL.replace(/\/+$/, "")}/collections/${CONCERNS_COLLECTION}/points/payload?wait=true`;
  await qdrantFetch(payloadUrl, env, {
    method: "POST",
    body: JSON.stringify({
      points: pointIds,
      payload: updatePayload
    })
  });

  return pointIds.length;
}


