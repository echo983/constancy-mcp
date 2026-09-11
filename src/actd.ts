/**
 * Anthropocentric Chrono-Thermal Dynamics (ACTD v1.0)
 * Mathematical Engine for Cognitive Memory & Adaptive Forgetting
 */

export const S_AXIS = [0, 1, 2, 3, 4, 5, 6];
export const KAPPA = 4.77815; // C_H = s + 4.78
export const LAMBDA = 0.5;   // Scale injection kernel factor
export const GAMMA = 0.4;    // Long-wave resonance promotion factor

export interface MemoryPointPayload {
  user_id: string;
  content: string;
  timestamp: string;      // ISO8601 creation time
  date: string;           // YYYY-MM-DD
  type: string;           // 'insight' | 'decision' | 'event' | 'entity' | 'memo'
  entities: string[];     // extracted entity keywords
  tags: string[];
  
  // ACTD Dynamic State
  ch_prior: number;       // Inherent baseline constancy
  h_spectrum: number[];   // 7-dim float vector for s=0..6
  t_last_update: number;  // Epoch ms
  t_last_strong: number;  // Epoch ms
  // Explicit Retirement Lifecycle Fields
  retired?: boolean;
  retired_at?: string;
  retired_reason?: string;

  // Optional Note & Raw Scratchpad Fields
  title?: string;
  base64?: string;
  mime_type?: string;
  sha256?: string;
  revisions?: NoteRevision[];
}

export interface NoteRevision {
  timestamp: string;      // ISO8601 when this snapshot was created/archived
  content: string;
  title?: string;
  tags?: string[];
  mime_type?: string;
  sha256?: string;
}

export type HealthStatus = "FRESH" | "DRIFTING" | "DORMANT";

export interface EvaluatedMemory {
  id: string;
  content: string;
  type: string;
  entities: string[];
  tags: string[];
  timestamp: string;
  date: string;
  ch_prior: number;
  ch_dynamic: number;
  resonant_heat: number;
  similarity_score?: number; // Semantic Cosine similarity from Qdrant
  composite_score?: number;  // Combined ranking score (semantic * temporal validity)
  validity: number;          // V in [0, 1]
  status: HealthStatus;
  status_badge: string;
  prompt_guidance: string;
  retired?: boolean;
  retired_at?: string;
  retired_reason?: string;

  // Optional Note & Raw Scratchpad Fields
  title?: string;
  has_base64?: boolean;
  base64_length?: number;
  mime_type?: string;
  sha256?: string;
  revisions_count?: number;
}

/**
 * Continuous-time lazy decay operator for 7-scale Multi-EMA
 */
export function decaySpectrum(
  h: number[],
  lastUpdateMs: number,
  nowMs: number
): number[] {
  const deltaMinutes = Math.max(0, (nowMs - lastUpdateMs) / 60000);
  if (deltaMinutes <= 0) return [...h];

  return h.map((val, k) => {
    const halfLifeMinutes = Math.pow(10, S_AXIS[k]);
    const decayFactor = Math.pow(0.5, deltaMinutes / halfLifeMinutes);
    return val * decayFactor;
  });
}

/**
 * Injects intent energy across scales using scale-sensitive kernel (Strong Signal)
 * Used for log_memory, upsert_entity, or explicit human/agent active affirmation.
 */
export function injectIntent(
  h: number[],
  weight: number = 1.0,
  lambda: number = LAMBDA
): number[] {
  return h.map((val, k) => {
    const scaleKernel = Math.exp(-lambda * S_AXIS[k]);
    return val + weight * scaleKernel;
  });
}

/**
 * Excites transient working memory for passive retrieval probes (Weak Signal)
 * Only impacts s=0 (1-minute half-life, 10-minute attention span).
 * Strictly zero leakage into long-wave channels (k >= 3), preventing artificial C_H inflation.
 */
export function exciteWorkingMemory(h: number[], weight: number = 0.5): number[] {
  const next = [...h];
  next[0] = (next[0] || 0) + weight;
  return next;
}

/**
 * Calculates emergent dynamic constancy from long-wave spectral resonance
 */
export function computeDynamicCh(chPrior: number, h: number[]): number {
  // Long-wave channels: k=4 (1w), k=5 (2.3m), k=6 (2y)
  const longWaveEnergy = (h[4] || 0) * 0.5 + (h[5] || 0) * 1.2 + (h[6] || 0) * 2.5;
  const promotion = GAMMA * Math.log1p(longWaveEnergy);
  return Number((chPrior + promotion).toFixed(2));
}

/**
 * Interpolates resonant heat matching the proposition's dynamic constancy
 */
export function interpolateResonantHeat(h: number[], chDynamic: number): number {
  const targetS = Math.min(Math.max(chDynamic - KAPPA, 0), 6);
  const floorIdx = Math.floor(targetS);
  const ceilIdx = Math.min(floorIdx + 1, 6);
  const frac = targetS - floorIdx;

  const h0 = h[floorIdx] || 0;
  const h1 = h[ceilIdx] || 0;
  return h0 + (h1 - h0) * frac;
}

/**
 * Computes the Epistemic Health Index (V in [0, 1])
 */
export function computeEpistemicHealth(
  chDynamic: number,
  resonantHeat: number,
  lastStrongMs: number,
  nowMs: number
): number {
  const deltaMs = Math.max(0, nowMs - lastStrongMs);
  const stableDurationMs = Math.pow(10, chDynamic);

  const exponent = -(deltaMs / stableDurationMs) / (1 + Math.log1p(Math.max(0, resonantHeat)));
  const V = Math.exp(exponent);
  return Math.min(Math.max(Number(V.toFixed(4)), 0), 1);
}

/**
 * Classifies proposition health into the 3-state decision machine
 * Integrates retirement status and epistemic veracity (fact vs unverified rumor/memo)
 */
export function classifyHealth(
  V: number,
  tags: string[] = [],
  type: string = "",
  retired: boolean = false,
  retiredReason: string = ""
): {
  status: HealthStatus;
  badge: string;
  guidance: string;
} {
  if (retired) {
    return {
      status: "DORMANT",
      badge: "⚪ 已废弃归档 (Retired)",
      guidance: `⚠️ 该记录已被主动标记废弃（原因: ${retiredReason || "无"}），仅作历史审计，严禁作为有效事实使用！`
    };
  }

  // Handle Raw Notes & Objective Stubs
  if (type === "note") {
    if (V >= 0.7) {
      return {
        status: "FRESH",
        badge: "📝 原始便签 (Raw Note / 存根)",
        guidance: "原样记录，保真可信；但环境类信息（地址、端口、版本）可能已变化，使用前视时效核实。"
      };
    } else if (V >= 0.2) {
      return {
        status: "DRIFTING",
        badge: "🟡 临界便签 (Drifting Note)",
        guidance: "该便签/存根已跨越预期时效期，若涉及具体待办或临时配置，请向用户核实是否仍然有效。"
      };
    } else {
      return {
        status: "DORMANT",
        badge: "⚪ 静默沉淀 (Dormant)",
        guidance: "该便签处于休眠过期状态，常规场景应被静默过滤。"
      };
    }
  }

  const isUnverified = tags.some(t => 
    ["unverified", "rumor", "speculation", "hearsay", "传闻", "未证实"].includes(t.toLowerCase())
  );

  const isPreference = tags.some(t => 
    ["preference", "profile", "subjective", "偏好", "习惯", "自陈"].includes(t.toLowerCase())
  );

  if (V >= 0.7) {
    if (isUnverified) {
      return {
        status: "FRESH",
        badge: "🟢 确信时效 (Fresh / 未证实)",
        guidance: "该信息处于新鲜时效期内，但其属性为【未证实传闻】。向用户表达时必须明确说明信源背景与未证实属性，严禁断言为既成事实。"
      };
    }
    if (isPreference) {
      return {
        status: "FRESH",
        badge: "🟢 确信偏好 (Fresh / 个人自陈)",
        guidance: "这是用户关于自身偏好或习惯的自述，具有最高权威，可直接采信作为行为准则（但注意可能随时间演化）。"
      };
    }
    return {
      status: "FRESH",
      badge: "🟢 确信有效 (Fresh)",
      guidance: "可直接作为坚实先验引用，无需向用户多余确认。"
    };
  } else if (V >= 0.2) {
    if (isUnverified) {
      return {
        status: "DRIFTING",
        badge: "🟡 临界待核实 (Drifting / 未证实)",
        guidance: "该未证实传闻已跨越常规讨论周期，极可能已辟谣或落地，必须向用户核实最新进展。"
      };
    }
    if (isPreference) {
      return {
        status: "DRIFTING",
        badge: "🟡 临界偏好 (Drifting / 偏好演化)",
        guidance: "这是用户的历史偏好或习惯，但已跨越常规讨论周期，人的偏好或习惯可能随时间演化，请在回答时审慎向用户核实。"
      };
    }
    return {
      status: "DRIFTING",
      badge: "🟡 临界待核实 (Drifting)",
      guidance: "该记录已跨越预期稳定期，禁止武断定性，请在回答中委婉、审慎地向用户核实现状。"
    };
  } else {
    return {
      status: "DORMANT",
      badge: "⚪ 静默沉淀 (Dormant)",
      guidance: "该记录处于休眠过期状态，常规场景应被静默过滤。"
    };
  }
}
