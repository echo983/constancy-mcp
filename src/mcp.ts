/**
 * MCP Protocol Layer & ACTD Cognitive Memory Tools Execution
 */

import {
  S_AXIS,
  decaySpectrum,
  injectIntent,
  exciteWorkingMemory,
  computeDynamicCh,
  interpolateResonantHeat,
  computeEpistemicHealth,
  classifyHealth,
  EvaluatedMemory,
  MemoryPointPayload
} from "./actd";
import { getEmbedding, VoyageEnv } from "./voyage";
import {
  upsertMemoryPoint,
  searchMemoryPoints,
  getTimelinePoints,
  updatePointSpectrum,
  QdrantEnv
} from "./qdrant";

export interface McpEnv extends VoyageEnv, QdrantEnv {}

export const MCP_TOOLS = [
  {
    name: "log_memory",
    description: "主动向人基常热记忆体写入一条重要认知碎片、决策或事实。系统会自动维护 7 维时间能量谱与衰减周期。",
    inputSchema: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description: "核心内容（纯 Markdown 格式）。尽量客观准确，提炼事实与决策核心。"
        },
        c_h: {
          type: "number",
          description: "预期人基常度 C_H (可选)。参考值: 7.8=天气/时效预报; 8.8=本周任务; 9.8=季度架构决策; 11.0+=长期常青硬件事实。默认 9.0 (约11.5天)。"
        },
        type: {
          type: "string",
          enum: ["insight", "decision", "event", "memo", "entity"],
          description: "记录类型。默认 insight"
        },
        entities: {
          type: "array",
          items: { type: "string" },
          description: "涉及的专有名词或实体清单（如 ['ramws', 'Duplicacy', 'Pixel 6a']）"
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "主题分类标签（如 ['linux', 'backup']）"
        }
      },
      required: ["content"]
    }
  },
  {
    name: "search_memory",
    description: "按语义意图检索历史记忆。系统会自动代入 ACTD 动力学连续懒衰减，并计算时效健康度 V。返回带有 [🟢确信有效] 或 [🟡临界待核实] 状态标签的记忆卡片。",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "搜索问题或查询意图"
        },
        limit: {
          type: "number",
          description: "返回的最大有效记忆数量，默认 5"
        },
        type: {
          type: "string",
          description: "限定类型过滤 (可选，如 insight, decision, event, entity, memo)"
        },
        entity: {
          type: "string",
          description: "限定实体过滤 (可选)"
        },
        min_validity: {
          type: "number",
          description: "时效健康度 V 门槛 (0.0 ~ 1.0)。默认 0.2 (自动过滤 ⚪ 蒸发态/Dormant 记忆；设为 0.7 可仅查看 🟢 确信有效)"
        }
      },
      required: ["query"]
    }
  },
  {
    name: "get_daily_timeline",
    description: "按时间顺序提取指定日期的全部记忆碎片，包含常度 C_H、热度与时效健康状态，用于自动化生成每日研发日记（DevLog）或工作复盘。",
    inputSchema: {
      type: "object",
      properties: {
        date: {
          type: "string",
          description: "日期字符串，格式 YYYY-MM-DD (例如 2026-09-11)"
        }
      },
      required: ["date"]
    }
  },
  {
    name: "upsert_entity",
    description: "登记或更新跨越周期的核心实体百科（如硬件参数、系统架构组件、团队规范），赋予高阶基石常度 (C_H ≥ 11.0, 长期常青基石)。",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "实体名称（例如 'Duplicacy' 或 'ramws'）"
        },
        description: {
          type: "string",
          description: "实体的确切定义、背景与核心属性规范 (Markdown)"
        },
        aliases: {
          type: "array",
          items: { type: "string" },
          description: "实体的常用别名 (例如 ['ramcp', 'ramrs'])"
        },
        relations: {
          type: "array",
          items: { type: "string" },
          description: "关联的其他实体名称"
        }
      },
      required: ["name", "description"]
    }
  }
];

// Execute MCP Tool Calls
export async function executeToolCall(
  name: string,
  args: any,
  userId: string,
  env: McpEnv,
  ctx?: ExecutionContext
): Promise<any> {
  const now = new Date();
  const nowMs = now.getTime();
  const todayStr = now.toISOString().slice(0, 10);

  // 1. Tool: log_memory
  if (name === "log_memory") {
    const content = (args.content || "").trim();
    if (!content) throw new Error("Missing content");

    const chPrior = typeof args.c_h === "number" ? args.c_h : 9.0;
    const type = args.type || "insight";
    const entities = Array.isArray(args.entities) ? args.entities : [];
    const tags = Array.isArray(args.tags) ? args.tags : [];

    // Initial energy injection
    const initialSpectrum = injectIntent(new Array(7).fill(0), 1.0);

    const payload: MemoryPointPayload = {
      user_id: userId,
      content,
      timestamp: now.toISOString(),
      date: todayStr,
      type,
      entities,
      tags,
      ch_prior: chPrior,
      h_spectrum: initialSpectrum,
      t_last_update: nowMs,
      t_last_strong: nowMs
    };

    // Vectorize via Voyage AI
    const vector = await getEmbedding(content, env, "document");
    const pointId = crypto.randomUUID();

    await upsertMemoryPoint(pointId, vector, payload, env);

    const expectedHours = (Math.pow(10, chPrior) / 3600000).toFixed(1);
    return {
      success: true,
      id: pointId,
      c_h: chPrior,
      stable_expected: `约 ${expectedHours} 小时`,
      message: `✅ 已成功存入人基常热记忆体 [常度: ${chPrior}, 预期基础稳定期: ${expectedHours}h]`
    };
  }

  // 2. Tool: search_memory
  if (name === "search_memory") {
    const query = (args.query || "").trim();
    if (!query) throw new Error("Missing query");
    const limit = Math.min(Math.max(parseInt(args.limit) || 5, 1), 20);
    const minValidity = typeof args.min_validity === "number" ? Math.max(0, Math.min(1, args.min_validity)) : 0.2;

    const queryVector = await getEmbedding(query, env, "query");
    const candidates = await searchMemoryPoints(queryVector, userId, limit * 3, env, {
      type: args.type,
      entity: args.entity
    });

    const evaluatedList: EvaluatedMemory[] = [];

    for (const item of candidates) {
      const p: MemoryPointPayload = item.payload;
      if (!p) continue;

      // 1. Continuous Lazy Decay from last persistent update to now
      const decayedH = decaySpectrum(p.h_spectrum || new Array(7).fill(0), p.t_last_update || nowMs, nowMs);
      
      // 2. Weak Signal (Passive Search Probe):
      // Only excite short-wave working memory (s=0, 10-minute focus window)
      // Zero long-wave penetration (k >= 3), strictly preventing artificial C_H inflation
      const activeH = exciteWorkingMemory(decayedH, 0.4);

      // 3. Compute dynamic C_H and resonant heat
      // Dynamic C_H remains tied to genuine long-wave consolidation, immune to read probes
      const chDynamic = computeDynamicCh(p.ch_prior || 9.0, decayedH);
      const resonantHeat = interpolateResonantHeat(activeH, chDynamic);

      // 4. Compute Epistemic Health V (t_last_strong is NEVER updated by passive search)
      const V = computeEpistemicHealth(chDynamic, resonantHeat, p.t_last_strong || nowMs, nowMs);
      const classification = classifyHealth(V);

      // Note: Passive search does NOT write back to persistent Qdrant!
      // This eliminates write amplification and prevents the "Ghost Resuscitation" feedback loop.

      // 5. Filter by min_validity threshold (default >= 0.2, discarding DORMANT)
      if (V >= minValidity) {
        evaluatedList.push({
          id: item.id,
          content: p.content,
          type: p.type,
          entities: p.entities || [],
          tags: p.tags || [],
          timestamp: p.timestamp,
          date: p.date,
          ch_prior: p.ch_prior,
          ch_dynamic: chDynamic,
          resonant_heat: Number(resonantHeat.toFixed(2)),
          validity: V,
          status: classification.status,
          status_badge: classification.badge,
          prompt_guidance: classification.guidance
        });
      }
    }

    // Sort by Epistemic Health V descending
    evaluatedList.sort((a, b) => b.validity - a.validity);
    const results = evaluatedList.slice(0, limit);

    return {
      query,
      found_count: results.length,
      memories: results
    };
  }

  // 3. Tool: get_daily_timeline
  if (name === "get_daily_timeline") {
    const date = (args.date || todayStr).trim();
    const points = await getTimelinePoints(userId, date, env);

    const timeline = points.map((p: any) => {
      const payload: MemoryPointPayload = p.payload || {};
      const decayedH = decaySpectrum(payload.h_spectrum || new Array(7).fill(0), payload.t_last_update || nowMs, nowMs);
      const chDynamic = computeDynamicCh(payload.ch_prior || 9.0, decayedH);
      const resonantHeat = interpolateResonantHeat(decayedH, chDynamic);
      const V = computeEpistemicHealth(chDynamic, resonantHeat, payload.t_last_strong || nowMs, nowMs);
      const classification = classifyHealth(V);

      return {
        id: p.id,
        time: payload.timestamp ? new Date(payload.timestamp).toLocaleTimeString("zh-CN", { hour12: false }) : "",
        timestamp: payload.timestamp,
        type: payload.type,
        entities: payload.entities || [],
        content: payload.content,
        c_h: payload.ch_prior,
        ch_dynamic: chDynamic,
        resonant_heat: Number(resonantHeat.toFixed(2)),
        validity: V,
        status: classification.status,
        status_badge: classification.badge
      };
    });

    return {
      date,
      count: timeline.length,
      timeline,
      prompt_hint: "请参考上述时间线碎片与常热动力学指标 (c_h, validity, status_badge)，提炼并生成结构清晰的每日研发日记（DevLog），并识别当天值得沉淀的高价值常青实体。"
    };
  }

  // 4. Tool: upsert_entity
  if (name === "upsert_entity") {
    const entityName = (args.name || "").trim();
    const desc = (args.description || "").trim();
    if (!entityName || !desc) throw new Error("Missing name or description");

    const fullContent = `【核心实体: ${entityName}】\n${desc}\n(别名: ${(args.aliases || []).join(", ") || "无"})`;
    // Entities inherently enjoy foundation constancy (C_H >= 11.5)
    const chPrior = 11.5;
    const initialSpectrum = injectIntent(new Array(7).fill(1.5), 1.0);

    const payload: MemoryPointPayload = {
      user_id: userId,
      content: fullContent,
      timestamp: now.toISOString(),
      date: todayStr,
      type: "entity",
      entities: [entityName, ...(args.aliases || []), ...(args.relations || [])],
      tags: ["entity_registry", "core_knowledge"],
      ch_prior: chPrior,
      h_spectrum: initialSpectrum,
      t_last_update: nowMs,
      t_last_strong: nowMs
    };

    const vector = await getEmbedding(fullContent, env, "document");
    const pointId = crypto.randomUUID();
    await upsertMemoryPoint(pointId, vector, payload, env);

    return {
      success: true,
      entity: entityName,
      c_h: chPrior,
      message: `🏛️ 已成功将实体 '${entityName}' 固化至核心实体百科清单 (常度: 11.5，百年基石级)`
    };
  }

  throw new Error(`Unknown tool: ${name}`);
}

// JSON-RPC 2.0 Dispatcher for MCP
export async function handleMcpJsonRpc(
  body: any,
  userId: string,
  env: McpEnv,
  ctx?: ExecutionContext
): Promise<any> {
  const { id, method, params } = body || {};

  // 1. initialize
  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: {
          tools: {
            listChanged: false
          }
        },
        serverInfo: {
          name: "constancy-mcp",
          version: "1.0.0",
          description: "Anthropocentric Chrono-Thermal Dynamics (ACTD) Cognitive Memory MCP Server"
        }
      }
    };
  }

  // 2. notifications/initialized
  if (method === "notifications/initialized") {
    return null; // Notifications don't receive responses
  }

  // 3. ping
  if (method === "ping") {
    return { jsonrpc: "2.0", id, result: {} };
  }

  // 4. tools/list
  if (method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        tools: MCP_TOOLS
      }
    };
  }

  // 5. tools/call
  if (method === "tools/call") {
    const { name, arguments: toolArgs } = params || {};
    try {
      const output = await executeToolCall(name, toolArgs, userId, env, ctx);
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [
            {
              type: "text",
              text: typeof output === "string" ? output : JSON.stringify(output, null, 2)
            }
          ]
        }
      };
    } catch (err: any) {
      return {
        jsonrpc: "2.0",
        id,
        isError: true,
        result: {
          content: [
            {
              type: "text",
              text: `Error executing ${name}: ${err.message}`
            }
          ]
        }
      };
    }
  }

  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: -32601,
      message: `Method not found: ${method}`
    }
  };
}
