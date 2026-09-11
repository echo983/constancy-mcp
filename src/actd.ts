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
  validity: number;       // V in [0, 1]
  status: HealthStatus;
  status_badge: string;
  prompt_guidance: string;
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
 * Injects intent energy across scales using scale-sensitive kernel
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
 */
export function classifyHealth(V: number): {
  status: HealthStatus;
  badge: string;
  guidance: string;
} {
  if (V >= 0.7) {
    return {
      status: "FRESH",
      badge: "🟢 确信有效 (Fresh)",
      guidance: "可直接作为坚实先验引用，无需向用户多余确认。"
    };
  } else if (V >= 0.2) {
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
