/**
 * MCP Protocol Layer & ACTD Cognitive Memory Tools Execution
 */

import {
  S_AXIS,
  decaySpectrum,
  injectIntent,
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
  getPointById,
  setPointPayload,
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
        },
        include_retired: {
          type: "boolean",
          description: "是否包含已主动废弃/归档的记忆。默认 false (物理屏蔽，彻底避免幽灵干扰)"
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
        },
        include_retired: {
          type: "boolean",
          description: "是否包含已主动废弃/归档的记忆。默认 false"
        }
      },
      required: ["date"]
    }
  },
  {
    name: "confirm_memory",
    description: "【闭环关键工具】当用户确认某条记忆（特别是处于 🟡 临界待核实 状态）仍然有效成立时调用。刷新强验证时间戳 t_last_strong，注入强信号意图热度，使其重归 🟢 确信有效 状态。若该记忆已被废弃，可传入 revive: true 进行复活推翻。",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "待确证的记忆 ID (UUID)"
        },
        note: {
          type: "string",
          description: "确证补充说明（可选，例如记录用户最新确认时的补充背景）"
        },
        c_h: {
          type: "number",
          description: "修正或提升的人基常度 C_H (可选，若用户明确其为更长期规则可直接升级)"
        },
        revive: {
          type: "boolean",
          description: "若目标记忆已处于废弃归档状态，传入 true 可推翻废弃并满血复活该记忆"
        }
      },
      required: ["id"]
    }
  },
  {
    name: "retire_memory",
    description: "主动将某条过时、已被推翻或废弃的记忆置为失效（静默沉淀态）。清除能量与常度，归档沉淀，未来检索将自动物理静默，彻底避免幽灵干扰。",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "待废弃的记忆 ID (UUID)"
        },
        reason: {
          type: "string",
          description: "废弃原因（例如：'架构方案已迁移至方案 B' 或 '该传闻已被辟谣'）"
        }
      },
      required: ["id", "reason"]
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
  },
  {
    name: "save_note",
    description: "【极简记事本/客观存根】当用户要求'帮我记着点...'、需要原汁原味记录一段备忘/代码/URI，或者 LLM 自身需要工具性准确存储数据片段时调用。内容原样忠实保存（上限 10KB），支持可选的独立 BASE64 槽（上限 10KB，不参与向量化）。常度与生命周期由调用者自由控制。",
    inputSchema: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description: "核心记录内容（用户的原话、待办备忘、指令、代码片段、URI 等）。原样保存，上限 10KB。"
        },
        title: {
          type: "string",
          description: "可选。简短标题或语义描述（例如'本地MinIO服务地址'、'猫咪咖啡店位置'），帮助未来更精准召回。"
        },
        base64: {
          type: "string",
          description: "可选。专属二进制载荷槽（如小图片/图标的 Base64 字符串、小数据指纹）。上限 10KB，不参与向量化，纯作为物理存根保留。"
        },
        mime_type: {
          type: "string",
          description: "可选。若提供了 base64，注明数据类型（例如 'image/png', 'image/jpeg', 'application/json' 等）"
        },
        c_h: {
          type: "number",
          description: "可选人基常度 C_H。由 LLM 自由评估：7.8=短期临时便签; 8.8=本周待办; 11.0=长期常青存根。默认 11.0。"
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "可选。自由分类/状态标签（例如 ['todo', 'config']，也可以打 ['已办', '存档', '过时']）"
        }
      },
      required: ["content"]
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
    const includeRetired = Boolean(args.include_retired);

    const queryVector = await getEmbedding(query, env, "query");
    const candidates = await searchMemoryPoints(queryVector, userId, limit * 3, env, {
      type: args.type,
      entity: args.entity
    });

    const evaluatedList: EvaluatedMemory[] = [];

    for (const item of candidates) {
      const p: MemoryPointPayload = item.payload;
      if (!p) continue;

      const isRetired = Boolean(p.retired);
      if (isRetired && !includeRetired) {
        continue; // Strictly filter out retired memories by default
      }

      const similarityScore = Number((item.score || 0).toFixed(4));

      if (isRetired) {
        const classification = classifyHealth(0.0, p.tags || [], p.type || "", true, p.retired_reason || "");
        // Severely penalize composite score for retired memories so they rank at the bottom
        const compositeScore = Number((similarityScore * 0.01).toFixed(4));
        evaluatedList.push({
          id: item.id,
          content: p.content,
          type: p.type,
          entities: p.entities || [],
          tags: p.tags || [],
          timestamp: p.timestamp,
          date: p.date,
          ch_prior: 0.0,
          ch_dynamic: 0.0,
          resonant_heat: 0.0,
          similarity_score: similarityScore,
          composite_score: compositeScore,
          validity: 0.0,
          status: classification.status,
          status_badge: classification.badge,
          prompt_guidance: classification.guidance,
          retired: true,
          retired_at: p.retired_at,
          retired_reason: p.retired_reason,
          title: p.title || undefined,
          base64: p.base64 || undefined,
          mime_type: p.mime_type || undefined
        });
        continue;
      }

      // 1. Continuous Lazy Decay from last persistent update to now
      const decayedH = decaySpectrum(p.h_spectrum || new Array(7).fill(0), p.t_last_update || nowMs, nowMs);
      
      // 2. Pure read-only evaluation (Zero artificial +0.4 bias!)
      // Bug fix: use nullish coalescing ?? so 0 is NOT replaced by 9.0!
      const chDynamic = computeDynamicCh(p.ch_prior ?? 9.0, decayedH);
      const resonantHeat = interpolateResonantHeat(decayedH, chDynamic);

      // 3. Compute Epistemic Health V (t_last_strong is NEVER updated by passive search)
      const V = computeEpistemicHealth(chDynamic, resonantHeat, p.t_last_strong || nowMs, nowMs);
      const classification = classifyHealth(V, p.tags || [], p.type || "", false, "");

      // 4. Semantic similarity score & Composite Ranking
      // Composite Score: Semantic score is primary; V modulates confidence (0.6 + 0.4 * V)
      const compositeScore = Number((similarityScore * (0.6 + 0.4 * V)).toFixed(4));

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
          ch_prior: p.ch_prior ?? 9.0,
          ch_dynamic: chDynamic,
          resonant_heat: Number(resonantHeat.toFixed(2)),
          similarity_score: similarityScore,
          composite_score: compositeScore,
          validity: V,
          status: classification.status,
          status_badge: classification.badge,
          prompt_guidance: classification.guidance,
          title: p.title || undefined,
          base64: p.base64 || undefined,
          mime_type: p.mime_type || undefined
        });
      }
    }

    // Sort by composite_score descending (balancing semantic relevance and temporal freshness)
    evaluatedList.sort((a, b) => (b.composite_score || 0) - (a.composite_score || 0));
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
    const includeRetired = Boolean(args.include_retired);
    const points = await getTimelinePoints(userId, date, env);

    const timeline: any[] = [];
    for (const p of points) {
      const payload: MemoryPointPayload = p.payload || {};
      const isRetired = Boolean(payload.retired);
      if (isRetired && !includeRetired) continue;

      if (isRetired) {
        const classification = classifyHealth(0.0, payload.tags || [], payload.type || "", true, payload.retired_reason || "");
        timeline.push({
          id: p.id,
          time: payload.timestamp ? new Date(payload.timestamp).toLocaleTimeString("zh-CN", { hour12: false }) : "",
          timestamp: payload.timestamp,
          type: payload.type,
          entities: payload.entities || [],
          content: payload.content,
          c_h: 0.0,
          ch_dynamic: 0.0,
          resonant_heat: 0.0,
          validity: 0.0,
          status: classification.status,
          status_badge: classification.badge,
          retired: true,
          retired_reason: payload.retired_reason,
          title: payload.title || undefined,
          base64: payload.base64 || undefined,
          mime_type: payload.mime_type || undefined
        });
        continue;
      }

      const decayedH = decaySpectrum(payload.h_spectrum || new Array(7).fill(0), payload.t_last_update || nowMs, nowMs);
      const chDynamic = computeDynamicCh(payload.ch_prior ?? 9.0, decayedH);
      const resonantHeat = interpolateResonantHeat(decayedH, chDynamic);
      const V = computeEpistemicHealth(chDynamic, resonantHeat, payload.t_last_strong || nowMs, nowMs);
      const classification = classifyHealth(V, payload.tags || [], payload.type || "", false, "");

      timeline.push({
        id: p.id,
        time: payload.timestamp ? new Date(payload.timestamp).toLocaleTimeString("zh-CN", { hour12: false }) : "",
        timestamp: payload.timestamp,
        type: payload.type,
        entities: payload.entities || [],
        content: payload.content,
        c_h: payload.ch_prior ?? 9.0,
        ch_dynamic: chDynamic,
        resonant_heat: Number(resonantHeat.toFixed(2)),
        validity: V,
        status: classification.status,
        status_badge: classification.badge,
        title: payload.title || undefined,
        base64: payload.base64 || undefined,
        mime_type: payload.mime_type || undefined
      });
    }

    return {
      date,
      count: timeline.length,
      timeline,
      prompt_hint: "请参考上述时间线碎片与常热动力学指标 (c_h, validity, status_badge)，提炼并生成结构清晰的每日研发日记（DevLog），并识别当天值得沉淀的高价值常青实体。"
    };
  }

  // 4. Tool: confirm_memory
  if (name === "confirm_memory") {
    const pointId = (args.id || "").trim();
    if (!pointId) throw new Error("Missing memory id");
    const note = (args.note || "").trim();
    const newCh = typeof args.c_h === "number" ? args.c_h : undefined;
    const revive = Boolean(args.revive);

    const point = await getPointById(pointId, env);
    if (!point || !point.payload || point.payload.user_id !== userId) {
      throw new Error(`Memory point '${pointId}' not found or unauthorized`);
    }

    const p = point.payload;

    if (p.retired && !revive) {
      throw new Error(`❌ 记忆 [${pointId}] 处于【已废弃归档】状态（原因: ${p.retired_reason || "无"}）。如需推翻废弃并满血复活，请明确传入 revive: true。`);
    }

    // 1. Decay to now
    const decayedH = decaySpectrum(p.h_spectrum || new Array(7).fill(0), p.t_last_update || nowMs, nowMs);
    // 2. Strong Signal Intent Injection
    const updatedH = injectIntent(decayedH, 1.0);
    // 3. Update C_H prior if specified (or restore default 9.0 if revived)
    const updatedChPrior = newCh !== undefined ? newCh : (p.retired ? 9.0 : (p.ch_prior ?? 9.0));
    const chDynamic = computeDynamicCh(updatedChPrior, updatedH);
    const resonantHeat = interpolateResonantHeat(updatedH, chDynamic);

    // 4. Refresh content
    let updatedContent = p.content;
    if (p.retired && revive) {
      // Strip retired header if present
      updatedContent = updatedContent.replace(/^【已废弃\/失效归档[^】]*】\s*\n?/, "");
    }
    if (note) {
      const dateTag = now.toISOString().slice(0, 10);
      updatedContent = `${updatedContent}\n\n【核实验证记录 (${dateTag})】: ${note}`;
    }

    const payloadUpdate: Partial<MemoryPointPayload> & Record<string, any> = {
      content: updatedContent,
      ch_prior: updatedChPrior,
      h_spectrum: updatedH,
      t_last_update: nowMs,
      t_last_strong: nowMs,
      retired: false,
      retired_at: undefined,
      retired_reason: undefined
    };

    await setPointPayload(pointId, payloadUpdate, env);

    const newV = computeEpistemicHealth(chDynamic, resonantHeat, nowMs, nowMs);
    const classification = classifyHealth(newV, p.tags || [], p.type || "", false, "");

    return {
      success: true,
      id: pointId,
      c_h: updatedChPrior,
      ch_dynamic: chDynamic,
      resonant_heat: Number(resonantHeat.toFixed(2)),
      validity: newV,
      status: classification.status,
      status_badge: classification.badge,
      message: p.retired
        ? `✅ 已成功推翻废弃并满血复活记忆 [${pointId}]。状态重归 ${classification.badge}。`
        : `✅ 已成功确证记忆 [${pointId}]。强验证时间戳已刷新至当前，状态重归 ${classification.badge}。`
    };
  }

  // 5. Tool: retire_memory
  if (name === "retire_memory") {
    const pointId = (args.id || "").trim();
    const reason = (args.reason || "").trim();
    if (!pointId || !reason) throw new Error("Missing id or reason");

    const point = await getPointById(pointId, env);
    if (!point || !point.payload || point.payload.user_id !== userId) {
      throw new Error(`Memory point '${pointId}' not found or unauthorized`);
    }

    const p = point.payload;
    const dateTag = now.toISOString().slice(0, 10);
    let retiredContent = p.content;
    if (!retiredContent.startsWith("【已废弃/失效归档")) {
      retiredContent = `【已废弃/失效归档 (${dateTag}) - 原因: ${reason}】\n${p.content}`;
    }

    // Preserve original p.type! Do NOT overwrite with "retired"!
    const payloadUpdate: Partial<MemoryPointPayload> & Record<string, any> = {
      content: retiredContent,
      retired: true,
      retired_at: new Date().toISOString(),
      retired_reason: reason,
      ch_prior: 0.0,
      h_spectrum: new Array(7).fill(0),
      t_last_update: nowMs,
      t_last_strong: nowMs - 100000000000 // force V to 0
    };

    await setPointPayload(pointId, payloadUpdate, env);

    return {
      success: true,
      id: pointId,
      validity: 0.0,
      status: "DORMANT",
      status_badge: "⚪ 已废弃归档 (Retired)",
      message: `📦 记忆 [${pointId}] 已标记为废弃归档 (原因: ${reason})。未来检索将自动物理屏蔽，彻底避免幽灵干扰。`
    };
  }

  // 6. Tool: upsert_entity
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

  // 7. Tool: save_note
  if (name === "save_note") {
    const content = (args.content || "").trim();
    if (!content) throw new Error("Missing content");
    if (content.length > 10240) {
      throw new Error(`content 超过 10KB 限制 (当前: ${content.length} 字符)。便签请保持轻量，大文件请使用专用对象存储服务。`);
    }

    const title = (args.title || "").trim();
    if (title.length > 256) {
      throw new Error(`title 超过 256 字符限制 (当前: ${title.length} 字符)。`);
    }

    const base64 = (args.base64 || "").trim();
    if (base64.length > 10240) {
      throw new Error(`base64 载荷超过 10KB 限制 (当前: ${base64.length} 字符)。如需上传大图或大文件，请使用专用图库/存储服务。`);
    }

    const mimeType = (args.mime_type || "").trim();
    const chPrior = typeof args.c_h === "number" ? args.c_h : 11.0;
    const tags = Array.isArray(args.tags) ? args.tags.map(t => String(t).trim()).filter(Boolean) : [];
    if (!tags.includes("note")) tags.push("note");

    // Pure semantic embedding: embed title + content, strictly omit base64
    const textToEmbed = title ? `${title}\n${content}` : content;
    const vector = await getEmbedding(textToEmbed, env, "document");

    const initialSpectrum = injectIntent(new Array(7).fill(0), 1.0);
    const pointId = crypto.randomUUID();

    const payload: MemoryPointPayload = {
      user_id: userId,
      content,
      timestamp: now.toISOString(),
      date: todayStr,
      type: "note",
      entities: [],
      tags,
      ch_prior: chPrior,
      h_spectrum: initialSpectrum,
      t_last_update: nowMs,
      t_last_strong: nowMs,
      title: title || undefined,
      base64: base64 || undefined,
      mime_type: mimeType || undefined
    };

    await upsertMemoryPoint(pointId, vector, payload, env);

    const expectedHours = (Math.pow(10, chPrior) / 3600000).toFixed(1);
    return {
      success: true,
      id: pointId,
      type: "note",
      c_h: chPrior,
      title: title || undefined,
      has_base64: Boolean(base64),
      base64_length: base64 ? base64.length : 0,
      mime_type: mimeType || undefined,
      tags,
      stable_expected: `约 ${expectedHours} 小时`,
      message: `📝 已原样存入记事本 [ID: ${pointId}, 常度: ${chPrior}${base64 ? `, 附带 ${base64.length} 字符 BASE64 载荷` : ""}]`
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
