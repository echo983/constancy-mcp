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
  getSourceBadge,
  EvaluatedMemory,
  MemoryPointPayload,
  NoteRevision,
  MemorySourceType,
  MemoryAnnotation,
  AnnotationKind,
  DoctorVerdict,
  DoctorTreatment,
  ConcernSeverity,
  InteractionMode
} from "./actd";
import { getEmbedding, VoyageEnv } from "./voyage";
import {
  upsertMemoryPoint,
  searchMemoryPoints,
  searchImagePoints,
  getImagePoint,
  findEntityPoints,
  retireMemoryPoints,
  deleteMemoryPoints,
  appendMemoryAnnotation,
  getTimelinePoints,
  updatePointSpectrum,
  getPointById,
  setPointPayload,
  scrollNotes,
  parseDateFilter,
  parseNearFilter,
  normalizeIsoDate,
  StructuredSearchFilter,
  QdrantEnv,
  submitConcernToQdrant,
  getDoctorTriageCases,
  updateCaseConcerns
} from "./qdrant";
import { computeBase64Sha256, generateBlobSig } from "./blob";

export const CF_IMAGE_DELIVERY_HASH = "uTkE-E-smfahZbJoOmXVCw";

export async function getSignedImageVariants(
  imageId: string,
  env: McpEnv,
  expiresIn: number = 7200
): Promise<{ public: string; ai1024: string; ai768: string; ai512: string }> {
  // If native Cloudflare Images binding is available, generate signed URLs
  if (env.IMAGES?.hosted?.image) {
    try {
      const handle = env.IMAGES.hosted.image(imageId);
      const [pub, ai1024, ai768, ai512] = await Promise.all([
        handle.signedUrl({ variant: "public", expiresIn }),
        handle.signedUrl({ variant: "ai1024", expiresIn }),
        handle.signedUrl({ variant: "ai768", expiresIn }),
        handle.signedUrl({ variant: "ai512", expiresIn })
      ]);
      return { public: pub, ai1024, ai768, ai512 };
    } catch (err) {
      console.error("IMAGES.hosted.image signedUrl error:", err);
    }
  }

  // Fallback to basic delivery paths if binding not initialized
  const base = `https://imagedelivery.net/${CF_IMAGE_DELIVERY_HASH}/${imageId}`;
  return {
    public: `${base}/public`,
    ai1024: `${base}/ai1024`,
    ai768: `${base}/ai768`,
    ai512: `${base}/ai512`
  };
}

export const AI_VISION_VARIANT_GUIDE = "视觉模型传图分辨率指引：1) 密集文本/架构图/复杂图表选 ai1024；2) 通用场景/日常照片理解选 ai768（推荐默认，精度与Token开销平衡）；3) 快速识别/粗粒度分类选 ai512（极低Token）；4) 用户查看或下载提供 public。所有链接均具备时间签名保护。";

export function extractAssociatedImageId(payload: { image_id?: string; content?: string } | null | undefined): string | null {
  if (!payload) return null;
  if (payload.image_id && typeof payload.image_id === "string") {
    return payload.image_id.trim();
  }
  if (typeof payload.content === "string") {
    const m = payload.content.match(/\[(?:Cloudflare Images ID|图片 ID):\s*([a-zA-Z0-9_-]+)\]/i);
    if (m) return m[1].trim();
  }
  return null;
}

export interface McpEnv extends VoyageEnv, QdrantEnv {
  JWT_SECRET: string;
  DOMAIN: string;
  CLOUDFLARE_API_TOKEN?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  IMAGES?: any;
}

export const MCP_TOOLS = [
  {
    name: "log_memory",
    description: "主动向人基常热记忆体写入一条重要认知碎片、决策或事实。系统基于 ACTD 动力学维护 7 维时间能量谱与连续懒衰减，自动计算时效健康度 V。",
    inputSchema: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description: "核心内容（纯 Markdown 格式）。尽量客观准确，提炼事实与决策核心。"
        },
        c_h: {
          type: "number",
          description: "预期人基常度 C_H (可选)。数学定义: C_H = log₁₀(稳定半衰期 / 1毫秒)。标尺刻度: 7.8≈17小时(时效/天气预报); 8.8≈1周(日常任务/便签); 9.0≈11.5天(通用默认); 9.8≈2个月(季度决策); ≥11.0≈3年以上(常青基石/硬件事实)。系统据此连续自动懒衰减并计算时效健康度 V。"
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
        },
        source: {
          type: "string",
          enum: ["user_stated", "model_suggested", "model_inferred", "external"],
          description: "【认知来源强定性】必须明确该陈述的产生主体：'user_stated'(用户明确陈述/指令/偏好)、'model_suggested'(模型主动提议/建议/备选方案)、'model_inferred'(模型根据上下文分析推论出的规律)、'external'(第三方/工具/外部抓取)。【铁律门禁】只有 'user_stated' 才能登记为 decision(决策) 或待办事项(todo/action)，模型的建议或推断只能作为 insight/memo，违者门口硬拦截！默认 'user_stated'。"
        }
      },
      required: ["content"]
    }
  },
  {
    name: "search_memory",
    description: "按语义意图或时空结构化条件跨模态检索历史记忆、便签与视觉图片。系统会自动代入 ACTD 动力学连续懒衰减，并计算时效健康度 V。支持多模态语义检索，或纯按时间范围 (date_from / date_to) 与 GPS 地理坐标/半径 (near，支持排除特定范围如'出门在外') 进行结构化过滤。每张图片均提供 variants 多分辨率变体（ai1024 适于密集文本/细微细节、ai768 适于通用场景分析推荐、ai512 极速轻量低 Token、public 用于用户查看）以及沙箱 curl 命令，供大模型根据实际分析需求自主选用。系统已内置视觉资产与关联便签动态去重，避免重复占用结果位。",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "搜索问题或查询意图 (可选，若已提供 date_from/date_to 或 near 时可为空，将执行纯结构化过滤检索)"
        },
        date_from: {
          type: "string",
          description: "起始时间过滤，支持 ISO 8601、YYYY-MM-DD 或 YYYY-MM 格式 (如 '2026-08-01', '2026-08', '2026-08-01T00:00:00Z')"
        },
        date_to: {
          type: "string",
          description: "截止时间过滤，支持 ISO 8601、YYYY-MM-DD 或 YYYY-MM 格式 (如 '2026-08-31', '2026-08', '2026-08-31T23:59:59Z')"
        },
        near: {
          type: "object",
          description: "基于 GPS 坐标的位置距离过滤 (如'在家附近'或'出门在外')",
          properties: {
            latitude: { type: "number", description: "中心纬度 (例如 37.7605)" },
            longitude: { type: "number", description: "中心经度 (例如 -3.7955)" },
            radius_meters: { type: "number", description: "搜索半径（米），默认 1000 米" },
            exclude: { type: "boolean", description: "是否反向排除该区域（设为 true 表示检索远离该位置的照片/便签，如'出门在外'检索），默认 false" }
          },
          required: ["latitude", "longitude"]
        },
        limit: {
          type: "number",
          description: "返回的最大有效记忆/便签数量，默认 5"
        },
        type: {
          type: "string",
          description: "限定类型过滤 (可选。'all'=全景聚合检索; 'image'=专搜视觉图片; 'note'=便签; 'insight'/'decision'/'event'/'memo'=认知碎片)"
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
        include_images: {
          type: "boolean",
          description: "是否同时检索并召回匹配的视觉图片，默认 true。当为 true 时，若图库中有语义相近的照片，会直接附带 CDN 访问 URL 与沙箱下载命令。"
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
      required: []
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
          description: "修正或提升的人基常度 C_H (可选，C_H = log₁₀(半衰期/1ms)。若用户明确其为更长期规则可直接升级，例如提至 9.8 季度方案或 ≥11.0 常青基石)"
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
    description: "登记或更新跨越周期的核心常青实体百科（如硬件参数、系统架构组件、团队规范），赋予高阶百年基石常度 (C_H ≥ 11.5，折合半衰期约 100 年)。具备同名幂等更新、revisions 版本审计留痕与历史重复条目自动软归档（retire）能力，绝不破坏历史审计链。",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "实体标准名称（例如 'Duplicacy' 或 'Constancy MCP'）"
        },
        description: {
          type: "string",
          description: "实体的确切定义、架构背景与核心属性规范 (Markdown)"
        },
        aliases: {
          type: "array",
          items: { type: "string" },
          description: "【严格同一本体的别名】实体的同义词、简称或代号（必须与本实体指代完全相同的同一件事物，例如 ['外脑', 'constancy-mcp']）。【注意】严禁将关联组件、上下游技术栈或理论模型填入别名！"
        },
        relations: {
          type: "array",
          items: { type: "string" },
          description: "【关联的独立实体】本实体所依赖、关联或衍生的其他独立实体名称（例如 ['ACTD v1.0', 'Voyage AI', 'Qdrant', 'Cloudflare Images']）"
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
          description: "可选人基常度 C_H (定义: C_H = log₁₀(半衰期/1ms))。默认 8.8 (约1~2周迭代周期)；若 tags 包含 config 或 cheatsheet 则自动升为 11.0 (约3年长期存根)。"
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
          description: "可选。更新人基常度 C_H (定义: C_H = log₁₀(半衰期/1ms))。"
        }
      },
      required: ["id"]
    }
  },
  {
    name: "get_blob_url",
    description: "【二进制与视觉资产召回】根据 ID 召回二进制资源下载链接。支持多态识别：既支持获取 Note 便签中的普通文件附件（PDF/文档/压缩包等，生成带防盗签名的 5 分钟直链），也支持传入 Cloudflare 图片 ID 或关联便签 ID（直接返回包含 ai1024、ai768、ai512、public 多尺寸变体的 CDN 链接与沙箱 curl 命令，供大模型按精度与 Token 预算自主选用）。零 Token 传输二进制。",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "便签 ID (Note UUID) 或 Cloudflare 图片 ID (image_id)"
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
          description: "可选。人基常度 C_H (定义: C_H = log₁₀(半衰期/1ms))，默认 8.8 (约1~2周)。"
        }
      }
    }
  },
  {
    name: "request_image_upload",
    description: "【申请 Cloudflare Images 直传凭据】照片与视觉素材上传流水线第 1 步。当用户要求上传/保存照片或视觉素材到图库/外脑时调用。预分配 Cloudflare Images 存储 ID 并生成 5 分钟有效的一次性直传 URL。用于 Claude 或客户端在本地沙箱中直接通过 curl 将图片二进制直传至 Cloudflare Images 永久图库（零 Token 上下文传输，自动开启签名防泄漏）。上传成功后，由大模型观察画面细节并提取 EXIF/GPS，调用 commit_image_record 完成闭环入库与便签绑定。",
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
    description: "【视觉资产入库确认】照片与视觉素材上传流水线第 2 步（闭环确认）。图片直传 Cloudflare Images 成功后调用：将图片正式录入 Qdrant 视觉图库（images 集合）并同步在 Constancy 便签库创建关联便签。由 Claude 发挥原生视觉大模型能力生成深度中文描述、识别画面主体细节与文字，并提取传入 EXIF 拍摄时间 (captured_at) 与 GPS 坐标 (latitude/longitude)，以支持后续按时间与地理位置的结构化范围检索。",
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
        captured_at: {
          type: "string",
          description: "可选。拍摄时间 ISO 8601 或 YYYY:MM:DD HH:MM:SS 格式，如未传将尝试从 exif.dateTime 读取，标准化为 UTC ISO 8601 存入"
        },
        create_note: {
          type: "boolean",
          description: "可选。是否同步在 Constancy 便签库创建一条关联 Note 便签，默认 true"
        }
      },
      required: ["image_id", "description"]
    }
  },
  {
    name: "annotate_memory",
    description: "【非破坏性勘误与附注】对既有记忆碎片进行局部纠错、存疑标记或上下文补充。原文与向量一字不动，不破坏原有时空坐标与因果可证伪性，通过追加不可变注记并置呈现，保证认知审计透明。",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "目标记忆点的 UUID"
        },
        kind: {
          type: "string",
          enum: ["correction", "dispute", "context"],
          description: "注记类型：'correction'(事实局部更正与纠偏)、'dispute'(存疑与分歧标记)、'context'(补充后续背景或证据)"
        },
        text: {
          type: "string",
          description: "具体注记说明（指出哪一句有误，纠正后的客观事实是什么）"
        },
        source: {
          type: "string",
          enum: ["user_stated", "model_inferred", "external"],
          description: "注记来源，默认为 'user_stated'"
        },
        ref_id: {
          type: "string",
          description: "可选。关联的新记忆点 ID 或证据存根 ID"
        }
      },
      required: ["id", "kind", "text"]
    }
  },
  {
    name: "submit_concern",
    description: "【认知卫生义务】当会话中发现检索出的长期记忆与用户当下的现实直陈存在出入、已过期、彼此冲突或明显存疑时，调用此工具将顾虑提交至私域分诊台。LLM 实例有义务在感知到异常时上报，可自行视情况选择静默提交(silent)、顺带告知用户(informed_user)、或与用户求证后再报(user_confirmed)。",
    inputSchema: {
      type: "object",
      properties: {
        memory_id: {
          type: "string",
          description: "关联的目标记忆 ID (UUID 或 MID 标识)"
        },
        reason: {
          type: "string",
          description: "病症简述与存疑原因（例如：用户居住地可能已由北京变更为上海）"
        },
        evidence: {
          type: "string",
          description: "现实证据链（必须包含当前会话中用户的原话引言，禁止凭空臆断）"
        },
        severity: {
          type: "string",
          enum: ["high", "medium", "low"],
          description: "严重程度：'high'(明确冲突/违背直陈，排期≤1h)、'medium'(偏好漂移/习惯改变，排期≤6h)、'low'(轻度存疑/细节补充，排期≤24h)"
        },
        interaction_mode: {
          type: "string",
          enum: ["silent", "informed_user", "user_confirmed"],
          description: "交互姿态：'silent'(后台静默提交不打扰用户)、'informed_user'(已顺带告知用户)、'user_confirmed'(经与用户当面求证属实后提交，享高优先级)"
        }
      },
      required: ["memory_id", "reason", "evidence", "severity"]
    }
  },
  {
    name: "get_maintenance_cases",
    description: "【🩺 认知卫生专职医生专享 - 普通会话严禁调用】获取当前整点已达到分诊水位的认知卫生候诊案件。后台已自动完成高危即时到期、中危6h排期、低危24h汇总以及多重举报升舱计算。若无待办案件返回空列表，医生确认肌体健康后可直接秒级收工。",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "单次巡诊最大获取案卷数，默认 5（防超时）"
        }
      }
    }
  },
  {
    name: "resolve_maintenance_case",
    description: "【🩺 认知卫生专职医生专享 - 普通会话严禁调用】对审理完毕的案卷下达临床处方。支持确诊处置(RESOLVED: 维持KEEP/更新UPDATE/废弃EXPIRE/归并MERGE)、留观跟踪(DEFERRED: 证据不足不妄动刀，等待后续会话进一步证据)或请患者本人会诊(ESCALATED_TO_USER: 疑难重大推至后花园控制台待用户点选确认)。",
    inputSchema: {
      type: "object",
      properties: {
        case_id: {
          type: "string",
          description: "案卷编号 (例如 CASE-A1B2C3D4)"
        },
        memory_id: {
          type: "string",
          description: "目标记忆点 ID"
        },
        verdict: {
          type: "string",
          enum: ["RESOLVED", "DEFERRED", "ESCALATED_TO_USER"],
          description: "医生临床裁决：'RESOLVED'(案情确凿立即施治)、'DEFERRED'(证据不足留观追踪)、'ESCALATED_TO_USER'(疑难重大请患者本人会诊)"
        },
        treatment: {
          type: "string",
          enum: ["KEEP", "UPDATE", "EXPIRE", "MERGE"],
          description: "当 verdict 为 RESOLVED 时的具体处置方案：'KEEP'(健康无虞维持原状)、'UPDATE'(对症调药更新内容)、'EXPIRE'(病灶坏死宣告失效)、'MERGE'(归并精简)"
        },
        updated_content: {
          type: "string",
          description: "若处置方案为 UPDATE，提供修正后的精确记忆文本（纯 Markdown 格式）"
        },
        doctor_notes: {
          type: "string",
          description: "医生病历小结：诊断依据、事实推演与处方理由（将存入私域不可变审计日志）"
        }
      },
      required: ["case_id", "memory_id", "verdict", "doctor_notes"]
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

    const rawSource = String(args.source || "user_stated").toLowerCase().trim();
    const validSources: MemorySourceType[] = ["user_stated", "model_suggested", "model_inferred", "external"];
    const source: MemorySourceType = (validSources.includes(rawSource as any) ? rawSource : "user_stated") as MemorySourceType;

    const chPrior = typeof args.c_h === "number" ? args.c_h : 9.0;
    const type = args.type || "insight";
    const entities = Array.isArray(args.entities) ? args.entities : [];
    const tags = Array.isArray(args.tags) ? args.tags : [];

    // 门口硬门禁：只有 user_stated 才能建立决策或待办任务！
    const hasTodoOrAction = tags.some((t: string) => /todo|待办|action|task|计划/i.test(t)) || /待办|TODO/i.test(content);
    if ((type === "decision" || hasTodoOrAction) && source !== "user_stated") {
      throw new Error(
        `❌ 门口硬门禁拦截：只有用户明确陈述 ('user_stated') 才能登记为决策 (decision) 或待办任务 (todo)。当前来源标记为 '${source}'。模型的主动提议或推断请登记为 'insight' / 'memo'，严禁越权替用户设立待办或决策！`
      );
    }

    // 规范化来源前缀
    let formattedContent = content;
    const prefixMap: Record<MemorySourceType, string> = {
      user_stated: "【来源: 用户直陈】",
      model_suggested: "【来源: 模型建议】",
      model_inferred: "【来源: 模型推断】",
      external: "【来源: 外部输入】"
    };
    if (!formattedContent.startsWith("【来源:")) {
      formattedContent = `${prefixMap[source]}\n${formattedContent}`;
    }

    // Initial energy injection
    const initialSpectrum = injectIntent(new Array(7).fill(0), 1.0);

    const payload: MemoryPointPayload = {
      user_id: userId,
      content: formattedContent,
      source,
      timestamp: now.toISOString(),
      created_at: now.toISOString(),
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
    const vector = await getEmbedding(formattedContent, env, "document");
    const pointId = crypto.randomUUID();

    await upsertMemoryPoint(pointId, vector, payload, env);

    const expectedHours = (Math.pow(10, chPrior) / 3600000).toFixed(1);
    return {
      success: true,
      id: pointId,
      source,
      source_badge: getSourceBadge(source),
      c_h: chPrior,
      stable_expected: `约 ${expectedHours} 小时`,
      message: `✅ 已成功存入人基常热记忆体 [来源: ${getSourceBadge(source)}, 常度: ${chPrior}, 预期基础稳定期: ${expectedHours}h]`
    };
  }

  // 2. Tool: search_memory
  if (name === "search_memory") {
    const query = (args.query || "").trim();
    const imageUrl = (args.image_url || "").trim() || undefined;
    const imageBase64 = (args.image_base64 || "").trim() || undefined;
    const dateFrom = parseDateFilter(args.date_from, false);
    const dateTo = parseDateFilter(args.date_to, true);
    const near = parseNearFilter(args.near);
    const typeFilter = (args.type || "").trim();
    const entity = (args.entity || "").trim() || undefined;

    const hasStructuredFilter = Boolean(dateFrom || dateTo || near || (typeFilter && typeFilter !== "all") || entity);

    if (!query && !imageUrl && !imageBase64 && !hasStructuredFilter) {
      throw new Error("Missing query, image input, or structured filter (date_from, date_to, near, entity)");
    }

    const limit = Math.min(Math.max(parseInt(args.limit) || 5, 1), 20);
    const minValidity = typeof args.min_validity === "number" ? Math.max(0, Math.min(1, args.min_validity)) : 0.2;
    const includeRetired = Boolean(args.include_retired);
    const isImageOnly = typeFilter === "image";
    const includeImages = args.include_images !== false && (typeFilter === "" || typeFilter === "all" || typeFilter === "image");

    const queryInput = (imageUrl || imageBase64)
      ? { text: query, imageUrl, imageBase64 }
      : query;

    const queryVector = (query || imageUrl || imageBase64)
      ? await getEmbedding(queryInput, env, "query")
      : null;

    const structuredFilter: StructuredSearchFilter = {
      type: typeFilter && typeFilter !== "all" ? typeFilter : undefined,
      entity,
      date_from: dateFrom || undefined,
      date_to: dateTo || undefined,
      near
    };

    const searchMemoriesPromise = isImageOnly
      ? Promise.resolve([])
      : searchMemoryPoints(queryVector, userId, limit * 3, env, structuredFilter);

    const searchImagesPromise = includeImages
      ? searchImagePoints(queryVector, userId, Math.min(limit, 8), env, structuredFilter)
      : Promise.resolve([]);

    const [candidates, imageCandidates] = await Promise.all([
      searchMemoriesPromise,
      searchImagesPromise
    ]);

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
        const classification = classifyHealth(0.0, p.tags || [], p.type || "", true, p.retired_reason || "", p.annotations);
        // Severely penalize composite score for retired memories so they rank at the bottom
        const compositeScore = Number((similarityScore * 0.01).toFixed(4));
        evaluatedList.push({
          id: item.id,
          content: p.content,
          type: p.type,
          source: p.source || undefined,
          source_badge: getSourceBadge(p.source),
          annotations: p.annotations && p.annotations.length > 0 ? p.annotations : undefined,
          has_annotations: Boolean(p.annotations && p.annotations.length > 0),
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
          memory_status: p.status || "expired",
          superseded_by: p.superseded_by,
          predecessor: p.predecessor,
          title: p.title || undefined,
          image_id: p.image_id || extractAssociatedImageId(p) || undefined,
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
      const classification = classifyHealth(V, p.tags || [], p.type || "", false, "", p.annotations);

      // 4. Semantic similarity score & Composite Ranking
      // Composite Score: Semantic score is primary; V modulates confidence (0.6 + 0.4 * V)
      const compositeScore = Number((similarityScore * (0.6 + 0.4 * V)).toFixed(4));

      // 5. Filter by min_validity threshold (default >= 0.2, discarding DORMANT)
      if (V >= minValidity) {
        evaluatedList.push({
          id: item.id,
          content: p.content,
          type: p.type,
          source: p.source || undefined,
          source_badge: getSourceBadge(p.source),
          annotations: p.annotations && p.annotations.length > 0 ? p.annotations : undefined,
          has_annotations: Boolean(p.annotations && p.annotations.length > 0),
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
          memory_status: p.status || "active",
          superseded_by: p.superseded_by,
          predecessor: p.predecessor,
          title: p.title || undefined,
          image_id: p.image_id || extractAssociatedImageId(p) || undefined,
          has_base64: Boolean(p.base64),
          base64_length: p.base64 ? p.base64.length : undefined,
          sha256: p.sha256 || undefined,
          mime_type: p.mime_type || undefined
        });
      }
    }

    // If queryVector is null (pure structured query), sort images by captured_at descending
    if (!queryVector) {
      imageCandidates.sort((a: any, b: any) => {
        const tA = new Date(a.payload?.captured_at || a.payload?.created_at || 0).getTime();
        const tB = new Date(b.payload?.captured_at || b.payload?.created_at || 0).getTime();
        return tB - tA;
      });
    }

    // Format visual image results with ready-to-use signed CDN URLs and curl commands
    const imageResults = await Promise.all((imageCandidates || []).map(async item => {
      const p = item.payload || {};
      const imgId = p.image_id || item.id;
      const variants = await getSignedImageVariants(imgId, env, 7200);
      return {
        image_id: imgId,
        title: p.title || p.filename || "视觉图像资产",
        filename: p.filename || "image.jpg",
        description: p.description || "",
        score: Number((item.score || 0).toFixed(4)),
        tags: p.tags || [],
        exif: p.exif || undefined,
        location: p.location || undefined,
        captured_at: p.captured_at || p.created_at || undefined,
        created_at: p.created_at,
        expires_in: 7200,
        url: variants.public,
        variants,
        variant_guide: AI_VISION_VARIANT_GUIDE,
        curl_command: `curl -s -o "${p.filename || 'downloaded_image.jpg'}" "${variants.public}"`
      };
    }));

    // Deduplicate: If an image note's associated visual image is already presented in imageResults,
    // filter out the duplicate text note so it doesn't waste a memory result slot or clutter LLM context.
    const returnedImageIds = new Set<string>();
    for (const img of imageResults) {
      if (img.image_id) returnedImageIds.add(img.image_id);
    }

    const deduplicatedMemories = evaluatedList.filter(item => {
      const assocImgId = item.image_id || extractAssociatedImageId(item);
      if (assocImgId && returnedImageIds.has(assocImgId)) {
        return false;
      }
      return true;
    });

    // Sort memories: by composite_score descending, tie-break by timestamp descending
    deduplicatedMemories.sort((a, b) => {
      const diff = (b.composite_score || 0) - (a.composite_score || 0);
      if (Math.abs(diff) > 0.001) return diff;
      return new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime();
    });
    const memoryResults = deduplicatedMemories.slice(0, limit);

    const totalFound = memoryResults.length + imageResults.length;
    const returnObj: any = {
      query: query || undefined,
      filter: hasStructuredFilter ? structuredFilter : undefined,
      found_count: totalFound
    };

    if (memoryResults.length > 0 || !isImageOnly) {
      returnObj.memories = memoryResults;
    }
    if (imageResults.length > 0 || isImageOnly) {
      returnObj.images = imageResults;
    }

    return returnObj;
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

    const aliases: string[] = Array.isArray(args.aliases)
      ? args.aliases.map((a: any) => String(a).trim()).filter(Boolean)
      : [];
    const relations: string[] = Array.isArray(args.relations)
      ? args.relations.map((r: any) => String(r).trim()).filter(Boolean)
      : [];

    let fullContent = `【核心实体: ${entityName}】\n${desc}`;
    if (aliases.length > 0) {
      fullContent += `\n(别名: ${aliases.join(", ")})`;
    }
    if (relations.length > 0) {
      fullContent += `\n(关联实体: ${relations.join(", ")})`;
    }

    // Entities inherently enjoy foundation constancy (C_H >= 11.5)
    const chPrior = 11.5;
    const initialSpectrum = injectIntent(new Array(7).fill(1.5), 1.0);

    // Idempotent upsert: check if entity already exists for this user
    const existingPoints = await findEntityPoints(entityName, userId, env);
    let pointId: string;
    let isUpdate = false;
    let originalCreatedAt = now.toISOString();
    let existingRevisions: NoteRevision[] = [];

    if (existingPoints.length > 0) {
      isUpdate = true;
      const primaryPoint = existingPoints[0];
      pointId = primaryPoint.id;
      const oldPayload = primaryPoint.payload;

      if (oldPayload) {
        originalCreatedAt = oldPayload.created_at || oldPayload.timestamp || originalCreatedAt;
        existingRevisions = Array.isArray(oldPayload.revisions) ? [...oldPayload.revisions] : [];

        // 若内容、别名或关联发生变化，将旧版本压入 revisions 审计链留痕
        if (oldPayload.content !== fullContent) {
          existingRevisions.unshift({
            timestamp: now.toISOString(),
            content: oldPayload.content,
            title: entityName,
            entity_name: entityName,
            aliases: oldPayload.aliases || [],
            relations: oldPayload.relations || [],
            tags: oldPayload.tags,
            reason: "Updated entity specification"
          });
          // 最多保留 5 版历史快照
          if (existingRevisions.length > 5) {
            existingRevisions = existingRevisions.slice(0, 5);
          }
        }
      }

      // 如果有历史遗留的重复同名点，绝不物理删除，而是调用 retire 软归档沉淀，保留历史审计轨迹
      if (existingPoints.length > 1) {
        const duplicateIds = existingPoints.slice(1).map(p => p.id);
        await retireMemoryPoints(duplicateIds, `Superseded by canonical entity update (${pointId})`, env);
      }
    } else {
      pointId = crypto.randomUUID();
    }

    const payload: MemoryPointPayload = {
      user_id: userId,
      content: fullContent,
      timestamp: originalCreatedAt, // 保持初始创建时间戳不变
      created_at: originalCreatedAt,
      updated_at: isUpdate ? now.toISOString() : undefined,
      date: todayStr,
      type: "entity",
      entity_name: entityName,
      aliases: aliases,
      relations: relations,
      entities: [entityName, ...aliases], // 严格限定为实体名与真正同义词，杜绝 relations 污染 entities
      tags: ["entity_registry", "core_knowledge"],
      ch_prior: chPrior,
      h_spectrum: initialSpectrum,
      t_last_update: nowMs,
      t_last_strong: nowMs,
      revisions: existingRevisions.length > 0 ? existingRevisions : undefined
    };

    const vector = await getEmbedding(fullContent, env, "document");
    await upsertMemoryPoint(pointId, vector, payload, env);

    return {
      success: true,
      entity: entityName,
      point_id: pointId,
      updated: isUpdate,
      c_h: chPrior,
      revisions_count: existingRevisions.length,
      retired_duplicates_count: existingPoints.length > 1 ? existingPoints.length - 1 : 0,
      message: isUpdate
        ? `🏛️ 已成功更新实体 '${entityName}' 的百科条目（常度: 11.5，百年基石级，已记录版本审计快照${existingPoints.length > 1 ? `，已软归档 ${existingPoints.length - 1} 条历史重复条目` : ""}）`
        : `🏛️ 已成功将实体 '${entityName}' 固化至核心实体百科清单 (常度: 11.5，百年基石级)`
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
    const tags = Array.isArray(args.tags) ? args.tags.map((t: any) => String(t).trim()).filter(Boolean) : [];
    if (!tags.includes("note")) tags.push("note");

    const hasConfigOrCheatsheet = tags.some((t: string) => {
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
      newTags = args.tags.map((t: any) => String(t).trim()).filter(Boolean);
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
      const hasImage = Boolean(newBase64 && newMimeType?.startsWith("image/"));
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
    const targetId = (args.id || "").trim();
    if (!targetId) throw new Error("Missing id");

    // 1. Try finding in constancy_memories first
    const point = await getPointById(targetId, env);
    if (point && point.payload && point.payload.user_id === userId) {
      const p = point.payload;

      // Branch 1A: Note has native base64 binary attachment
      if (p.base64) {
        const exp = Math.floor(nowMs / 1000) + 300; // 5 minutes validity
        const sig = await generateBlobSig("GET", targetId, userId, exp, env.JWT_SECRET);
        const domain = env.DOMAIN || "mcp.kufof.uk";
        const downloadUrl = `https://${domain}/blob/${targetId}?exp=${exp}&sig=${sig}`;

        let sha256 = p.sha256;
        if (!sha256 && p.base64) {
          sha256 = await computeBase64Sha256(p.base64);
          setPointPayload(targetId, { sha256 }, env).catch(() => {});
        }

        const exactBytes = atob(p.base64).length;

        return {
          success: true,
          id: targetId,
          type: "note_attachment",
          title: p.title || undefined,
          download_url: downloadUrl,
          mime_type: p.mime_type || "application/octet-stream",
          sha256: sha256 || undefined,
          size_bytes: exactBytes,
          expires_at: new Date(exp * 1000).toISOString(),
          curl_command: `curl -s -o attachment "${downloadUrl}"`
        };
      }

      // Branch 1B: Note references Cloudflare Images
      const cfMatch = p.content?.match(/\[Cloudflare Images ID:\s*([a-zA-Z0-9_-]+)\]/);
      const linkedImageId = cfMatch ? cfMatch[1] : (p as any).image_id;
      if (linkedImageId) {
        const variants = await getSignedImageVariants(linkedImageId, env, 7200);
        return {
          success: true,
          id: targetId,
          image_id: linkedImageId,
          type: "cloudflare_image",
          title: p.title || "视觉图像资产",
          download_url: variants.public,
          variants,
          variant_guide: AI_VISION_VARIANT_GUIDE,
          mime_type: p.mime_type || "image/jpeg",
          expires_at: new Date(Date.now() + 7200 * 1000).toISOString(),
          curl_command: `curl -s -o "${linkedImageId}.jpg" "${variants.public}"`
        };
      }
    }

    // 2. Try finding in Qdrant images collection (by point UUID or Cloudflare image_id)
    const imgPoint = await getImagePoint(targetId, userId, env);
    if (imgPoint && imgPoint.payload) {
      const p = imgPoint.payload;
      const imgId = p.image_id || imgPoint.id;
      const variants = await getSignedImageVariants(imgId, env, 7200);
      return {
        success: true,
        id: targetId,
        image_id: imgId,
        type: "cloudflare_image",
        title: p.title || p.filename || "视觉图像资产",
        description: p.description || undefined,
        download_url: variants.public,
        variants,
        variant_guide: AI_VISION_VARIANT_GUIDE,
        mime_type: "image/jpeg",
        exif: p.exif || undefined,
        location: p.location || undefined,
        expires_at: new Date(Date.now() + 7200 * 1000).toISOString(),
        curl_command: `curl -s -o "${p.filename || imgId + '.jpg'}" "${variants.public}"`
      };
    }

    if (point) {
      throw new Error(`Note '${targetId}' has no binary payload or image attachment.`);
    }

    throw new Error(`Resource '${targetId}' not found or unauthorized.`);
  }

  // 12. Tool: create_upload_url
  if (name === "create_upload_url") {
    const title = (args.title || "").trim();
    if (title.length > 256) throw new Error("title exceeds 256 characters");

    const content = (args.content || "").trim() || (title ? `[二进制存根] ${title}` : "（待上传二进制数据存根）");
    if (content.length > 10240) throw new Error("content exceeds 10KB");

    const mimeType = (args.mime_type || "").trim() || "application/octet-stream";
    const tags = Array.isArray(args.tags) ? args.tags.map((t: any) => String(t).trim()).filter(Boolean) : [];
    if (!tags.includes("note")) tags.push("note");

    const hasConfigOrCheatsheet = tags.some((t: string) => {
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
    const filename = (args.filename || "image.jpg").trim();
    let uploadUrl = "";
    let imageId = "";

    // 1. Prefer native IMAGES binding if available
    if (env.IMAGES?.hosted?.createDirectUpload) {
      try {
        const directRes = await env.IMAGES.hosted.createDirectUpload({
          metadata: { user_id: userId, filename },
          requireSignedURLs: true,
          expiresIn: 1800
        });
        uploadUrl = directRes.uploadURL;
        imageId = directRes.id;
      } catch (err) {
        console.error("IMAGES.hosted.createDirectUpload error, falling back to REST API:", err);
      }
    }

    // 2. Fallback to Cloudflare Images REST API v2
    if (!uploadUrl || !imageId) {
      const token = env.CLOUDFLARE_API_TOKEN?.trim();
      const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim() || "00f6c85f82f6297c8c0bef9460e013d9";
      if (!token) throw new Error("CLOUDFLARE_API_TOKEN is not configured on MCP server");

      const formData = new FormData();
      formData.append("requireSignedURLs", "true");
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
      uploadUrl = cfData.result?.uploadURL;
      imageId = cfData.result?.id;

      if (!uploadUrl || !imageId) {
        throw new Error("Failed to obtain uploadURL from Cloudflare Images");
      }
    }

    return {
      success: true,
      image_id: imageId,
      upload_url: uploadUrl,
      filename,
      require_signed_urls: true,
      instructions: `请在沙箱中按以下 3 步完成照片入库：
1. 【直传图片】使用 curl 上传二进制（零 Token 上下文传输）：
   curl -X POST -F "file=@<本地图片绝对路径>" "${uploadUrl}"
2. 【提取元数据】如果本地沙箱有权限，建议运行 exiftool 或相关命令提取拍摄时间 (DateTimeOriginal)、GPS 经纬度及机型参数。
3. 【观察画面并入库】上传成功后，发挥原生视觉大模型能力深度观察画面细节，调用 commit_image_record 传入 image_id ("${imageId}")、description、captured_at、latitude、longitude 与 exif，正式完成图库与便签入库。`
    };
  }

  // 14. Tool: commit_image_record
  if (name === "commit_image_record") {
    const imageId = (args.image_id || "").trim();
    if (!imageId) throw new Error("Missing image_id");
    const description = (args.description || "").trim();
    if (!description) throw new Error("Missing description");

    // Validate that image actually exists in Cloudflare Images before saving to Qdrant
    if (env.IMAGES?.hosted?.image) {
      try {
        await env.IMAGES.hosted.image(imageId).details();
      } catch (err: any) {
        throw new Error(`Cloudflare Images 中未找到 ID '${imageId}'，请核对 request_image_upload 返回的真实 image_id: ${err?.message || err}`);
      }
    }

    const title = (args.title || "").trim();
    const filename = (args.filename || "image.jpg").trim();
    const tags = Array.isArray(args.tags) ? args.tags.map((t: any) => String(t).trim()).filter(Boolean) : [];
    if (!tags.includes("image")) tags.push("image");

    let location: { lat: number; lon: number } | null = null;
    if (typeof args.latitude === "number" && typeof args.longitude === "number") {
      location = { lat: args.latitude, lon: args.longitude };
    }

    const exif = args.exif && typeof args.exif === "object" ? { ...args.exif } : null;
    if (!location && exif) {
      const eLat = exif.latitude ?? exif.lat;
      const eLon = exif.longitude ?? exif.lon;
      if (typeof eLat === "number" && typeof eLon === "number") {
        location = { lat: eLat, lon: eLon };
      }
    }

    const nowIso = now.toISOString();

    // Determine canonical ISO 8601 captured_at
    let capturedAtIso: string | null = null;
    if (args.captured_at) {
      capturedAtIso = normalizeIsoDate(args.captured_at);
    }
    if (!capturedAtIso && exif?.dateTime) {
      capturedAtIso = normalizeIsoDate(exif.dateTime);
    }
    if (!capturedAtIso) {
      capturedAtIso = nowIso;
    }

    // Ensure exif.dateTime is canonical ISO format if exif is present
    if (exif && capturedAtIso) {
      exif.dateTime = capturedAtIso;
    }

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
      captured_at: capturedAtIso,
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
        timestamp: capturedAtIso || nowIso,
        captured_at: capturedAtIso || nowIso,
        location: location || undefined,
        date: capturedAtIso ? capturedAtIso.slice(0, 10) : todayStr,
        type: "note",
        entities: [],
        tags: ["image", "gallery", ...tags],
        ch_prior: 11.0, // High constancy for assets
        h_spectrum: injectIntent(new Array(7).fill(0), 1.0),
        t_last_update: nowMs,
        t_last_strong: nowMs,
        title: noteTitle,
        image_id: imageId,
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

  // 15. Tool: annotate_memory
  if (name === "annotate_memory") {
    const pointId = (args.id || "").trim();
    if (!pointId) throw new Error("Missing id");
    const kind = (args.kind || "").trim().toLowerCase() as AnnotationKind;
    if (!["correction", "dispute", "context"].includes(kind)) {
      throw new Error(`Invalid kind: '${kind}'. Must be one of: 'correction', 'dispute', 'context'`);
    }
    const text = (args.text || "").trim();
    if (!text) throw new Error("Missing text");

    const rawSource = String(args.source || "user_stated").toLowerCase().trim();
    const source: MemorySourceType = (["user_stated", "model_inferred", "external"].includes(rawSource) ? rawSource : "user_stated") as MemorySourceType;
    const refId = typeof args.ref_id === "string" ? args.ref_id.trim() : undefined;

    const annotationId = crypto.randomUUID();
    const annotation: MemoryAnnotation = {
      id: annotationId,
      timestamp: now.toISOString(),
      kind,
      text,
      source,
      ref_id: refId
    };

    const updatedPayload = await appendMemoryAnnotation(pointId, annotation, env);

    const kindEmojiMap: Record<AnnotationKind, string> = {
      correction: "⚠️ 事实更正",
      dispute: "⚡ 存疑争议",
      context: "📝 补充附注"
    };

    return {
      success: true,
      id: pointId,
      annotation_id: annotationId,
      kind,
      kind_label: kindEmojiMap[kind],
      source,
      source_badge: getSourceBadge(source),
      total_annotations: updatedPayload.annotations?.length || 1,
      message: `📌 已成功向记忆 '${pointId}' 追加不可变附注 [类型: ${kindEmojiMap[kind]}, 来源: ${getSourceBadge(source)}]。原文一字不动，保留因果可证伪性；后续检索将并置展示更正警示。`
    };
  }

  // 16. Tool: submit_concern
  if (name === "submit_concern") {
    const memoryId = (args.memory_id || "").trim();
    const reason = (args.reason || "").trim();
    const evidence = (args.evidence || "").trim();
    const severity: ConcernSeverity = args.severity || "medium";
    const interactionMode: InteractionMode = args.interaction_mode || "silent";

    if (!memoryId) throw new Error("Missing required argument: memory_id");
    if (!reason) throw new Error("Missing required argument: reason");
    if (!evidence) throw new Error("Missing required argument: evidence (现实证据链必须包含用户近期原话引言)");

    // Target memory validation
    const targetPoint = await getPointById(memoryId, env);
    if (!targetPoint || !targetPoint.payload) {
      throw new Error(`目标记忆点 '${memoryId}' 未找到，请核实 ID 是否准确。`);
    }

    const concernId = crypto.randomUUID();
    const nowIso = new Date().toISOString();

    const result = await submitConcernToQdrant(
      {
        id: concernId,
        user_id: userId,
        memory_id: memoryId,
        reason,
        evidence,
        severity,
        interaction_mode: interactionMode,
        status: "pending",
        created_at: nowIso,
        updated_at: nowIso,
        duplicate_count: 1,
        defer_count: 0
      },
      env
    );

    return {
      success: true,
      concern_id: result.id,
      memory_id: memoryId,
      severity,
      interaction_mode: interactionMode,
      status: result.status,
      duplicate_count: result.duplicate_count,
      is_new: result.is_new,
      message: result.is_new
        ? `✅ 记忆卫生顾虑已成功提交至私域分诊台。专职医生将在下个巡诊周期根据严重程度分级排期介入审理。`
        : `✅ 目标记忆 '${memoryId}' 再次被上报异常，已自动追加最新证据，累计提报达到 ${result.duplicate_count} 次并动态提升排期水位。`
    };
  }

  // 17. Tool: get_maintenance_cases (🩺 医生专用)
  if (name === "get_maintenance_cases") {
    const limit = Math.min(Math.max(parseInt(args.limit) || 5, 1), 20);
    const triageResult = await getDoctorTriageCases(userId, limit, env);

    if (!triageResult.has_cases) {
      return {
        has_cases: false,
        case_count: 0,
        message: "🩺 巡诊确认完毕：当前私域分诊台无达到排期水位的候诊案卷，外脑记忆肌体运行健康良好。",
        cases: []
      };
    }

    return {
      has_cases: true,
      case_count: triageResult.case_count,
      message: `🩺 本次巡诊共检索出 ${triageResult.case_count} 宗达到分诊水位的认知卫生候诊案件，请医生调阅旧病历与证据链下达临床处方。`,
      cases: triageResult.cases
    };
  }

  // 18. Tool: resolve_maintenance_case (🩺 医生专用)
  if (name === "resolve_maintenance_case") {
    const caseId = (args.case_id || "").trim();
    const memoryId = (args.memory_id || "").trim();
    const verdict: DoctorVerdict = args.verdict;
    const treatment: DoctorTreatment | undefined = args.treatment;
    const updatedContent = (args.updated_content || "").trim();
    const doctorNotes = (args.doctor_notes || "").trim();

    if (!caseId) throw new Error("Missing required argument: case_id");
    if (!memoryId) throw new Error("Missing required argument: memory_id");
    if (!verdict) throw new Error("Missing required argument: verdict (RESOLVED | DEFERRED | ESCALATED_TO_USER)");
    if (!doctorNotes) throw new Error("Missing required argument: doctor_notes (必须提供病历诊断小结)");

    if (verdict === "RESOLVED" && !treatment) {
      throw new Error("当 verdict 为 RESOLVED 时，必须明确指定 treatment (KEEP | UPDATE | EXPIRE | MERGE)");
    }
    if (verdict === "RESOLVED" && treatment === "UPDATE" && !updatedContent) {
      throw new Error("当 treatment 为 UPDATE 时，必须提供 updated_content (修正后的精确记忆文本)");
    }

    const targetPoint = await getPointById(memoryId, env);
    if (!targetPoint || !targetPoint.payload) {
      throw new Error(`目标记忆点 '${memoryId}' 未找到。`);
    }
    const oldPayload = targetPoint.payload;
    const nowIso = new Date().toISOString();
    const nowMs = Date.now();

    let actionDetails = "";

    // 1. Execute prescription on target memory in constancy_memories
    if (verdict === "RESOLVED") {
      if (treatment === "UPDATE") {
        // Create Superseded Lineage:
        // a. Old memory marks expired + superseded_by newId + appends annotation
        const newMemoryId = crypto.randomUUID();
        const annotation: MemoryAnnotation = {
          id: crypto.randomUUID(),
          timestamp: nowIso,
          kind: "correction",
          text: `【🩺 医生临床处方】${doctorNotes}（后继世代: ${newMemoryId}）`,
          source: "model_inferred"
        };
        const currentAnnotations = Array.isArray(oldPayload.annotations) ? [...oldPayload.annotations] : [];
        currentAnnotations.push(annotation);

        await setPointPayload(memoryId, {
          status: "expired",
          retired: true,
          retired_at: nowIso,
          retired_reason: `[医生更新] ${doctorNotes}`,
          superseded_by: newMemoryId,
          annotations: currentAnnotations,
          t_last_update: nowMs
        }, env);

        // b. Insert new memory point with predecessor link
        const newVector = await getEmbedding(updatedContent, env, "document");
        const initialH = injectIntent(new Array(7).fill(0), 1.0);
        const newPayload: MemoryPointPayload = {
          user_id: oldPayload.user_id,
          content: updatedContent,
          timestamp: nowIso,
          date: nowIso.slice(0, 10),
          type: oldPayload.type || "insight",
          entities: oldPayload.entities || [],
          tags: oldPayload.tags || [],
          source: "model_inferred",
          ch_prior: oldPayload.ch_prior || 9.0,
          h_spectrum: initialH,
          t_last_update: nowMs,
          t_last_strong: nowMs,
          status: "active",
          predecessor: memoryId
        };
        await upsertMemoryPoint(newMemoryId, newVector, newPayload, env);
        actionDetails = `已将旧记忆标记退役（指向后继 ${newMemoryId}），并成功写入世代更迭后的健康记忆。`;

      } else if (treatment === "EXPIRE") {
        const annotation: MemoryAnnotation = {
          id: crypto.randomUUID(),
          timestamp: nowIso,
          kind: "correction",
          text: `【🩺 医生临床处方】标记失效：${doctorNotes}`,
          source: "model_inferred"
        };
        const currentAnnotations = Array.isArray(oldPayload.annotations) ? [...oldPayload.annotations] : [];
        currentAnnotations.push(annotation);

        await setPointPayload(memoryId, {
          status: "expired",
          retired: true,
          retired_at: nowIso,
          retired_reason: doctorNotes,
          annotations: currentAnnotations,
          t_last_update: nowMs
        }, env);
        actionDetails = `已对该病灶记忆标记失效 (status: expired)，退出活跃检索队列。`;

      } else if (treatment === "KEEP") {
        const annotation: MemoryAnnotation = {
          id: crypto.randomUUID(),
          timestamp: nowIso,
          kind: "context",
          text: `【🩺 医生巡诊确认】复核健康，维持原状：${doctorNotes}`,
          source: "model_inferred"
        };
        const currentAnnotations = Array.isArray(oldPayload.annotations) ? [...oldPayload.annotations] : [];
        currentAnnotations.push(annotation);

        await setPointPayload(memoryId, {
          status: "active",
          suspicion_count: 0,
          annotations: currentAnnotations,
          t_last_update: nowMs
        }, env);
        actionDetails = `复核确认记忆准确健康，清空存疑计数，维持原状。`;
      }
    } else if (verdict === "DEFERRED") {
      const deferCount = (oldPayload.defer_count || 0) + 1;
      const suspicionCount = (oldPayload.suspicion_count || 0) + 1;
      await setPointPayload(memoryId, {
        defer_count: deferCount,
        suspicion_count: suspicionCount,
        t_last_update: nowMs
      }, env);
      actionDetails = `证据不足，已登记留观跟踪 (累计留观 ${deferCount} 次)，避免草率动刀。`;
    } else if (verdict === "ESCALATED_TO_USER") {
      await setPointPayload(memoryId, {
        pending_user_confirmation: true,
        t_last_update: nowMs
      }, env);
      actionDetails = `案情重大且存疑，已将案卷转送至后花园控制台，等待用户主权裁决。`;
    }

    // 2. Update Qdrant concerns collection
    const updatedCount = await updateCaseConcerns(userId, memoryId, caseId, verdict, treatment, doctorNotes, env);

    return {
      success: true,
      case_id: caseId,
      memory_id: memoryId,
      verdict,
      treatment: treatment || null,
      concerns_closed: updatedCount,
      action_details: actionDetails,
      doctor_notes: doctorNotes,
      message: `🩺 案卷 ${caseId} 临床处方已成功下达并留档执行。`
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
          version: "1.4.0",
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
