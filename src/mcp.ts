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
  MemoryPointPayload,
  NoteRevision
} from "./actd";
import { getEmbedding, VoyageEnv } from "./voyage";
import {
  upsertMemoryPoint,
  searchMemoryPoints,
  getTimelinePoints,
  updatePointSpectrum,
  getPointById,
  setPointPayload,
  scrollNotes,
  QdrantEnv
} from "./qdrant";
import { computeBase64Sha256, generateBlobSig } from "./blob";

export interface McpEnv extends VoyageEnv, QdrantEnv {
  JWT_SECRET: string;
  DOMAIN: string;
  CLOUDFLARE_API_TOKEN?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
}

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
        },
        image_url: {
          type: "string",
          description: "多模态检索：提供图片的公开或签名 URL，与 query 联合进行跨模态语义检索 (可选)"
        },
        image_base64: {
          type: "string",
          description: "多模态检索：提供图片的 Base64 编码数据 (支持 PNG/JPEG/WEBP/GIF，可选)"
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
    description: "【极简记事本/客观存根】当用户要求'帮我记着点...'、需要原汁原味记录一段备忘/代码/URI，或者 LLM 自身需要工具性准确存储数据片段时调用。内容原样忠实保存（上限 10KB），支持可选的独立 BASE64 槽（上限 10KB，不参与向量化，自动计算服务端 SHA-256 校验和）。默认常度 8.8 (配置/速查类 11.0)。常度与生命周期由调用者自由控制。",
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
          description: "可选。专属二进制载荷槽（如小图片/图标的 Base64 字符串、小数据指纹）。上限 10KB，不参与向量化，自动计算服务端 SHA-256。"
        },
        mime_type: {
          type: "string",
          description: "可选。若提供了 base64，注明数据类型（例如 'image/png', 'image/jpeg', 'application/json' 等）"
        },
        c_h: {
          type: "number",
          description: "可选人基常度 C_H。默认 8.8 (约1~2周迭代周期)；若 tags 包含 config 或 cheatsheet 则自动升为 11.0 (约3年长期存根)。"
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "可选。自由分类/状态标签（例如 ['todo']、['config', 'ops']、['已办'] 等）"
        }
      },
      required: ["content"]
    }
  },
  {
    name: "get_note",
    description: "按 ID 精确获取指定便签或存根的完整数据，包括完整内容、Base64 载荷、SHA-256 校验和及历史修改审计链 (revisions)。当 search_memory 检索发现 has_base64: true 且确实需要获取原始二进制数据时按需调用。",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "便签或存根的记忆 ID (UUID)"
        }
      },
      required: ["id"]
    }
  },
  {
    name: "list_notes",
    description: "【枚举列出便签/存根】确定性枚举用户的便签与存根（基于 Qdrant scroll，非向量相似度搜索，杜绝阈值截断漏选）。适用于'我有哪些待办'、'列出所有配置存根'等需求。按时间倒序排列。",
    inputSchema: {
      type: "object",
      properties: {
        tag: {
          type: "string",
          description: "可选。指定分类标签过滤（例如 'todo', 'config', 'dev', '已办' 等）。不传则列出所有便签。"
        },
        limit: {
          type: "number",
          description: "可选。返回数量限制，默认 20，最大 100。"
        },
        include_retired: {
          type: "boolean",
          description: "可选。是否包含已归档/废弃的便签。默认 false。"
        }
      }
    }
  },
  {
    name: "update_note",
    description: "【编辑便签/更新存根】修改已有便签的内容、标题、标签或常度。内容改动时自动重新计算向量嵌入。系统自动保留历史版本（revisions 审计链，最多保留最近 5 版）。可用于将待办标签从 todo 更新为 已办，或追加新备忘。",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "待更新的便签 ID (UUID)"
        },
        content: {
          type: "string",
          description: "可选。新的便签内容。当 mode 为 'replace' 时直接替换；为 'append' 时追加在原内容末尾（附换行）。上限 10KB。"
        },
        mode: {
          type: "string",
          enum: ["replace", "append"],
          description: "可选。内容修改模式：'replace' (覆盖，默认) 或 'append' (追加)。"
        },
        title: {
          type: "string",
          description: "可选。更新简短标题或描述。"
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "可选。更新分类标签列表（例如将 ['todo'] 改为 ['已办']）。"
        },
        base64: {
          type: "string",
          description: "可选。更新 Base64 二进制载荷。上限 10KB。"
        },
        mime_type: {
          type: "string",
          description: "可选。更新 MIME 数据类型。"
        },
        c_h: {
          type: "number",
          description: "可选。更新人基常度 C_H。"
        }
      },
      required: ["id"]
    }
  },
  {
    name: "get_blob_url",
    description: "【生成二进制下载 Capability URL】为便签中存储的二进制数据生成具有短期时效（5分钟）的带签名直接下载链接。供客户端或 Claude 代码沙箱通过 curl 直接下载，完全避免大段 Base64 经过 LLM 对话上下文消耗 Token 或产生截断转义损耗。",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "便签或存根的 ID (UUID)"
        }
      },
      required: ["id"]
    }
  },
  {
    name: "create_upload_url",
    description: "【生成二进制直传 Capability URL】预分配便签 ID 并生成具有短期时效（5分钟）的带签名直接上传链接。允许客户端或 Claude 代码沙箱通过 curl -X PUT 直接将二进制文件流上传存入，完全不经过 LLM 对话上下文传输 Base64。",
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "可选。便签简短标题或语义描述（例如'系统架构拓扑图'、'应用图标'）"
        },
        content: {
          type: "string",
          description: "可选。便签说明或文本附注。上限 10KB。"
        },
        mime_type: {
          type: "string",
          description: "可选。上传数据的 MIME 类型（例如 'image/png', 'application/json' 等，默认 'application/octet-stream'）"
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "可选。分类标签（例如 ['diagram', 'arch']）"
        },
        c_h: {
          type: "number",
          description: "可选。人基常度 C_H，默认 8.8。"
        }
      }
    }
  },
  {
    name: "request_image_upload",
    description: "【申请 Cloudflare Images 直传凭据】预分配 Cloudflare Images 存储 ID 并生成 5 分钟有效的一次性直传 URL。用于 Claude 或客户端在本地沙箱中直接通过 curl 将图片二进制直传至 Cloudflare Images 永久图库，零 Token 上下文传输。上传成功后，请利用大模型原生视觉能力观察画面细节，调用 commit_image_record 将图片入库至后花园 (search.kufof.uk) 并生成关联便签。",
    inputSchema: {
      type: "object",
      properties: {
        filename: {
          type: "string",
          description: "可选。原始图片文件名 (例如 'datacenter_rack.jpg' 或 'flowchart.png')"
        }
      }
    }
  },
  {
    name: "commit_image_record",
    description: "【视觉资产与便签录入】将已上传至 Cloudflare Images 的图片录入 Qdrant 视觉图库（images 集合）并同步在 Constancy 便签库创建一条关联 Note 便签。由 Claude 发挥原生视觉大模型能力生成深度中文描述、识别画面主体细节、文字、坐标与标签。",
    inputSchema: {
      type: "object",
      properties: {
        image_id: {
          type: "string",
          description: "Cloudflare Images 分配的图片 ID (必填)"
        },
        description: {
          type: "string",
          description: "Claude 对图片的深度视觉描述，包括核心主体、关键细节、招牌/标签文字、环境场景等 (必填)"
        },
        title: {
          type: "string",
          description: "可选。图片简短标题 (例如 '核心交换机跳线分布图' / '徐家汇商圈夜景')"
        },
        filename: {
          type: "string",
          description: "可选。原始文件名"
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "可选。分类标签列表 (例如 ['hardware', 'network', 'cisco'])"
        },
        latitude: {
          type: "number",
          description: "可选。拍摄地点纬度 (例如 31.2304)"
        },
        longitude: {
          type: "number",
          description: "可选。拍摄地点经度 (例如 121.4737)"
        },
        exif: {
          type: "object",
          description: "可选。相机与拍摄参数元数据 (例如 { device, dateTime, lens, iso, aperture })"
        },
        create_note: {
          type: "boolean",
          description: "可选。是否同步在 Constancy 便签库创建一条关联 Note 便签，默认 true"
        }
      },
      required: ["image_id", "description"]
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
    const imageUrl = (args.image_url || "").trim() || undefined;
    const imageBase64 = (args.image_base64 || "").trim() || undefined;
    if (!query && !imageUrl && !imageBase64) throw new Error("Missing query or image input");

    const limit = Math.min(Math.max(parseInt(args.limit) || 5, 1), 20);
    const minValidity = typeof args.min_validity === "number" ? Math.max(0, Math.min(1, args.min_validity)) : 0.2;
    const includeRetired = Boolean(args.include_retired);

    const queryInput = (imageUrl || imageBase64)
      ? { text: query, imageUrl, imageBase64 }
      : query;

    const queryVector = await getEmbedding(queryInput, env, "query");
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
          has_base64: Boolean(p.base64),
          base64_length: p.base64 ? p.base64.length : undefined,
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
          has_base64: Boolean(p.base64),
          base64_length: p.base64 ? p.base64.length : undefined,
          sha256: p.sha256 || undefined,
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
          has_base64: Boolean(payload.base64),
          base64_length: payload.base64 ? payload.base64.length : undefined,
          sha256: payload.sha256 || undefined,
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
        has_base64: Boolean(payload.base64),
        base64_length: payload.base64 ? payload.base64.length : undefined,
        sha256: payload.sha256 || undefined,
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
    const tags = Array.isArray(args.tags) ? args.tags.map(t => String(t).trim()).filter(Boolean) : [];
    if (!tags.includes("note")) tags.push("note");

    const hasConfigOrCheatsheet = tags.some(t => {
      const lower = t.toLowerCase();
      return lower.includes("config") || lower.includes("cheatsheet") || lower.includes("速查") || lower.includes("配置");
    });
    const defaultCh = hasConfigOrCheatsheet ? 11.0 : 8.8;
    const chPrior = typeof args.c_h === "number" ? args.c_h : defaultCh;

    let sha256: string | undefined = undefined;
    if (base64) {
      sha256 = await computeBase64Sha256(base64);
    }

    // Multimodal semantic embedding: embed title + content, and include image payload if image attachment
    const textToEmbed = title ? `${title}\n${content}` : content;
    const hasImage = Boolean(base64 && mimeType.startsWith("image/"));
    const vector = await getEmbedding(
      hasImage
        ? { text: textToEmbed, imageBase64: base64, mimeType }
        : textToEmbed,
      env,
      "document"
    );

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
      sha256: sha256 || undefined,
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
      sha256: sha256 || undefined,
      mime_type: mimeType || undefined,
      tags,
      stable_expected: `约 ${expectedHours} 小时`,
      message: `📝 已原样存入记事本 [ID: ${pointId}, 常度: ${chPrior}${sha256 ? `, SHA-256: ${sha256}` : ""}${base64 ? `, 附带 ${base64.length} 字符 BASE64 载荷` : ""}]`
    };
  }

  // 8. Tool: get_note
  if (name === "get_note") {
    const pointId = (args.id || "").trim();
    if (!pointId) throw new Error("Missing note id");

    const point = await getPointById(pointId, env);
    if (!point || !point.payload || point.payload.user_id !== userId) {
      throw new Error(`Note '${pointId}' not found or unauthorized`);
    }

    const p = point.payload;

    let sha256 = p.sha256;
    if (!sha256 && p.base64) {
      sha256 = await computeBase64Sha256(p.base64);
      setPointPayload(pointId, { sha256 }, env).catch(() => {});
    }

    const exactBytes = p.base64 ? atob(p.base64).length : 0;

    // Sanitize revisions so they never contain large Base64 blobs
    const sanitizedRevisions = (p.revisions || []).map((r: any) => ({
      timestamp: r.timestamp,
      content: r.content,
      title: r.title,
      tags: r.tags,
      mime_type: r.mime_type,
      sha256: r.sha256
    }));

    return {
      id: point.id,
      type: p.type,
      title: p.title || undefined,
      content: p.content,
      base64: p.base64 || undefined,
      has_base64: Boolean(p.base64),
      base64_length: p.base64 ? p.base64.length : 0,
      size_bytes: exactBytes,
      sha256: sha256 || undefined,
      mime_type: p.mime_type || undefined,
      tags: p.tags || [],
      c_h: p.ch_prior,
      timestamp: p.timestamp,
      date: p.date,
      revisions: sanitizedRevisions,
      retired: Boolean(p.retired),
      retired_reason: p.retired_reason || undefined
    };
  }

  // 9. Tool: list_notes
  if (name === "list_notes") {
    const tag = typeof args.tag === "string" ? args.tag.trim() : undefined;
    const limit = Math.min(Math.max(typeof args.limit === "number" ? args.limit : 20, 1), 100);
    const includeRetired = Boolean(args.include_retired);

    const points = await scrollNotes(userId, tag, limit, includeRetired, env);
    const results: any[] = [];

    for (const pt of points) {
      const p: MemoryPointPayload = pt.payload || ({} as any);
      const isRetired = Boolean(p.retired);

      if (isRetired) {
        const classification = classifyHealth(0.0, p.tags || [], "note", true, p.retired_reason || "");
        results.push({
          id: pt.id,
          title: p.title || undefined,
          content: p.content,
          tags: p.tags || [],
          c_h: 0.0,
          ch_dynamic: 0.0,
          validity: 0.0,
          status: classification.status,
          status_badge: classification.badge,
          prompt_guidance: classification.guidance,
          timestamp: p.timestamp,
          date: p.date,
          has_base64: Boolean(p.base64),
          base64_length: p.base64 ? p.base64.length : 0,
          sha256: p.sha256 || undefined,
          mime_type: p.mime_type || undefined,
          revisions_count: Array.isArray(p.revisions) ? p.revisions.length : 0,
          retired: true,
          retired_reason: p.retired_reason
        });
        continue;
      }

      const decayedH = decaySpectrum(p.h_spectrum || new Array(7).fill(0), p.t_last_update || nowMs, nowMs);
      const chDynamic = computeDynamicCh(p.ch_prior ?? 8.8, decayedH);
      const resonantHeat = interpolateResonantHeat(decayedH, chDynamic);
      const V = computeEpistemicHealth(chDynamic, resonantHeat, p.t_last_strong || nowMs, nowMs);
      const classification = classifyHealth(V, p.tags || [], "note", false, "");

      results.push({
        id: pt.id,
        title: p.title || undefined,
        content: p.content,
        tags: p.tags || [],
        c_h: p.ch_prior ?? 8.8,
        ch_dynamic: chDynamic,
        validity: V,
        status: classification.status,
        status_badge: classification.badge,
        prompt_guidance: classification.guidance,
        timestamp: p.timestamp,
        date: p.date,
        has_base64: Boolean(p.base64),
        base64_length: p.base64 ? p.base64.length : 0,
        sha256: p.sha256 || undefined,
        mime_type: p.mime_type || undefined,
        revisions_count: Array.isArray(p.revisions) ? p.revisions.length : 0,
        retired: false
      });
    }

    return {
      tag: tag || undefined,
      found_count: results.length,
      notes: results
    };
  }

  // 10. Tool: update_note
  if (name === "update_note") {
    const pointId = (args.id || "").trim();
    if (!pointId) throw new Error("Missing note id");

    const point = await getPointById(pointId, env);
    if (!point || !point.payload || point.payload.user_id !== userId) {
      throw new Error(`Note '${pointId}' not found or unauthorized`);
    }

    const p = point.payload;
    if (p.type !== "note") {
      throw new Error(`Memory '${pointId}' is of type '${p.type}', not 'note'. Use appropriate memory tools to update.`);
    }

    // Save previous snapshot to revisions array (strictly metadata & sha256, no raw base64)
    const previousSnapshot: NoteRevision = {
      timestamp: now.toISOString(),
      content: p.content,
      title: p.title,
      tags: p.tags ? [...p.tags] : [],
      mime_type: p.mime_type,
      sha256: p.sha256
    };

    const revisions: NoteRevision[] = Array.isArray(p.revisions) ? [...p.revisions] : [];
    revisions.push(previousSnapshot);
    if (revisions.length > 5) {
      revisions.splice(0, revisions.length - 5);
    }

    let contentChanged = false;
    let newContent = p.content;
    if (typeof args.content === "string") {
      const inputContent = args.content.trim();
      if (args.mode === "append") {
        newContent = p.content ? `${p.content}\n${inputContent}` : inputContent;
      } else {
        newContent = inputContent;
      }
      if (!newContent) throw new Error("Content cannot be empty");
      if (newContent.length > 10240) {
        throw new Error(`content 超过 10KB 限制 (当前: ${newContent.length} 字符)。`);
      }
      if (newContent !== p.content) contentChanged = true;
    }

    let titleChanged = false;
    let newTitle = p.title;
    if (args.title !== undefined) {
      newTitle = (args.title || "").trim() || undefined;
      if (newTitle && newTitle.length > 256) {
        throw new Error(`title 超过 256 字符限制 (当前: ${newTitle.length} 字符)。`);
      }
      if (newTitle !== p.title) titleChanged = true;
    }

    let newTags = p.tags || [];
    if (Array.isArray(args.tags)) {
      newTags = args.tags.map(t => String(t).trim()).filter(Boolean);
      if (!newTags.includes("note")) newTags.push("note");
    }

    let newBase64 = p.base64;
    let newSha256 = p.sha256;
    let newMimeType = p.mime_type;

    if (args.base64 !== undefined) {
      newBase64 = (args.base64 || "").trim() || undefined;
      if (newBase64 && newBase64.length > 10240) {
        throw new Error(`base64 载荷超过 10KB 限制 (当前: ${newBase64.length} 字符)。`);
      }
      if (newBase64) {
        newSha256 = await computeBase64Sha256(newBase64);
      } else {
        newSha256 = undefined;
      }
    }

    if (args.mime_type !== undefined) {
      newMimeType = (args.mime_type || "").trim() || undefined;
    }

    let newCh = p.ch_prior;
    if (typeof args.c_h === "number") {
      newCh = args.c_h;
    }

    // Update payload object
    p.content = newContent;
    p.title = newTitle;
    p.tags = newTags;
    p.base64 = newBase64;
    p.sha256 = newSha256;
    p.mime_type = newMimeType;
    p.ch_prior = newCh;
    p.revisions = revisions;
    p.t_last_update = nowMs;

    if (contentChanged || titleChanged) {
      // Re-inject intent energy
      const decayedH = decaySpectrum(p.h_spectrum || new Array(7).fill(0), p.t_last_update || nowMs, nowMs);
      p.h_spectrum = injectIntent(decayedH, 1.0);
      p.t_last_strong = nowMs;

      // Re-vectorize with multimodal support
      const textToEmbed = newTitle ? `${newTitle}\n${newContent}` : newContent;
      const hasImage = Boolean(newBase64 && newMimeType.startsWith("image/"));
      const vector = await getEmbedding(
        hasImage
          ? { text: textToEmbed, imageBase64: newBase64, mimeType: newMimeType }
          : textToEmbed,
        env,
        "document"
      );
      await upsertMemoryPoint(pointId, vector, p, env);
    } else {
      await setPointPayload(pointId, p, env);
    }

    return {
      success: true,
      id: pointId,
      title: newTitle,
      content: newContent,
      tags: newTags,
      c_h: newCh,
      has_base64: Boolean(newBase64),
      base64_length: newBase64 ? newBase64.length : 0,
      sha256: newSha256,
      mime_type: newMimeType,
      revisions_count: revisions.length,
      revectorized: contentChanged || titleChanged,
      message: `📝 便签 [ID: ${pointId}] 更新成功 (历史版本数: ${revisions.length}${contentChanged || titleChanged ? "，已重算语义向量" : ""})`
    };
  }

  // 11. Tool: get_blob_url
  if (name === "get_blob_url") {
    const pointId = (args.id || "").trim();
    if (!pointId) throw new Error("Missing note id");

    const point = await getPointById(pointId, env);
    if (!point || !point.payload || point.payload.user_id !== userId) {
      throw new Error(`Note '${pointId}' not found or unauthorized`);
    }

    const p = point.payload;
    if (!p.base64) {
      throw new Error(`Note '${pointId}' has no binary payload to download.`);
    }

    const exp = Math.floor(nowMs / 1000) + 300; // 5 minutes validity
    const sig = await generateBlobSig("GET", pointId, userId, exp, env.JWT_SECRET);
    const domain = env.DOMAIN || "mcp.kufof.uk";
    const downloadUrl = `https://${domain}/blob/${pointId}?exp=${exp}&sig=${sig}`;

    let sha256 = p.sha256;
    if (!sha256 && p.base64) {
      sha256 = await computeBase64Sha256(p.base64);
      setPointPayload(pointId, { sha256 }, env).catch(() => {});
    }

    const exactBytes = p.base64 ? atob(p.base64).length : 0;

    return {
      success: true,
      id: pointId,
      title: p.title || undefined,
      download_url: downloadUrl,
      mime_type: p.mime_type || "application/octet-stream",
      sha256: sha256 || undefined,
      size_bytes: exactBytes,
      expires_at: new Date(exp * 1000).toISOString(),
      curl_command: `curl -s -o attachment "${downloadUrl}"`
    };
  }

  // 12. Tool: create_upload_url
  if (name === "create_upload_url") {
    const title = (args.title || "").trim();
    if (title.length > 256) throw new Error("title exceeds 256 characters");

    const content = (args.content || "").trim() || (title ? `[二进制存根] ${title}` : "（待上传二进制数据存根）");
    if (content.length > 10240) throw new Error("content exceeds 10KB");

    const mimeType = (args.mime_type || "").trim() || "application/octet-stream";
    const tags = Array.isArray(args.tags) ? args.tags.map(t => String(t).trim()).filter(Boolean) : [];
    if (!tags.includes("note")) tags.push("note");

    const hasConfigOrCheatsheet = tags.some(t => {
      const lower = t.toLowerCase();
      return lower.includes("config") || lower.includes("cheatsheet") || lower.includes("速查") || lower.includes("配置");
    });
    const defaultCh = hasConfigOrCheatsheet ? 11.0 : 8.8;
    const chPrior = typeof args.c_h === "number" ? args.c_h : defaultCh;

    const pointId = crypto.randomUUID();
    const textToEmbed = title ? `${title}\n${content}` : content;
    const vector = await getEmbedding(textToEmbed, env, "document");

    const initialSpectrum = injectIntent(new Array(7).fill(0), 1.0);
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
      mime_type: mimeType
    };

    await upsertMemoryPoint(pointId, vector, payload, env);

    const exp = Math.floor(nowMs / 1000) + 300; // 5 minutes validity
    const sig = await generateBlobSig("PUT", pointId, userId, exp, env.JWT_SECRET);
    const domain = env.DOMAIN || "mcp.kufof.uk";
    const uploadUrl = `https://${domain}/blob/${pointId}?exp=${exp}&sig=${sig}`;

    return {
      success: true,
      id: pointId,
      title: title || undefined,
      upload_url: uploadUrl,
      mime_type: mimeType,
      expires_at: new Date(exp * 1000).toISOString(),
      curl_command: `curl -X PUT -H "Content-Type: ${mimeType}" --data-binary @filename "${uploadUrl}"`
    };
  }

  // 13. Tool: request_image_upload
  if (name === "request_image_upload") {
    const token = env.CLOUDFLARE_API_TOKEN?.trim();
    const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim() || "00f6c85f82f6297c8c0bef9460e013d9";
    if (!token) throw new Error("CLOUDFLARE_API_TOKEN is not configured on MCP server");

    const filename = (args.filename || "image.jpg").trim();
    const formData = new FormData();
    formData.append("requireSignedURLs", "false");
    formData.append("metadata", JSON.stringify({ user_id: userId, filename }));

    const cfRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/images/v2/direct_upload`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`
      },
      body: formData
    });

    if (!cfRes.ok) {
      const err = await cfRes.text();
      throw new Error(`Cloudflare Images direct_upload failed (${cfRes.status}): ${err}`);
    }

    const cfData: any = await cfRes.json();
    const uploadUrl = cfData.result?.uploadURL;
    const imageId = cfData.result?.id;

    if (!uploadUrl || !imageId) {
      throw new Error("Failed to obtain uploadURL from Cloudflare Images");
    }

    return {
      success: true,
      image_id: imageId,
      upload_url: uploadUrl,
      filename,
      instructions: `请在沙箱中使用 curl 执行直接上传：\ncurl -X POST -F "file=@<本地图片绝对路径>" "${uploadUrl}"\n\n上传成功后，请发挥你的视觉大模型能力深度观察画面，然后调用 commit_image_record 工具将该图片录入图库与便签。`
    };
  }

  // 14. Tool: commit_image_record
  if (name === "commit_image_record") {
    const imageId = (args.image_id || "").trim();
    if (!imageId) throw new Error("Missing image_id");
    const description = (args.description || "").trim();
    if (!description) throw new Error("Missing description");

    const title = (args.title || "").trim();
    const filename = (args.filename || "image.jpg").trim();
    const tags = Array.isArray(args.tags) ? args.tags.map(t => String(t).trim()).filter(Boolean) : [];
    if (!tags.includes("image")) tags.push("image");

    let location: { lat: number; lon: number } | null = null;
    if (typeof args.latitude === "number" && typeof args.longitude === "number") {
      location = { lat: args.latitude, lon: args.longitude };
    }

    const exif = args.exif && typeof args.exif === "object" ? args.exif : null;
    const nowIso = now.toISOString();

    // Vectorize description with Voyage Multimodal 3.5 (1024-dim)
    const textToEmbed = title ? `${title}\n${description}\n${tags.join(" ")}` : `${description}\n${tags.join(" ")}`;
    const vector = await getEmbedding(textToEmbed, env, "document");

    // 1. Ingest into Qdrant 'images' collection
    const imagePointId = crypto.randomUUID();
    const qdrantUrl = `${env.QDRANT_URL.replace(/\/+$/, "")}/collections/images/points?wait=true`;
    const imagePayload = {
      user_id: userId,
      image_id: imageId,
      filename,
      title: title || filename,
      description,
      tags,
      exif,
      location,
      created_at: nowIso,
      source: "claude"
    };

    const imageRes = await fetch(qdrantUrl, {
      method: "PUT",
      headers: {
        "api-key": env.QDRANT_API_KEY?.trim(),
        "Content-Type": "application/json",
        "User-Agent": "curl/8.14.1 (constancy-mcp worker)"
      },
      body: JSON.stringify({
        points: [
          {
            id: imagePointId,
            vector,
            payload: imagePayload
          }
        ]
      })
    });

    if (!imageRes.ok) {
      const err = await imageRes.text();
      throw new Error(`Qdrant upsert to 'images' collection failed (${imageRes.status}): ${err}`);
    }

    // 2. Ingest into Constancy MCP 'constancy_memories' collection as Note
    let notePointId: string | null = null;
    const createNote = args.create_note !== false;
    if (createNote) {
      notePointId = crypto.randomUUID();
      const noteTitle = title || `[视觉资产] ${description.slice(0, 24)}...`;
      const noteContent = `${description}\n\n[Cloudflare Images ID: ${imageId}]`;
      const notePayload: MemoryPointPayload = {
        user_id: userId,
        content: noteContent,
        timestamp: nowIso,
        date: todayStr,
        type: "note",
        entities: [],
        tags: ["image", "gallery", ...tags],
        ch_prior: 11.0, // High constancy for assets
        h_spectrum: injectIntent(new Array(7).fill(0), 1.0),
        t_last_update: nowMs,
        t_last_strong: nowMs,
        title: noteTitle,
        mime_type: "image/jpeg"
      };

      await upsertMemoryPoint(notePointId, vector, notePayload, env);
    }

    return {
      success: true,
      image_id: imageId,
      point_id: imagePointId,
      note_id: notePointId,
      title: title || filename,
      message: `🖼️ 视觉资产成功入库！已录入后花园 (search.kufof.uk)${createNote ? " 并同步在 Constancy 便签库创建了对应笔记" : ""}。`
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
          version: "1.2.0",
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
