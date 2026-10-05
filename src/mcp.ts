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
  InteractionMode,
  InspectMemoryResult,
  LineageNodeSummary
} from "./actd";
import { getEmbedding, VoyageEnv } from "./voyage";
import {
  upsertMemoryPoint,
  searchMemoryPoints,
  searchImagePoints,
  getImagePoint,
  findImagePointsByImageId,
  deleteImagePoints,
  findNoteByImageId,
  findEntityPoints,
  retireMemoryPoints,
  deleteMemoryPoints,
  appendMemoryAnnotation,
  getTimelinePoints,
  updatePointSpectrum,
  getPointById,
  findMemoryPointByPrefix,
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

declare const Buffer: any;

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(buffer).toString("base64");
  }
  const bytes = new Uint8Array(buffer);
  const CHUNK_SIZE = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    const chunk = bytes.subarray(i, i + CHUNK_SIZE);
    binary += String.fromCharCode.apply(null, chunk as any);
  }
  return btoa(binary);
}

export function getBase64ByteLength(base64: string): number {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(base64, "base64").byteLength;
  }
  return atob(base64).length;
}

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

export async function resolveTargetMemoryPoint(
  targetId: string,
  userId: string,
  env: McpEnv
): Promise<{ pointId: string; payload: MemoryPointPayload; isLinkedFromImage?: boolean; imageId?: string } | null> {
  let cleanId = (targetId || "").trim();
  if (!cleanId) return null;

  cleanId = cleanId.replace(/^case[-_:]/i, "").trim();

  // 1. If valid UUID, try direct constancy_memories fetch first
  const isUuid = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(cleanId);
  if (isUuid) {
    const directPoint = await getPointById(cleanId, env);
    if (directPoint && directPoint.payload && directPoint.payload.user_id === userId) {
      return { pointId: cleanId, payload: directPoint.payload };
    }

    // A complete UUID could also directly identify an image in the images collection
    const imgPoint = await getImagePoint(cleanId, userId, env);
    if (imgPoint && imgPoint.payload) {
      const resolvedImageId = imgPoint.payload.image_id || imgPoint.id;
      const linkedNote = await findNoteByImageId(resolvedImageId, userId, env);
      if (linkedNote && linkedNote.payload && linkedNote.payload.user_id === userId) {
        return {
          pointId: linkedNote.id,
          payload: linkedNote.payload,
          isLinkedFromImage: true,
          imageId: resolvedImageId
        };
      }
    }

    // STRICT SHORT-CIRCUIT: A complete 36-character UUID is NEVER a prefix!
    // If not found directly in memories or images, it definitely does not exist.
    // Early exit here immediately avoids cascading multi-page prefix and note scans!
    return null;
  }

  // 2. Try prefix match in constancy_memories for this user (e.g. 6+ char hex prefix)
  // Direct memory point IDs ALWAYS take priority over secondary image associations!
  if (cleanId.length >= 6 && /^[0-9a-fA-F-]+$/.test(cleanId)) {
    const prefixMatch = await findMemoryPointByPrefix(cleanId, userId, env);
    if (prefixMatch && prefixMatch.payload && prefixMatch.payload.user_id === userId) {
      return {
        pointId: prefixMatch.id,
        payload: prefixMatch.payload
      };
    }
  }

  // 3. Check if cleanId matches an image in images collection (by point UUID or image_id, exact or prefix)
  const imgPoint = await getImagePoint(cleanId, userId, env);
  if (imgPoint && imgPoint.payload) {
    const resolvedImageId = imgPoint.payload.image_id || imgPoint.id;
    const linkedNote = await findNoteByImageId(resolvedImageId, userId, env);
    if (linkedNote && linkedNote.payload && linkedNote.payload.user_id === userId) {
      return {
        pointId: linkedNote.id,
        payload: linkedNote.payload,
        isLinkedFromImage: true,
        imageId: resolvedImageId
      };
    }
  }

  // 4. Try matching image_id directly on notes in constancy_memories (if cleanId is an image_id prefix)
  if (cleanId.length >= 6 && /^[0-9a-fA-F-]+$/.test(cleanId)) {
    const linkedNoteDirect = await findNoteByImageId(cleanId, userId, env);
    if (linkedNoteDirect && linkedNoteDirect.payload && linkedNoteDirect.payload.user_id === userId) {
      return {
        pointId: linkedNoteDirect.id,
        payload: linkedNoteDirect.payload,
        isLinkedFromImage: true,
        imageId: cleanId
      };
    }
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

export const CONSTANCY_VERSION = "1.9.0";

export function generateAgentInitInfo(
  role: string = "chat",
  verbosity: string = "compact",
  userId: string = "default",
  domain: string = "mcp.kufof.uk"
): {
  version: string;
  server_name: string;
  timestamp: string;
  user_id: string;
  role: string;
  verbosity: string;
  system_instructions: string;
  quick_reference: {
    primary_tools: string[];
    forbidden_tools: string[];
    key_rules: string[];
  };
} {
  const normalizedRole = ["doctor", "all"].includes(role.toLowerCase()) ? role.toLowerCase() : "chat";
  const isDetailed = verbosity.toLowerCase() === "detailed";
  const nowIso = new Date().toISOString();

  let instructions = "";
  let primaryTools: string[] = [];
  let forbiddenTools: string[] = [];
  let keyRules: string[] = [];

  if (normalizedRole === "chat") {
    primaryTools = [
      "search_memory",
      "update_memory",
      "submit_concern",
      "log_memory",
      "save_note",
      "list_notes",
      "get_note",
      "update_note",
      "fetch_image_vision",
      "request_image_upload",
      "commit_image_record"
    ];
    forbiddenTools = ["get_maintenance_cases", "resolve_maintenance_case"];
    keyRules = [
      "【确凿事实当面改】用户亲口陈述事实变动，当场调用 update_memory 完成原子换代，零推诿等待",
      "【隐性存疑挂号报】发现记忆与现实存在潜在出入或漂移，调用 submit_concern（带用户原话引言）",
      "【硬门禁拦截】仅 user_stated 来源可建立决策(decision)与待办(todo)，严禁越权替用户立项",
      "【存疑横幅留余地】检索结果带有【⚠️ 事实存疑待核】前缀时，向用户回复需自然留有余地"
    ];

    if (!isDetailed) {
      instructions = `# 🧭 Constancy 记忆体系 Agent 航海指南 (v${CONSTANCY_VERSION})
- 服务端: constancy-mcp v${CONSTANCY_VERSION} | 私域用户: \`${userId}\` | 节点: \`${domain}\` | 时间: ${nowIso}

## 1. 你的角色定位 (Persona)
你是用户的日常对话伙伴与记忆管家。你的职责是：**检索当下有效真理、确凿事实当面换代、异常矛盾法定义务上报**。

## 2. 核心行为决策树 (Decision Flow)
- 🔍 **【查】找历史认知/便签/照片** ➡️ 调用 \`search_memory\`；查原样便签/待办用 \`list_notes\` / \`get_note\`；查视觉细节用 \`fetch_image_vision\`。
  - *注：若返回内容带有 \`【⚠️ 事实存疑待核】\`，代表该记忆已被提出存疑，回复时请自然留有余地或向用户确认。*
- ⚡ **【改】用户当面明确更正事实** ➡️ **当场调用 \`update_memory(id, content, reason)\`** 原子世代换代与重算向量，零推诿、零延迟！（便签修改用 \`update_note\`）。
- 📋 **【疑】隐性矛盾/习惯漂移/存疑出入** ➡️ **调用 \`submit_concern\` 挂号上报**（必须包含用户原话引言作为 evidence，禁止主观脑补删改）。
- ✍️ **【增】用户表达新认知/偏好** ➡️ 调用 \`log_memory\`（**铁律门禁**：仅 \`source: 'user_stated'\` 可建立 \`decision\` 与 \`todo\`）。
- 📌 **【备】随手待办/代码/配置** ➡️ 调用 \`save_note\`（上限 10KB，可附带 base64 载荷）。
- 🖼️ **【图】上传新照片到图库** ➡️ \`request_image_upload\` 获取直传 URL，经沙箱/本地 curl 上传成功后调用 \`commit_image_record\` 闭环入库。

## 3. 铁律红线 (Hard Rules)
1. **硬门禁拦截**：严禁替用户私立决断或待办（无 \`user_stated\` 直陈必遭硬拦截抛错）。
2. **严禁越权处方**：\`get_maintenance_cases\` 与 \`resolve_maintenance_case\` 为专职巡诊医生独占工具，日常会话严禁调用。
3. **法定义务**：发现既有记忆与现实发生摩擦，不得视而不见，必须调用 \`submit_concern\` 提交分诊台。`;
    } else {
      instructions = `# 🧭 Constancy 记忆体系 Agent 航海指南 (v${CONSTANCY_VERSION} 详尽版)
- 服务端: constancy-mcp v${CONSTANCY_VERSION} | 私域用户: \`${userId}\` | 节点: \`${domain}\` | 时间: ${nowIso}

## 1. 你的角色与心智 (Persona)
你是用户的日常对话伙伴与记忆管家。你的职责是：**业务消费当下真理、确凿事实当面换代、异常矛盾法定义务上报**。

## 2. 核心行为决策树 (Decision Flow)
- 🔍 **【查】找历史认知/便签/照片** ➡️ 调用 \`search_memory\`；查原样便签/待办用 \`list_notes\` / \`get_note\`；查视觉细节用 \`fetch_image_vision\`。
  - *注：若返回内容带有 \`【⚠️ 事实存疑待核】\`，代表该记忆已被挂上存疑注记，回复时请自然留有余地或适度向用户求证。*
- ⚡ **【改】用户当面明确更正事实** ➡️ **当场调用 \`update_memory(id, content, reason)\`** 原子世代换代与重算向量，零推诿、零延迟！（便签修改用 \`update_note\`）。
- 📋 **【疑】隐性矛盾/习惯漂移/存疑出入** ➡️ **调用 \`submit_concern\` 挂号上报**（必须包含用户原话引言作为 evidence，禁止主观脑补删改）。
- ✍️ **【增】用户表达新认知/偏好** ➡️ 调用 \`log_memory\`（**铁律门禁**：仅 \`source: 'user_stated'\` 可建立 \`decision\` 与 \`todo\`）。
- 📌 **【备】随手待办/代码/配置** ➡️ 调用 \`save_note\`（上限 10KB，可附带 base64 载荷）。
- 🖼️ **【图】上传新照片到图库** ➡️ \`request_image_upload\` 获取直传 URL，经沙箱/本地 curl 上传成功后调用 \`commit_image_record\` 闭环入库。

## 3. 确凿换代 vs. 存疑上报判定准则 (Case Studies)
- **场景 1 (确凿变更 ➡️ \`update_memory\`)**：
  - 用户说：“我搬到上海了，以后默认按上海的作息和天气安排，把之前的北京地址改掉。”
  - 动作：当班 LLM 不推诿给医生，直接调用 \`update_memory(id, content: "用户现定居于上海市...", reason: "用户亲口直陈已迁往上海")\`。
- **场景 2 (偶发行为/习惯漂移 ➡️ \`submit_concern\`)**：
  - 记忆显示“长期喝美式”。用户说：“今天好累，帮我查查徐家汇有什么好喝的生椰拿铁。”
  - 动作：不要主观认定用户不再喝美式，调用 \`submit_concern(severity: "medium", interaction_mode: "silent", evidence: "用户原话引言")\` 交由医生审理。
- **场景 3 (彻底废弃 ➡️ \`retire_memory\`)**：
  - 用户说：“这个项目彻底取消了，以后不需要再提。”
  - 动作：调用 \`retire_memory(id, reason: "用户明确项目取消")\`。

## 4. ACTD 时效动力学与健康度状态
- 🟢 **确信有效 (Fresh, V ≥ 0.7)**：记忆成立度极高，放心作为推理依据；
- 🟡 **临界待核实 (Drifting, 0.2 ≤ V < 0.7)**：接近衰减半衰期，可适度向用户确认，若用户确认有效可调用 \`confirm_memory\` 注入能量满血复活；
- ⚪ **蒸发沉淀态 (Dormant, V < 0.2)**：已被自然代谢过滤，检索默认屏蔽，避免幽灵干扰。

## 5. 铁律红线 (Hard Rules)
1. **硬门禁拦截**：严禁替用户私立决断或待办（无 \`user_stated\` 直陈必遭硬拦截抛错）。
2. **严禁越权处方**：\`get_maintenance_cases\` 与 \`resolve_maintenance_case\` 为专职巡诊医生独占工具，日常会话严禁调用。
3. **法定义务**：发现既有记忆与现实发生摩擦，不得视而不见，必须调用 \`submit_concern\` 提交分诊台。`;
    }
  } else if (normalizedRole === "doctor") {
    primaryTools = ["get_maintenance_cases", "resolve_maintenance_case", "inspect_memory"];
    forbiddenTools = ["update_memory", "save_note", "create_upload_url"];
    keyRules = [
      "【核心哲学】不维护全量记忆库，只维护被现实摩擦暴露出来的异常",
      "【审慎动刀】Primum non nocere，宁可留观三次(DEFERRED)，不可草率误切",
      "【证据至上】只采纳清晰明确的用户原话引言，严禁情绪化主观脑补",
      "【低熵归并】发现同构碎片繁多时，开具 MERGE 处方去重精炼"
    ];

    if (!isDetailed) {
      instructions = `# 🩺 Constancy 认知卫生专职医生执业规约 (v${CONSTANCY_VERSION})
- 服务端: constancy-mcp v${CONSTANCY_VERSION} | 私域用户: \`${userId}\` | 节点: \`${domain}\` | 时间: ${nowIso}

## 1. 你的角色与核心哲学
你是 Constancy 认知外脑的专职巡诊医生（Cognitive Hygiene Doctor）。
**核心哲学**：不维护全量记忆库，只维护被现实摩擦暴露出来的异常。

## 2. 巡诊标准操作流 (SOP)
1. **获取案卷**：启动后立即调用 \`get_maintenance_cases({ limit: 5 })\`。
   - 若 \`has_cases: false\`：外脑肌体运行良好，汇报“肌体健康”后秒级收工（0 Token 消耗）。
2. **证据研判**：若有案卷，逐案比对目标记忆与提报的全部用户原话证据链。
3. **下达临床处方**：调用 \`resolve_maintenance_case\`：
   - \`RESOLVED + UPDATE\`：变迁确凿，提供修正后正文，执行世代交替；
   - \`RESOLVED + EXPIRE\`：病灶坏死或事实失效，软归档沉淀；
   - \`RESOLVED + KEEP\`：经复核记忆准确未变（如偶发行为不改主偏好），维持原状；
   - \`RESOLVED + MERGE\`：多条同构碎片去重，浓缩精炼为单条条目（传入 \`merge_with_ids\`）；
   - \`DEFERRED\`：证据单薄不足以断案，留观跟踪（严禁草率动刀）；
   - \`ESCALATED_TO_USER\`：重大敏感人际/财产决断冲突，转送后花园控制台请人类主人会诊。

## 3. 执业铁律
- **审慎动刀 (Primum non nocere)**：宁可留观三次，不可草率误切；
- **证据至上**：只采纳清晰明确的用户原话引言，坚决摒弃情绪化主观脑补。`;
    } else {
      instructions = `# 🩺 Constancy 认知卫生专职医生执业规约 (v${CONSTANCY_VERSION} 详尽版)
- 服务端: constancy-mcp v${CONSTANCY_VERSION} | 私域用户: \`${userId}\` | 节点: \`${domain}\` | 时间: ${nowIso}

## 1. 你的角色与核心哲学
你是 Constancy 认知外脑的专职巡诊医生（Cognitive Hygiene Doctor）。
**核心哲学**：不维护全量记忆库，只维护被现实摩擦暴露出来的异常。

## 2. 候诊排期与分诊水位机制 (Triage Calculus)
后台已自动计算分诊水位，医生无需做时间数学：
- **高危通道 (≤1h)**：\`severity === "high"\` 或 \`interaction_mode === "user_confirmed"\` 或 累计提报 ≥ 3 次，每小时巡诊必然出列；
- **中危通道 (≤6h)**：\`severity === "medium"\`，挂号满 6 小时、或累计提报 ≥ 2 次、或整点为 00/06/12/18 时出列；
- **低危通道 (24h)**：\`severity === "low"\`，挂号满 24 小时或每日拂晓批处理 (04:00 UTC)；
- **留观复诊 (Deferred)**：留观满 48 小时且有新证据追加时自动重新唤醒。

## 3. 临床处方详解 (Verdict & Treatment)
- **\`RESOLVED + UPDATE\`**：事实确已变迁（例如确凿证实定居地搬迁），提供修正后的完整 Markdown 文本。系统将创生新世代点并使旧点退役指向新点；
- **\`RESOLVED + EXPIRE\`**：明确已失效或废弃的事实，软归档标记 \`retired: true\` 并记录废弃原因；
- **\`RESOLVED + KEEP\`**：经研判属误报或单次偶发行为（如偶尔喝拿铁不改变长期爱喝美式的事实），维持原状并清空存疑计数；
- **\`RESOLVED + MERGE\`**：将多条高度同构、碎片化重复的条目归并合一，消除记忆库冗余与熵增；
- **\`DEFERRED\`**：证据单薄、模棱两可时选择留观跟踪，案卷进入留观池等待后续会话进一步证据；
- **\`ESCALATED_TO_USER\`**：涉及核心人际关系裂痕、资产配置等重大敏感决断，转呈后花园控制台由人类主人亲自定夺。

## 4. 执业铁律
- **审慎动刀 (Primum non nocere)**：宁可留观三次，不可草率误切；
- **证据至上**：只采纳清晰明确的用户原话引言，坚决摒弃情绪化主观脑补；
- **尊重谱系**：若需全景因果溯源，调用 \`inspect_memory\` 双向追溯前身与后继链。`;
    }
  } else {
    // "all"
    primaryTools = MCP_TOOLS.map(t => t.name);
    forbiddenTools = [];
    keyRules = [
      "前线业务消费态与后台病理审计态物理分离",
      "前线会话：确凿换代 update_memory、时效检索 search_memory、异常挂号 submit_concern",
      "专职医生：定时巡诊 get_maintenance_cases、下达处方 resolve_maintenance_case、低熵归并 MERGE",
      "底层物理常态代谢由 ACTD 连续懒衰减数学引擎静默完成，0 Token 浪费"
    ];

    instructions = `# 🌌 Constancy 认知外脑体系全景规约 (v${CONSTANCY_VERSION})
- 服务端: constancy-mcp v${CONSTANCY_VERSION} | 私域用户: \`${userId}\` | 节点: \`${domain}\` | 时间: ${nowIso}

## 1. 架构哲学：业务消费态与病理审计态分离
- **前线业务消费态 (Serving Layer)**：由日常会话 LLM 负责，追求极致信噪比、零二次加工、确凿事实当场换代 (\`update_memory\`)；
- **后台病理审计态 (Forensics Layer)**：由专职巡诊医生与后台分诊台负责，追求 100% 不可变历史回溯、审慎动刀、低熵归并 (\`MERGE\`)；
- **底层物理代谢态 (ACTD Physics Layer)**：由 7 维时间能量谱与连续懒衰减数学引擎负责，无感计算健康度 V，不耗费 LLM Token。

## 2. 角色职责矩阵 (Duty Matrix)
| 维度 | 🚀 当班会话 LLM | 🩺 巡诊医生 LLM |
| :--- | :--- | :--- |
| **运行时态** | 实时随路触发 | 后台定时离线巡诊 (整点唤醒) |
| **核心检索** | \`search_memory\` / \`get_note\` / \`list_notes\` | \`get_maintenance_cases\` / \`inspect_memory\` |
| **事实更迭** | 当面确凿变更调用 \`update_memory\` | 跨会话裁决更迭下达 \`UPDATE\` 处方 |
| **异常感知** | 发现模糊矛盾调用 \`submit_concern\` 挂号 | 审理案卷证据链，独占处方权 |
| **低熵归并** | ❌ 严禁擅自合并跨会话碎片 | 开具 \`RESOLVED + MERGE\` 处方 |

## 3. 全量工具清单 (${MCP_TOOLS.length} 个)
${MCP_TOOLS.map((t, idx) => `${idx + 1}. \`${t.name}\`: ${t.description.split("。")[0]}`).join("\n")}
`;
  }

  return {
    version: CONSTANCY_VERSION,
    server_name: "constancy-mcp",
    timestamp: nowIso,
    user_id: userId,
    role: normalizedRole,
    verbosity: isDetailed ? "detailed" : "compact",
    quick_reference: {
      primary_tools: primaryTools,
      forbidden_tools: forbiddenTools,
      key_rules: keyRules
    },
    system_instructions: instructions
  };
}

export const MCP_TOOLS = [
  {
    name: "get_agent_init_info",
    description: "【Agent 启航与工作法手册】获取当前 Constancy MCP 服务的版本状态、系统架构哲学、角色职责矩阵以及高密度操作法则。当 Agent 首次接入系统、需要厘清自身分工、或需要查询某类业务的最佳工具调用链路时调用。",
    inputSchema: {
      type: "object",
      properties: {
        role: {
          type: "string",
          enum: ["chat", "doctor", "all"],
          description: "当前 Agent 扮演的角色：'chat'(日常交互/前线会话，默认)、'doctor'(专职巡诊医生)、'all'(全景架构与完整规范)。默认 'chat'。"
        },
        verbosity: {
          type: "string",
          enum: ["compact", "detailed"],
          description: "内容详略度：'compact'(高密度速查摘要，默认，极省 Token)、'detailed'(含完整案例与推演 SOP)。默认 'compact'。"
        }
      }
    }
  },
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
        },
        pending_confirmation_only: {
          type: "boolean",
          description: "可选。若为 true，仅检索由医生升级转交至用户、等待用户主权裁决的疑难记忆点 (ESCALATED_TO_USER)"
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
    name: "update_memory",
    description: "【事实更迭/世代换代】当用户直陈事实发生变更、或需对既有记忆进行明确纠错更正时调用。系统会自动将旧版本记忆安全退役归档（保留不可变历史痕迹），并以修正后的新内容即时生成新世代记忆、重算高精度向量嵌入，同时平滑继承前身谱系能量与人基常度 C_H。保证后续语义检索 100% 准确命中新事实，彻底根除模型歧义与多轮工具递归开销。",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "待更迭的原记忆 ID (支持完整 UUID、6+ 位前缀简码或 CASE- 编号)"
        },
        content: {
          type: "string",
          description: "更正后的全新完整记忆正文 (纯 Markdown 格式，力求完整、准确地陈述最新事实)"
        },
        reason: {
          type: "string",
          description: "更迭原因或事实依据 (可选，例如：'用户亲口直陈已迁往上海')"
        }
      },
      required: ["id", "content"]
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
        },
        source: {
          type: "string",
          enum: ["user_stated", "model_suggested", "model_inferred", "external"],
          description: "认知来源属性（可选。'user_stated'=用户直陈，默认；'model_inferred'=模型推断；'external'=外部输入。更新既有实体时若不传则自动继承原版本来源）"
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
    name: "fetch_image_vision",
    description: "【视觉直读】将图库中的指定图片以图像形式直接载入模型视觉通道，无需沙箱下载。当需要亲眼核对画面细节（辨认招牌小字、核实物体位置、比对与文字描述是否一致、回答'图里到底有没有某物'）时调用。若仅需向用户展示图片或提供下载链接，请改用 get_blob_url；若需批量处理、裁剪或本地 OCR，请走沙箱 curl 路径。每次仅能载入一张图，请按需选择分辨率变体以控制 Token 开销：ai512 极省（约200-350 tokens，用于粗粒度识别）、ai768 推荐默认（约500-800 tokens，通用场景理解）、ai1024 高精（约1100-1600 tokens，仅用于密集文本/复杂图表）。",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Cloudflare 图片 ID (image_id)、图库点 UUID，或与图片关联的 Note 便签 UUID（多态解析）。必填。"
        },
        variant: {
          type: "string",
          enum: ["ai512", "ai768", "ai1024"],
          description: "分辨率变体，默认 ai768。注意严禁开放 public 原图变体，避免数百万像素灌爆上下文。"
        },
        include_metadata: {
          type: "boolean",
          description: "是否在图像块之前附带一小段简短文本块（说明该图标题、拍摄时间、GPS坐标）。默认 true。"
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
          description: "可选。若图库中该图片尚未创建关联便签，是否在 Constancy 便签库创建关联 Note 便签（默认 true）。注意：若关联便签已存在，系统将无条件强制同步更新该便签并记录 revisions 审计链，不受此参数限制。"
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
        },
        merge_with_ids: {
          type: "array",
          items: { type: "string" },
          description: "可选。当处置方案为 MERGE 时，需一并归并退役的同构/重复旧记忆点 ID 清单"
        }
      },
      required: ["case_id", "memory_id", "verdict", "doctor_notes"]
    }
  },
  {
    name: "inspect_memory",
    description: "【认知基因透视/单点因果验血】按 ID 精确获取指定记忆点的完整底层元数据（含 7 维时间热度谱、时效健康度 V、不可变版本链 revisions 与附注 annotations），并自动双向递归追溯其因果前身链 (predecessor) 与后继更迭链 (superseded_by)，完整呈现从初代根源到最新活跃代的世代全景。支持查阅已废弃/归档的历史记忆。纯只读诊断，零热力学能量扰动，绝不篡改记忆生命周期。",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "目标记忆点 ID、UUID、前缀简码 (例如 'CASE-B67F5C30' 或 'b67f5c30') 或关联图片 ID"
        },
        max_depth: {
          type: "number",
          description: "世代追溯最大深度，默认 5，最大上限 10（防止环路与过度消耗）"
        }
      },
      required: ["id"]
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

  // 0. Tool: get_agent_init_info
  if (name === "get_agent_init_info") {
    const role = (args?.role || "chat").toLowerCase().trim();
    const verbosity = (args?.verbosity || "compact").toLowerCase().trim();
    return generateAgentInitInfo(role, verbosity, userId, env.DOMAIN || "mcp.kufof.uk");
  }

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

    // Initial energy injection (Centennial baseline inertia 1.5 for entities, 0 for regular memories)
    const isEntity = type === "entity" || chPrior >= 11.5;
    const baseEnergy = isEntity ? 1.5 : 0;
    const initialSpectrum = injectIntent(new Array(7).fill(baseEnergy), 1.0);

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

    const pendingConfirmationOnly = Boolean(args.pending_confirmation_only);
    const hasStructuredFilter = Boolean(dateFrom || dateTo || near || (typeFilter && typeFilter !== "all") || entity || pendingConfirmationOnly);

    if (!query && !imageUrl && !imageBase64 && !hasStructuredFilter) {
      throw new Error("Missing query, image input, or structured filter (date_from, date_to, near, entity, pending_confirmation_only)");
    }

    const limit = Math.min(Math.max(parseInt(args.limit) || 5, 1), 20);
    const minValidity = pendingConfirmationOnly ? 0.0 : (typeof args.min_validity === "number" ? Math.max(0, Math.min(1, args.min_validity)) : 0.2);
    const includeRetired = Boolean(args.include_retired);
    const isImageOnly = typeFilter === "image";
    const includeImages = !pendingConfirmationOnly && args.include_images !== false && (typeFilter === "" || typeFilter === "all" || typeFilter === "image");

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
      near,
      pending_confirmation_only: pendingConfirmationOnly || undefined
    };

    const searchMemoriesPromise = isImageOnly
      ? searchMemoryPoints(queryVector, userId, Math.min(limit, 8), env, { ...structuredFilter, type: "note" })
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
          pending_user_confirmation: Boolean(p.pending_user_confirmation),
          title: p.title || undefined,
          entity_name: p.entity_name || undefined,
          aliases: p.aliases || undefined,
          relations: p.relations || undefined,
          revisions_count: Array.isArray(p.revisions) ? p.revisions.length : 0,
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
        let displayContent = p.content;
        if (p.annotations && p.annotations.length > 0) {
          const hasDoubt = p.annotations.some((a: any) => a.kind === "contradiction" || a.kind === "doubt" || a.kind === "caveat");
          if (hasDoubt) {
            const notesSummary = p.annotations.map((a: any) => a.text).join("; ");
            displayContent = `【⚠️ 事实存疑待核】${p.content}\n\n> ⚠️【存疑/注意事项】: ${notesSummary}`;
          }
        }

        evaluatedList.push({
          id: item.id,
          content: displayContent,
          original_content: p.content !== displayContent ? p.content : undefined,
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
          pending_user_confirmation: Boolean(p.pending_user_confirmation),
          title: p.title || undefined,
          entity_name: p.entity_name || undefined,
          aliases: p.aliases || undefined,
          relations: p.relations || undefined,
          revisions_count: Array.isArray(p.revisions) ? p.revisions.length : 0,
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

    // Dual-channel visual asset recall: if notes with associated images were retrieved, pull their image points into imageCandidates
    const existingCandidateImgIds = new Set((imageCandidates || []).map((c: any) => c.payload?.image_id || c.id));
    for (const item of candidates) {
      const p = item.payload;
      if (!p) continue;
      const assocImgId = p.image_id || extractAssociatedImageId(p);
      if (assocImgId && !existingCandidateImgIds.has(assocImgId)) {
        existingCandidateImgIds.add(assocImgId);
        const linkedImgPoints = await findImagePointsByImageId(assocImgId, userId, env);
        if (linkedImgPoints.length > 0) {
          imageCandidates.push({
            id: linkedImgPoints[0].id,
            payload: linkedImgPoints[0].payload,
            score: Number((item.score || 0).toFixed(4))
          });
        }
      }
    }

    // Format visual image results with ready-to-use signed CDN URLs and curl commands
    // 🌟 FIX-3 (方案 B): 实时联查关联便签，以主库 (constancy_memories) 活跃便签的描述与治理注记为唯一权威
    const imageResultsRaw = await Promise.all((imageCandidates || []).map(async item => {
      const p = item.payload || {};
      const imgId = p.image_id || item.id;
      const variants = await getSignedImageVariants(imgId, env, 7200);

      const linkedNote = await findNoteByImageId(imgId, userId, env);
      const noteP = linkedNote?.payload;

      // Authoritative description: prefer active note content (strip trailing CF image ID tag)
      let displayDescription = p.description || "";
      if (noteP?.content) {
        displayDescription = noteP.content.replace(/\n*\[(?:Cloudflare Images ID|图片 ID):\s*[a-zA-Z0-9_-]+\]/gi, "").trim();
      }

      const annotations = noteP?.annotations && noteP.annotations.length > 0 ? noteP.annotations : undefined;
      const isRetired = Boolean(noteP?.retired || p.retired);
      const statusBadge = isRetired ? "⚪ 废弃归档" : (noteP?.annotations?.length ? "🟡 存疑更正" : "🟢 确信有效");

      return {
        image_id: imgId,
        title: noteP?.title || p.title || p.filename || "视觉图像资产",
        filename: p.filename || "image.jpg",
        description: displayDescription,
        score: Number((item.score || 0).toFixed(4)),
        tags: noteP?.tags || p.tags || [],
        exif: p.exif || undefined,
        location: p.location || noteP?.location || undefined,
        captured_at: p.captured_at || noteP?.captured_at || p.created_at || undefined,
        created_at: p.created_at,
        expires_in: 7200,
        url: variants.public,
        variants,
        variant_guide: AI_VISION_VARIANT_GUIDE,
        curl_command: `curl -s -o "${p.filename || 'downloaded_image.jpg'}" "${variants.public}"`,
        note_id: linkedNote?.id || undefined,
        annotations,
        has_annotations: Boolean(annotations && annotations.length > 0),
        status_badge: statusBadge,
        predecessor: noteP?.predecessor || undefined,
        superseded_by: noteP?.superseded_by || undefined,
        revisions_count: Array.isArray(noteP?.revisions) ? noteP.revisions.length : 0,
        retired: isRetired ? true : undefined
      };
    }));

    // Deduplicate imageResults by image_id (keep highest score) and filter retired if not requested
    const seenImgIds = new Set<string>();
    const imageResults: typeof imageResultsRaw = [];
    for (const img of imageResultsRaw) {
      if (img.image_id) {
        if (seenImgIds.has(img.image_id)) continue;
        seenImgIds.add(img.image_id);
      }
      if (img.retired && !includeRetired) continue;
      imageResults.push(img);
    }

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

    const totalFound = (isImageOnly ? 0 : memoryResults.length) + imageResults.length;
    const returnObj: any = {
      query: query || undefined,
      filter: hasStructuredFilter ? structuredFilter : undefined,
      found_count: totalFound
    };

    if (!isImageOnly) {
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
    const rawId = (args.id || "").trim();
    if (!rawId) throw new Error("Missing memory id");
    const note = (args.note || "").trim();
    const newCh = typeof args.c_h === "number" ? args.c_h : undefined;
    const revive = Boolean(args.revive);

    const resolved = await resolveTargetMemoryPoint(rawId, userId, env);
    if (!resolved || !resolved.payload || resolved.payload.user_id !== userId) {
      throw new Error(`Memory point or associated image '${rawId}' not found or unauthorized`);
    }

    const pointId = resolved.pointId;
    const p = resolved.payload;

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
      retired_reason: undefined,
      pending_user_confirmation: false,
      suspicion_count: 0,
      status: "active"
    };

    await setPointPayload(pointId, payloadUpdate, env);

    if (p.pending_user_confirmation) {
      await updateCaseConcerns(userId, pointId, "USER-CONFIRM", "RESOLVED", "KEEP", "用户本人核实验证确认记忆健康有效", env);
    }

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
    const rawId = (args.id || "").trim();
    const reason = (args.reason || "").trim();
    if (!rawId || !reason) throw new Error("Missing id or reason");

    const resolved = await resolveTargetMemoryPoint(rawId, userId, env);
    if (!resolved || !resolved.payload || resolved.payload.user_id !== userId) {
      throw new Error(`Memory point or associated image '${rawId}' not found or unauthorized`);
    }

    const pointId = resolved.pointId;
    const p = resolved.payload;
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
      status: "expired",
      pending_user_confirmation: false,
      ch_prior: 0.0,
      h_spectrum: new Array(7).fill(0),
      t_last_update: nowMs,
      t_last_strong: nowMs - 100000000000 // force V to 0
    };

    await setPointPayload(pointId, payloadUpdate, env);

    // If linked from an image, also retire point(s) in images collection
    const resolvedImageId = resolved.imageId || extractAssociatedImageId(p);
    if (resolvedImageId) {
      const imgPoints = await findImagePointsByImageId(resolvedImageId, userId, env);
      if (imgPoints.length > 0) {
        const qdrantUrl = env.QDRANT_URL.replace(/\/+$/, "");
        for (const ipt of imgPoints) {
          await fetch(`${qdrantUrl}/collections/images/points/payload?wait=true`, {
            method: "POST",
            headers: {
              "api-key": env.QDRANT_API_KEY?.trim() || "",
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              points: [ipt.id],
              payload: { retired: true, retired_at: new Date().toISOString(), retired_reason: reason }
            })
          });
        }
      }
    }

    if (p.pending_user_confirmation) {
      await updateCaseConcerns(userId, pointId, "USER-EXPIRE", "RESOLVED", "EXPIRE", `用户本人核实验证并宣告失效归档: ${reason}`, env);
    }

    return {
      success: true,
      id: pointId,
      validity: 0.0,
      status: "DORMANT",
      status_badge: "⚪ 已废弃归档 (Retired)",
      message: `📦 记忆 [${pointId}] 已标记为废弃归档 (原因: ${reason})。未来检索将自动物理屏蔽，彻底避免幽灵干扰。`
    };
  }

  // 5b. Tool: update_memory (Generational Turnover & Fact Correction)
  if (name === "update_memory") {
    const rawId = (args.id || "").trim();
    const updatedContent = (args.content || "").trim();
    const reason = (args.reason || "").trim() || "用户事实更迭更正";
    if (!rawId || !updatedContent) {
      throw new Error("Missing required argument: id or content");
    }

    const resolved = await resolveTargetMemoryPoint(rawId, userId, env);
    if (!resolved || !resolved.payload || resolved.payload.user_id !== userId) {
      throw new Error(`Memory point or associated image '${rawId}' not found or unauthorized`);
    }

    const oldPointId = resolved.pointId;
    const oldPayload = resolved.payload;
    const nowIso = new Date().toISOString();

    // 1. Create a brand new point ID for the new generation
    const newMemoryId = crypto.randomUUID();

    // 2. Mark old memory as retired + superseded_by newMemoryId + append annotation
    const annotation: MemoryAnnotation = {
      id: crypto.randomUUID(),
      timestamp: nowIso,
      kind: "correction",
      text: `【事实更迭换代】${reason}（后继世代: ${newMemoryId}）`,
      source: "user_stated"
    };
    const currentAnnotations = Array.isArray(oldPayload.annotations) ? [...oldPayload.annotations] : [];
    currentAnnotations.push(annotation);

    await setPointPayload(oldPointId, {
      status: "expired",
      retired: true,
      retired_at: nowIso,
      retired_reason: reason,
      superseded_by: newMemoryId,
      annotations: currentAnnotations,
      ch_prior: 0.0,
      h_spectrum: new Array(7).fill(0),
      t_last_update: nowMs,
      t_last_strong: nowMs - 100000000000 // force V to 0 for old point
    }, env);

    // If linked from image, also retire old image point(s) in images collection
    const resolvedImageId = resolved.imageId || extractAssociatedImageId(oldPayload);
    if (resolvedImageId) {
      const imgPoints = await findImagePointsByImageId(resolvedImageId, userId, env);
      if (imgPoints.length > 0) {
        const qdrantUrl = env.QDRANT_URL.replace(/\/+$/, "");
        for (const ipt of imgPoints) {
          await fetch(`${qdrantUrl}/collections/images/points/payload?wait=true`, {
            method: "POST",
            headers: {
              "api-key": env.QDRANT_API_KEY?.trim() || "",
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              points: [ipt.id],
              payload: { retired: true, retired_at: nowIso, retired_reason: reason, superseded_by: newMemoryId }
            })
          });
        }
      }
    }

    // 3. Compute new vector embedding for the updated content
    const newVector = await getEmbedding(updatedContent, env, "document");

    // 4. Inherit thermal spectrum with decay & intent injection (continuous lineage)
    const baseH = (Array.isArray(oldPayload.h_spectrum) && oldPayload.h_spectrum.length === 7)
      ? oldPayload.h_spectrum
      : (oldPayload.type === "entity" ? new Array(7).fill(1.5) : new Array(7).fill(0));
    const decayedH = decaySpectrum(baseH, oldPayload.t_last_update || nowMs, nowMs);
    const nextH = injectIntent(decayedH, 1.0);

    // 5. Preserve revisions audit trail
    const revisions: NoteRevision[] = Array.isArray(oldPayload.revisions) ? [...oldPayload.revisions] : [];
    if (oldPayload.content !== updatedContent) {
      revisions.unshift({
        timestamp: nowIso,
        content: oldPayload.content,
        title: oldPayload.title,
        entity_name: oldPayload.entity_name,
        aliases: oldPayload.aliases,
        relations: oldPayload.relations,
        tags: oldPayload.tags,
        reason: reason
      });
      if (revisions.length > 5) {
        revisions.length = 5;
      }
    }

    // 6. Inherit epistemic provenance
    const inheritedSource: MemorySourceType = oldPayload.source || "user_stated";

    const chPrior = oldPayload.ch_prior ?? (oldPayload.type === "entity" ? 11.5 : 9.0);
    const chDynamic = computeDynamicCh(chPrior, nextH);
    const resonantHeat = interpolateResonantHeat(nextH, chDynamic);
    const V = computeEpistemicHealth(chDynamic, resonantHeat, nowMs, nowMs);
    const classification = classifyHealth(V, oldPayload.tags || [], oldPayload.type || "", false, "", undefined);

    const newPayload: MemoryPointPayload = {
      user_id: oldPayload.user_id || userId,
      content: updatedContent,
      title: oldPayload.title,
      timestamp: nowIso,
      created_at: oldPayload.created_at || oldPayload.timestamp || nowIso,
      updated_at: nowIso,
      date: nowIso.slice(0, 10),
      type: oldPayload.type || "insight",
      entity_name: oldPayload.entity_name || undefined,
      aliases: oldPayload.aliases || undefined,
      relations: oldPayload.relations || undefined,
      entities: (oldPayload.entities && oldPayload.entities.length > 0)
        ? oldPayload.entities
        : (oldPayload.entity_name ? [oldPayload.entity_name, ...(oldPayload.aliases || [])] : []),
      tags: oldPayload.tags || [],
      source: inheritedSource,
      ch_prior: chPrior,
      h_spectrum: nextH,
      t_last_update: nowMs,
      t_last_strong: nowMs,
      status: "active",
      predecessor: oldPointId,
      image_id: oldPayload.image_id || undefined,
      location: oldPayload.location || undefined,
      revisions: revisions.length > 0 ? revisions : undefined
    };

    await upsertMemoryPoint(newMemoryId, newVector, newPayload, env);

    // If there were pending concerns for oldPointId, mark them resolved
    if (oldPayload.pending_user_confirmation) {
      await updateCaseConcerns(userId, oldPointId, "USER-UPDATE", "RESOLVED", "UPDATE", `用户直接调用 update_memory 完成世代更迭: ${reason}`, env);
    }

    return {
      success: true,
      id: newMemoryId,
      predecessor: oldPointId,
      content: updatedContent,
      validity: V,
      status: classification.status,
      status_badge: classification.badge,
      message: `🌱 记忆已成功完成世代更迭换代。新世代 [${newMemoryId}] 已完成向量重算与谱系继承；旧世代 [${oldPointId}] 已安全归档退役。`
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
    let chPrior = 11.5;
    const initialSpectrum = injectIntent(new Array(7).fill(1.5), 1.0);
    let entitySpectrum = initialSpectrum;
    let entitySource: MemorySourceType = (args.source && ["user_stated", "model_suggested", "model_inferred", "external"].includes(args.source))
      ? args.source
      : "user_stated";
    let tLastStrong = nowMs;

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
        if (!args.source && oldPayload.source) {
          entitySource = oldPayload.source;
        }
        if (typeof oldPayload.ch_prior === "number") {
          chPrior = Math.max(11.5, oldPayload.ch_prior);
        }

        // Inherit & decay thermal spectrum from prior generation, then inject active intent
        const baseH = (Array.isArray(oldPayload.h_spectrum) && oldPayload.h_spectrum.length === 7)
          ? oldPayload.h_spectrum
          : new Array(7).fill(1.5);
        const decayedH = decaySpectrum(baseH, oldPayload.t_last_update || nowMs, nowMs);
        entitySpectrum = injectIntent(decayedH, 1.0);
        tLastStrong = nowMs;

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
      source: entitySource,
      ch_prior: chPrior,
      h_spectrum: entitySpectrum,
      t_last_update: nowMs,
      t_last_strong: tLastStrong,
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
      source: entitySource,
      revisions_count: existingRevisions.length,
      retired_duplicates_count: existingPoints.length > 1 ? existingPoints.length - 1 : 0,
      message: isUpdate
        ? `🏛️ 已成功更新实体 '${entityName}' 的百科条目（常度: ${chPrior}，百年基石级，已继承热度谱与认知来源 [${entitySource}]，已记录版本审计快照${existingPoints.length > 1 ? `，已软归档 ${existingPoints.length - 1} 条历史重复条目` : ""}）`
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
      version: CONSTANCY_VERSION,
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
        const assocImgId = p.image_id || extractAssociatedImageId(p);
        if (assocImgId && p.content) {
          const baseDesc = p.content.replace(/\n*\[(?:Cloudflare Images ID|图片 ID):\s*[a-zA-Z0-9_-]+\]/gi, "").trim();
          newContent = `${baseDesc}\n${inputContent}\n\n[Cloudflare Images ID: ${assocImgId}]`;
        } else {
          newContent = p.content ? `${p.content}\n${inputContent}` : inputContent;
        }
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

    const prevUpdateMs = p.t_last_update || nowMs;

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
      const decayedH = decaySpectrum(p.h_spectrum || new Array(7).fill(0), prevUpdateMs, nowMs);
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

    // Bidirectional sync: if this note is associated with a Cloudflare Image, sync the images collection point and recompute vector!
    const assocImgId = p.image_id || extractAssociatedImageId(p);
    const tagsChanged = args.tags !== undefined;
    if (assocImgId && (contentChanged || titleChanged || tagsChanged)) {
      try {
        const imgPoints = await findImagePointsByImageId(assocImgId, userId, env);
        if (imgPoints.length > 0) {
          const cleanDesc = newContent.replace(/\n*\[(?:Cloudflare Images ID|图片 ID):\s*[a-zA-Z0-9_-]+\]/gi, "").trim();
          const imgP = imgPoints[0].payload || {};
          const imgTitle = newTitle || imgP.title || "视觉图像资产";
          const imgTags = newTags.filter((t: string) => t !== "gallery" && t !== "note");

          // 🌟 Recompute Voyage Multimodal embedding for images collection!
          const imgTextToEmbed = imgTitle ? `${imgTitle}\n${cleanDesc}\n${imgTags.join(" ")}` : `${cleanDesc}\n${imgTags.join(" ")}`;
          const imgVector = await getEmbedding(imgTextToEmbed, env, "document");

          const qdrantUrl = `${env.QDRANT_URL.replace(/\/+$/, "")}/collections/images/points?wait=true`;
          const updateRes = await fetch(qdrantUrl, {
            method: "PUT",
            headers: {
              "api-key": env.QDRANT_API_KEY?.trim() || "",
              "Content-Type": "application/json",
              "User-Agent": "curl/8.14.1 (constancy-mcp worker)"
            },
            body: JSON.stringify({
              points: [
                {
                  id: imgPoints[0].id,
                  vector: imgVector,
                  payload: {
                    ...imgP,
                    title: imgTitle,
                    description: cleanDesc,
                    tags: imgTags,
                    updated_at: now.toISOString()
                  }
                }
              ]
            })
          });

          if (!updateRes.ok) {
            console.warn(`Failed to update image point (${updateRes.status}): ${await updateRes.text()}`);
          }

          if (imgPoints.length > 1) {
            const redundantIds = imgPoints.slice(1).map(p => p.id);
            await deleteImagePoints(redundantIds, env);
          }
        }
      } catch (err: any) {
        console.warn("Failed to sync images collection from update_note:", err?.message || err);
      }
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

  // 11.1 Tool: fetch_image_vision
  if (name === "fetch_image_vision") {
    const rawId = (args.id || "").trim();
    if (!rawId) throw new Error("Missing required parameter: id");

    // Guardrail: Whitelist regex validation for id format
    if (!/^[a-zA-Z0-9_-]{4,128}$/.test(rawId)) {
      throw new Error(`Invalid id format: '${rawId}'. Expected valid UUID or image identifier.`);
    }

    const variant = (args.variant || "ai768").trim();
    if (!["ai512", "ai768", "ai1024"].includes(variant)) {
      throw new Error(`Invalid variant: '${variant}'. Only 'ai512', 'ai768', and 'ai1024' are permitted to protect context window.`);
    }
    const includeMetadata = args.include_metadata !== false;

    let targetImageId: string | null = null;
    let title: string = "视觉图像资产";
    let takenAt: string | undefined = undefined;
    let locationStr: string | undefined = undefined;
    let nativeBase64: string | null = null;
    let nativeMimeType: string = "image/jpeg";
    let isNoteWithoutImage = false;

    // 1. Try finding in constancy_memories (Note UUID or memory point)
    const isUuid = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(rawId);
    const point = isUuid ? await getPointById(rawId, env) : null;
    if (point && point.payload && point.payload.user_id === userId) {
      const p = point.payload;
      if (p.title) title = p.title;
      if (p.captured_at || p.created_at || p.timestamp) {
        takenAt = p.captured_at || p.created_at || p.timestamp;
      }
      const loc = p.location as any;
      if (loc) {
        const lat = loc.lat ?? loc.latitude;
        const lon = loc.lon ?? loc.longitude;
        if (typeof lat === "number" && typeof lon === "number") {
          locationStr = `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
        }
      }

      // Check if note contains native base64 image
      if (p.base64) {
        const declaredMime = (p.mime_type || "").toLowerCase().trim();
        if (declaredMime.startsWith("image/")) {
          nativeBase64 = p.base64;
          nativeMimeType = declaredMime.split(";")[0].trim();
        }
      }

      if (!nativeBase64) {
        const cfImageId = extractAssociatedImageId(p);
        if (cfImageId) {
          targetImageId = cfImageId;
        } else {
          isNoteWithoutImage = true;
        }
      }
    }

    if (isNoteWithoutImage && !targetImageId && !nativeBase64) {
      throw new Error(`Note '${rawId}' has no image attachment or associated Cloudflare Image ID.`);
    }

    // 2. Check images collection (by UUID or image_id or targetImageId)
    const lookupId = targetImageId || rawId;
    if (!nativeBase64) {
      const imgPoint = await getImagePoint(lookupId, userId, env);
      if (imgPoint && imgPoint.payload) {
        const p = imgPoint.payload;
        targetImageId = p.image_id || imgPoint.id;
        if (p.title || p.filename) {
          title = p.title || p.filename;
        }
        if (p.captured_at || p.taken_at || p.created_at) {
          takenAt = p.captured_at || p.taken_at || p.created_at;
        }
        const loc = p.location as any;
        if (loc) {
          const lat = loc.lat ?? loc.latitude;
          const lon = loc.lon ?? loc.longitude;
          if (typeof lat === "number" && typeof lon === "number") {
            locationStr = `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
          }
        }
      }
    }

    // 3. Fallback: if rawId itself is a direct Cloudflare image_id
    if (!nativeBase64 && !targetImageId) {
      targetImageId = rawId;
    }

    // Branch A: Note has native Base64 image
    if (nativeBase64) {
      const allowedMimes = ["image/jpeg", "image/png", "image/webp", "image/gif"];
      if (!allowedMimes.includes(nativeMimeType)) {
        throw new Error(`Unsupported image MIME type '${nativeMimeType}'. Anthropic Claude vision requires JPEG, PNG, WEBP, or GIF.`);
      }

      const byteLength = getBase64ByteLength(nativeBase64);
      if (byteLength > 3 * 1024 * 1024) {
        throw new Error(`Image size (${Math.round(byteLength / 1024)}KB) exceeds 3MB limit.`);
      }

      const content: any[] = [];
      if (includeMetadata) {
        const metaLines: string[] = [
          `📷 **视觉图像元数据** [${rawId}]`,
          `- 标题: ${title}`
        ];
        const details: string[] = [];
        if (takenAt) details.push(`记录时间: ${takenAt}`);
        if (locationStr) details.push(`位置: ${locationStr}`);
        details.push(`规格: 便签原图 (${Math.round(byteLength / 1024)} KB, ${nativeMimeType})`);
        metaLines.push(`- ${details.join(" | ")}`);
        content.push({ type: "text", text: metaLines.join("\n") });
      }

      content.push({
        type: "image",
        data: nativeBase64,
        mimeType: nativeMimeType
      });

      return { content };
    }

    // Branch B: Fetch from Cloudflare Images via signed URL
    if (!targetImageId) {
      throw new Error(`Image '${rawId}' not found or unauthorized.`);
    }

    const variants = await getSignedImageVariants(targetImageId, env, 7200);
    const fetchUrl = variants[variant as "ai512" | "ai768" | "ai1024"];
    if (!fetchUrl) {
      throw new Error(`Variant '${variant}' is not available.`);
    }

    // Guardrail: Fetch with strict Accept header (anti-AVIF), 8s timeout, 1 retry on network/5xx
    let response: Response | null = null;
    let lastError: any = null;

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        response = await fetch(fetchUrl, {
          method: "GET",
          headers: {
            "Accept": "image/jpeg,image/png,image/webp",
            "User-Agent": "Constancy-MCP/1.6.0"
          },
          signal: AbortSignal.timeout(8000)
        });

        if (response.ok) {
          break;
        }

        // 4xx client errors (e.g. 404 Not Found) - do not retry
        if (response.status >= 400 && response.status < 500) {
          break;
        }
      } catch (err: any) {
        lastError = err;
        if (attempt === 0) {
          await new Promise(resolve => setTimeout(resolve, 200));
        }
      }
    }

    if (!response) {
      throw new Error(`Failed to fetch image '${rawId}': ${lastError?.message || "Network timeout or connection error"}`);
    }

    if (!response.ok) {
      if (response.status === 404) {
        throw new Error(`Image '${rawId}' was not found on image storage (HTTP 404).`);
      }
      throw new Error(`Image delivery failed for '${rawId}': HTTP ${response.status} ${response.statusText}`);
    }

    // MIME type validation & AVIF defense
    const rawContentType = response.headers.get("content-type") || "";
    const mimeType = rawContentType.split(";")[0].trim().toLowerCase();

    if (mimeType === "image/avif") {
      throw new Error("Received unsupported AVIF format from image provider. Anthropic Claude vision requires JPEG, PNG, WEBP, or GIF.");
    }

    const allowedMimes = ["image/jpeg", "image/png", "image/webp", "image/gif"];
    if (!allowedMimes.includes(mimeType)) {
      throw new Error(`Unsupported image MIME type: '${mimeType}'. Supported formats are JPEG, PNG, WEBP, and GIF.`);
    }

    // Content length pre-check
    const contentLength = response.headers.get("content-length");
    if (contentLength && parseInt(contentLength, 10) > 3 * 1024 * 1024) {
      throw new Error(`Image size (${Math.round(parseInt(contentLength, 10) / 1024)}KB) exceeds 3MB limit. Please choose a smaller variant (e.g. 'ai512').`);
    }

    const arrayBuffer = await response.arrayBuffer();
    if (arrayBuffer.byteLength > 3 * 1024 * 1024) {
      throw new Error(`Image size (${Math.round(arrayBuffer.byteLength / 1024)}KB) exceeds 3MB limit. Please choose a smaller variant (e.g. 'ai512').`);
    }
    if (arrayBuffer.byteLength === 0) {
      throw new Error(`Fetched image is empty (0 bytes).`);
    }

    // Base64 encoding via helper
    const base64Data = arrayBufferToBase64(arrayBuffer);

    const content: any[] = [];
    if (includeMetadata) {
      const metaLines: string[] = [
        `📷 **视觉图像元数据** [${rawId}]`,
        `- 标题: ${title}`
      ];
      const details: string[] = [];
      if (takenAt) details.push(`拍摄时间: ${takenAt}`);
      if (locationStr) details.push(`位置: ${locationStr}`);
      details.push(`变体规格: ${variant} (${Math.round(arrayBuffer.byteLength / 1024)} KB, ${mimeType})`);
      metaLines.push(`- ${details.join(" | ")}`);
      content.push({ type: "text", text: metaLines.join("\n") });
    }

    content.push({
      type: "image",
      data: base64Data,
      mimeType: mimeType
    });

    return { content };
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

    // 🌟 FIX-1: Check if an image point already exists in images collection (True Upsert by image_id)
    const existingImgPoints = await findImagePointsByImageId(imageId, userId, env);
    const existingImgPoint = existingImgPoints[0] || null;
    const isUpdate = Boolean(existingImgPoint);
    const imagePointId = existingImgPoint ? existingImgPoint.id : crypto.randomUUID();

    // 🌟 FIX-2: Resilient tags parsing (array, JSON string, comma-separated) and inheritance
    const rawTags = args.tags ?? args.tag;
    let inputTags: string[] = [];
    if (Array.isArray(rawTags)) {
      inputTags = rawTags.map((t: any) => String(t).trim()).filter(Boolean);
    } else if (typeof rawTags === "string") {
      try {
        const parsed = JSON.parse(rawTags);
        if (Array.isArray(parsed)) {
          inputTags = parsed.map((t: any) => String(t).trim()).filter(Boolean);
        } else {
          inputTags = rawTags.split(/[,，\s]+/).map(t => t.trim()).filter(Boolean);
        }
      } catch {
        inputTags = rawTags.split(/[,，\s]+/).map(t => t.trim()).filter(Boolean);
      }
    }

    // If updating and no tags passed, inherit existing tags
    if (inputTags.length === 0 && existingImgPoint?.payload?.tags && Array.isArray(existingImgPoint.payload.tags)) {
      inputTags = existingImgPoint.payload.tags;
    }
    const tags = [...new Set([...inputTags, "image"])];

    const title = (args.title || "").trim() || (existingImgPoint?.payload?.title || (args.filename || "image.jpg").trim());
    const filename = (args.filename || "").trim() || existingImgPoint?.payload?.filename || "image.jpg";

    let location: { lat: number; lon: number } | null = null;
    if (typeof args.latitude === "number" && typeof args.longitude === "number") {
      location = { lat: args.latitude, lon: args.longitude };
    }
    const exif = args.exif && typeof args.exif === "object" ? { ...args.exif } : (existingImgPoint?.payload?.exif || null);
    if (!location && exif) {
      const eLat = exif.latitude ?? exif.lat;
      const eLon = exif.longitude ?? exif.lon;
      if (typeof eLat === "number" && typeof eLon === "number") {
        location = { lat: eLat, lon: eLon };
      }
    }
    if (!location && existingImgPoint?.payload?.location) {
      location = existingImgPoint.payload.location;
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
    if (!capturedAtIso && existingImgPoint?.payload?.captured_at) {
      capturedAtIso = existingImgPoint.payload.captured_at;
    }
    if (!capturedAtIso) {
      capturedAtIso = nowIso;
    }

    // Ensure exif.dateTime is canonical ISO format if exif is present
    if (exif && capturedAtIso) {
      exif.dateTime = capturedAtIso;
    }

    const createdAt = existingImgPoint?.payload?.created_at || nowIso;

    // Vectorize description with Voyage Multimodal 3.5 (1024-dim)
    const textToEmbed = title ? `${title}\n${description}\n${tags.join(" ")}` : `${description}\n${tags.join(" ")}`;
    const vector = await getEmbedding(textToEmbed, env, "document");

    // 1. Ingest into Qdrant 'images' collection (Upsert in place)
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
      created_at: createdAt,
      updated_at: nowIso,
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

    // Clean up any historical duplicate points in images collection
    if (existingImgPoints.length > 1) {
      const redundantIds = existingImgPoints.slice(1).map(p => p.id);
      await deleteImagePoints(redundantIds, env);
    }

    // 2. Ingest or update Note in 'constancy_memories' collection
    let notePointId: string | null = null;
    let revisionsCount = 0;
    let noteAction: "updated" | "created" | "skipped" = "skipped";

    const existingNote = await findNoteByImageId(imageId, userId, env);
    const noteTitle = title || `[视觉资产] ${description.slice(0, 24)}...`;
    const noteContent = `${description}\n\n[Cloudflare Images ID: ${imageId}]`;
    const noteTags = [...new Set(["image", "gallery", ...tags])];

    if (existingNote && existingNote.payload) {
      // 🌟 FIX A & B: 无论 create_note 取值为何，只要存在关联便签，必须强制同步，绝不留滞后孤岛！
      // 强制写入 revisions 审计链（最多保留最近 5 版），确保权威正文的每一次变动均有据可查。
      notePointId = existingNote.id;
      noteAction = "updated";

      const oldP = existingNote.payload;
      const oldContent = oldP.content || "";
      const oldTitle = oldP.title || "";
      const oldTags = Array.isArray(oldP.tags) ? oldP.tags : [];

      const contentChanged = oldContent !== noteContent;
      const titleChanged = oldTitle !== noteTitle;
      const tagsChanged = JSON.stringify(oldTags.slice().sort()) !== JSON.stringify(noteTags.slice().sort());

      const revisions: NoteRevision[] = Array.isArray(oldP.revisions) ? [...oldP.revisions] : [];

      if (contentChanged || titleChanged || tagsChanged) {
        const previousSnapshot: NoteRevision = {
          timestamp: nowIso,
          content: oldContent,
          title: oldTitle || undefined,
          tags: [...oldTags],
          mime_type: oldP.mime_type,
          sha256: oldP.sha256,
          reason: isUpdate ? "commit_image_record 视觉描述与元数据同步更新" : "commit_image_record 便签同步更新"
        };
        revisions.push(previousSnapshot);
        if (revisions.length > 5) {
          revisions.splice(0, revisions.length - 5);
        }
      }
      revisionsCount = revisions.length;

      // 认知动力学：若内容或标题发生实质变更，重新注入意图能量，激活半衰期
      let hSpectrum = oldP.h_spectrum || new Array(7).fill(0);
      let tLastStrong = oldP.t_last_strong || nowMs;
      if (contentChanged || titleChanged) {
        const decayedH = decaySpectrum(hSpectrum, oldP.t_last_update || nowMs, nowMs);
        hSpectrum = injectIntent(decayedH, 1.0);
        tLastStrong = nowMs;
      }

      const notePayloadUpdate: MemoryPointPayload = {
        ...oldP,
        title: noteTitle,
        content: noteContent,
        tags: noteTags,
        location: location || oldP.location || undefined,
        captured_at: capturedAtIso || oldP.captured_at || nowIso,
        created_at: oldP.created_at || oldP.timestamp || nowIso,
        updated_at: nowIso,
        timestamp: oldP.timestamp || nowIso,
        t_last_update: nowMs,
        t_last_strong: tLastStrong,
        h_spectrum: hSpectrum,
        image_id: imageId,
        revisions
      };

      await upsertMemoryPoint(notePointId, vector, notePayloadUpdate, env);
    } else if (args.create_note !== false) {
      // 若关联便签尚不存在，且用户未显式指定 create_note: false，则初次创建外脑便签
      notePointId = crypto.randomUUID();
      noteAction = "created";
      const notePayload: MemoryPointPayload = {
        user_id: userId,
        content: noteContent,
        timestamp: nowIso,
        created_at: nowIso,
        captured_at: capturedAtIso || nowIso,
        location: location || undefined,
        date: capturedAtIso ? capturedAtIso.slice(0, 10) : todayStr,
        type: "note",
        entities: [],
        tags: noteTags,
        ch_prior: 11.0, // High constancy for assets
        h_spectrum: injectIntent(new Array(7).fill(0), 1.0),
        t_last_update: nowMs,
        t_last_strong: nowMs,
        title: noteTitle,
        image_id: imageId,
        mime_type: "image/jpeg",
        revisions: []
      };
      await upsertMemoryPoint(notePointId, vector, notePayload, env);
    }

    let noteMessageDetail = "";
    if (noteAction === "updated") {
      noteMessageDetail = `已同步更新关联外脑便签 [${notePointId}] (历史版本数: ${revisionsCount})`;
    } else if (noteAction === "created") {
      noteMessageDetail = `已同步新建外脑便签 [${notePointId}]`;
    } else {
      noteMessageDetail = "未创建外脑便签 (create_note=false 且无既有便签)";
    }

    return {
      success: true,
      image_id: imageId,
      point_id: imagePointId,
      is_update: isUpdate,
      note_id: notePointId,
      revisions_count: revisionsCount,
      title: title || filename,
      tags,
      message: `🖼️ 视觉资产成功${isUpdate ? "更新 (原地 Update)" : "入库"}！${noteMessageDetail}。`
    };
  }

  // 15. Tool: annotate_memory
  if (name === "annotate_memory") {
    const rawId = (args.id || "").trim();
    if (!rawId) throw new Error("Missing id");
    const kind = (args.kind || "").trim().toLowerCase() as AnnotationKind;
    if (!["correction", "dispute", "context"].includes(kind)) {
      throw new Error(`Invalid kind: '${kind}'. Must be one of: 'correction', 'dispute', 'context'`);
    }
    const text = (args.text || "").trim();
    if (!text) throw new Error("Missing text");

    const rawSource = String(args.source || "user_stated").toLowerCase().trim();
    const source: MemorySourceType = (["user_stated", "model_inferred", "external"].includes(rawSource) ? rawSource : "user_stated") as MemorySourceType;
    const refId = typeof args.ref_id === "string" ? args.ref_id.trim() : undefined;

    const resolved = await resolveTargetMemoryPoint(rawId, userId, env);
    if (!resolved || !resolved.payload || resolved.payload.user_id !== userId) {
      throw new Error(`Memory point or associated image '${rawId}' not found or unauthorized.`);
    }
    const pointId = resolved.pointId;

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

    const entityLabel = resolved.isLinkedFromImage ? `图片 [${rawId}] 关联便签 [${pointId}]` : `记忆 '${pointId}'`;

    return {
      success: true,
      id: pointId,
      target_id: rawId,
      annotation_id: annotationId,
      kind,
      kind_label: kindEmojiMap[kind],
      source,
      source_badge: getSourceBadge(source),
      total_annotations: updatedPayload.annotations?.length || 1,
      message: `📌 已成功向${entityLabel}追加不可变附注 [类型: ${kindEmojiMap[kind]}, 来源: ${getSourceBadge(source)}]。原文一字不动，保留因果可证伪性；后续检索将并置展示更正警示。`
    };
  }

  // 16. Tool: submit_concern
  if (name === "submit_concern") {
    const rawMemoryId = (args.memory_id || "").trim();
    const reason = (args.reason || "").trim();
    const evidence = (args.evidence || "").trim();
    const severity: ConcernSeverity = args.severity || "medium";
    const interactionMode: InteractionMode = args.interaction_mode || "silent";

    if (!rawMemoryId) throw new Error("Missing required argument: memory_id");
    if (!reason) throw new Error("Missing required argument: reason");
    if (!evidence) throw new Error("Missing required argument: evidence (现实证据链必须包含用户近期原话引言)");

    // Target memory validation with polymorphic image resolution
    const resolved = await resolveTargetMemoryPoint(rawMemoryId, userId, env);
    if (!resolved || !resolved.payload || resolved.payload.user_id !== userId) {
      throw new Error(`目标记忆点或关联图片 '${rawMemoryId}' 未找到，请核实 ID 是否准确。`);
    }
    const memoryId = resolved.pointId;

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
    // 1. Normalize caseId and memoryId with polymorphic fallbacks
    let rawCaseId = (args.case_id || args.caseId || args.id || "").toString().trim();
    let rawMemoryId = (args.memory_id || args.memoryId || args.target_id || args.target_memory_id || "").toString().trim();

    if (!rawMemoryId && rawCaseId) {
      if (rawCaseId.toUpperCase().startsWith("CASE-")) {
        rawMemoryId = rawCaseId.slice(5).trim();
      } else {
        rawMemoryId = rawCaseId;
      }
    }
    if (!rawCaseId && rawMemoryId) {
      rawCaseId = rawMemoryId.toUpperCase().startsWith("CASE-")
        ? rawMemoryId.toUpperCase()
        : `CASE-${rawMemoryId.slice(0, 8).toUpperCase()}`;
    }

    if (!rawCaseId && !rawMemoryId) {
      throw new Error("Missing required argument: case_id or memory_id");
    }

    // 2. Normalize verdict (case-insensitive + synonyms)
    const rawVerdict = (args.verdict || "").toString().trim().toUpperCase();
    let verdict: DoctorVerdict;
    if (rawVerdict === "RESOLVED" || rawVerdict === "CLOSED" || rawVerdict === "FIXED" || rawVerdict === "RESOLVE") {
      verdict = "RESOLVED";
    } else if (rawVerdict === "DEFERRED" || rawVerdict === "OBSERVE" || rawVerdict === "WAIT" || rawVerdict === "DEFER") {
      verdict = "DEFERRED";
    } else if (rawVerdict === "ESCALATED_TO_USER" || rawVerdict === "ESCALATE" || rawVerdict === "USER" || rawVerdict === "CONSULT") {
      verdict = "ESCALATED_TO_USER";
    } else {
      throw new Error(`Invalid or missing verdict: '${args.verdict}'. Expected RESOLVED | DEFERRED | ESCALATED_TO_USER.`);
    }

    // 3. Normalize treatment (case-insensitive + synonyms)
    const rawTreatment = (args.treatment || "").toString().trim().toUpperCase();
    let treatment: DoctorTreatment | undefined = undefined;
    if (rawTreatment === "KEEP" || rawTreatment === "MAINTAIN" || rawTreatment === "VALID") {
      treatment = "KEEP";
    } else if (rawTreatment === "UPDATE" || rawTreatment === "MODIFY" || rawTreatment === "CORRECT" || rawTreatment === "EDIT") {
      treatment = "UPDATE";
    } else if (rawTreatment === "EXPIRE" || rawTreatment === "DELETE" || rawTreatment === "RETIRE" || rawTreatment === "ARCHIVE") {
      treatment = "EXPIRE";
    } else if (rawTreatment === "MERGE" || rawTreatment === "COMBINE" || rawTreatment === "DEDUPLICATE") {
      treatment = "MERGE";
    }

    // 4. Elastic content and doctor notes extraction
    const updatedContent = (
      args.updated_content ||
      args.updatedContent ||
      args.content ||
      args.new_content ||
      args.revised_content ||
      args.treatment_content ||
      args.correction ||
      ""
    ).toString().trim();

    const doctorNotes = (
      args.doctor_notes ||
      args.doctorNotes ||
      args.notes ||
      args.reason ||
      args.summary ||
      args.comment ||
      "处方已执行留档"
    ).toString().trim();

    if (verdict === "RESOLVED" && !treatment) {
      if (updatedContent) {
        treatment = "UPDATE";
      } else if (/失效|删除|废弃|退役|下线|清理|过期|垃圾/i.test(doctorNotes)) {
        treatment = "EXPIRE";
      } else {
        treatment = "KEEP";
      }
    }

    if (verdict === "RESOLVED" && treatment === "UPDATE" && !updatedContent) {
      throw new Error("当 treatment 为 UPDATE 时，必须提供 updated_content (修正后的精确记忆文本)");
    }

    // 5. Target memory resolution
    let targetPoint = await resolveTargetMemoryPoint(rawMemoryId, userId, env);
    let memoryId = targetPoint ? targetPoint.pointId : rawMemoryId;

    // Direct UUID fallback
    if (!targetPoint) {
      const isUuid = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(rawMemoryId);
      if (isUuid) {
        const direct = await getPointById(rawMemoryId, env);
        if (direct && direct.payload) {
          if (direct.payload.user_id === userId) {
            targetPoint = { pointId: rawMemoryId, payload: direct.payload };
            memoryId = rawMemoryId;
          } else {
            throw new Error("权限校验失败：您无权修改其他用户的记忆点。");
          }
        }
      }
    }

    const nowIso = new Date().toISOString();
    const nowMs = Date.now();
    let actionDetails = "";
    let resultingNewMemoryId: string | undefined = undefined;

    // 6. Handle target memory update / recreation / phantom handling
    if (!targetPoint || !targetPoint.payload) {
      // Memory point does not exist in constancy_memories (already deleted/purged)
      if (verdict === "RESOLVED") {
        if (treatment === "UPDATE" && updatedContent) {
          const newMemoryId = crypto.randomUUID();
          resultingNewMemoryId = newMemoryId;
          const newVector = await getEmbedding(updatedContent, env, "document");
          const initialH = injectIntent(new Array(7).fill(0), 1.0);
          const newPayload: MemoryPointPayload = {
            user_id: userId,
            content: updatedContent,
            timestamp: nowIso,
            date: nowIso.slice(0, 10),
            type: "insight",
            entities: [],
            tags: [],
            source: "model_inferred",
            ch_prior: 9.0,
            h_spectrum: initialH,
            t_last_update: nowMs,
            t_last_strong: nowMs,
            status: "active"
          };
          await upsertMemoryPoint(newMemoryId, newVector, newPayload, env);
          actionDetails = `原目标记忆点在库中不存在或已被清理，已为您直接重新录入健康记忆 [${newMemoryId}]。`;
        } else {
          actionDetails = `目标记忆在库中已不存在或已下线，已自动完成对应案卷与顾虑的销案归档。`;
        }
      } else if (verdict === "DEFERRED") {
        actionDetails = `目标记忆在库中未找到，案卷已标记留观。`;
      } else if (verdict === "ESCALATED_TO_USER") {
        actionDetails = `目标记忆在库中未找到，案卷已转交用户裁决。`;
      }
    } else {
      // Target memory exists
      const oldPayload = targetPoint.payload;
      if (oldPayload.user_id && oldPayload.user_id !== userId) {
        throw new Error("权限校验失败：您无权修改其他用户的记忆点。");
      }

      if (verdict === "RESOLVED") {
        if (treatment === "UPDATE") {
          // Create Superseded Lineage:
          // a. Old memory marks expired + superseded_by newId + appends annotation
          const newMemoryId = crypto.randomUUID();
          resultingNewMemoryId = newMemoryId;
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
            annotations: currentAnnotations
          }, env);

          // b. Insert new memory point with predecessor link and lineage inheritance
          const newVector = await getEmbedding(updatedContent, env, "document");

          // 1. Inherit thermal spectrum with decay & intent injection (BUG-1 fix)
          const baseH = (Array.isArray(oldPayload.h_spectrum) && oldPayload.h_spectrum.length === 7)
            ? oldPayload.h_spectrum
            : (oldPayload.type === "entity" ? new Array(7).fill(1.5) : new Array(7).fill(0));
          const decayedH = decaySpectrum(baseH, oldPayload.t_last_update || nowMs, nowMs);
          const nextH = injectIntent(decayedH, 1.0);

          // 2. Revisions audit trail preservation (BUG-3 fix)
          const revisions: NoteRevision[] = Array.isArray(oldPayload.revisions) ? [...oldPayload.revisions] : [];
          if (oldPayload.content !== updatedContent) {
            revisions.unshift({
              timestamp: nowIso,
              content: oldPayload.content,
              title: oldPayload.title,
              entity_name: oldPayload.entity_name,
              aliases: oldPayload.aliases,
              relations: oldPayload.relations,
              tags: oldPayload.tags,
              reason: `[医生更新] ${doctorNotes}`
            });
            if (revisions.length > 5) {
              revisions.length = 5;
            }
          }

          // 3. Epistemic provenance preservation (BUG-2 fix)
          const inheritedSource: MemorySourceType = oldPayload.source || "user_stated";

          const newPayload: MemoryPointPayload = {
            user_id: oldPayload.user_id || userId,
            content: updatedContent,
            title: oldPayload.title,
            timestamp: nowIso,
            created_at: oldPayload.created_at || oldPayload.timestamp || nowIso,
            updated_at: nowIso,
            date: nowIso.slice(0, 10),
            type: oldPayload.type || "insight",
            entity_name: oldPayload.entity_name || undefined,
            aliases: oldPayload.aliases || undefined,
            relations: oldPayload.relations || undefined,
            entities: (oldPayload.entities && oldPayload.entities.length > 0)
              ? oldPayload.entities
              : (oldPayload.entity_name ? [oldPayload.entity_name, ...(oldPayload.aliases || [])] : []),
            tags: oldPayload.tags || [],
            source: inheritedSource,
            ch_prior: oldPayload.ch_prior ?? (oldPayload.type === "entity" ? 11.5 : 9.0),
            h_spectrum: nextH,
            t_last_update: nowMs,
            t_last_strong: nowMs,
            status: "active",
            predecessor: memoryId,
            image_id: oldPayload.image_id || undefined,
            location: oldPayload.location || undefined,
            revisions: revisions.length > 0 ? revisions : undefined
          };
          await upsertMemoryPoint(newMemoryId, newVector, newPayload, env);
          actionDetails = `已将旧记忆标记退役（指向后继 ${newMemoryId}），并成功写入世代更迭后的健康记忆（继承常度与热度谱，保留来源标签 [${inheritedSource}]）。`;

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
            annotations: currentAnnotations
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
            annotations: currentAnnotations
          }, env);
          actionDetails = `复核确认记忆准确健康，清空存疑计数，维持原状。`;

        } else if (treatment === "MERGE") {
          const mergeWithIds: string[] = Array.isArray(args.merge_with_ids) ? args.merge_with_ids : [];
          let retiredCount = 0;
          for (const mId of mergeWithIds) {
            if (!mId || mId === memoryId) continue;
            const resolvedM = await resolveTargetMemoryPoint(mId, userId, env);
            const actualMId = resolvedM ? resolvedM.pointId : mId;
            const mPoint = await getPointById(actualMId, env);
            if (mPoint && mPoint.payload && (!mPoint.payload.user_id || mPoint.payload.user_id === userId)) {
              const mAnnotations = Array.isArray(mPoint.payload.annotations) ? [...mPoint.payload.annotations] : [];
              mAnnotations.push({
                id: crypto.randomUUID(),
                timestamp: nowIso,
                kind: "correction",
                text: `【🩺 医生临床处方】归并退役：已合并入主记忆 [${memoryId}]。理由: ${doctorNotes}`,
                source: "model_inferred"
              });
              await setPointPayload(actualMId, {
                status: "expired",
                retired: true,
                retired_at: nowIso,
                retired_reason: `归并入主记忆 [${memoryId}]`,
                superseded_by: memoryId,
                annotations: mAnnotations
              }, env);
              retiredCount++;
            }
          }

          let newContent = oldPayload.content;
          const baseH = (Array.isArray(oldPayload.h_spectrum) && oldPayload.h_spectrum.length === 7)
            ? oldPayload.h_spectrum
            : (oldPayload.type === "entity" ? new Array(7).fill(1.5) : new Array(7).fill(0));
          const decayedH = decaySpectrum(baseH, oldPayload.t_last_update || nowMs, nowMs);

          if (updatedContent) {
            newContent = updatedContent;
            const newVector = await getEmbedding(updatedContent, env, "document");
            const nextH = injectIntent(decayedH, 1.0);

            const revisions: NoteRevision[] = Array.isArray(oldPayload.revisions) ? [...oldPayload.revisions] : [];
            if (oldPayload.content !== newContent) {
              revisions.unshift({
                timestamp: nowIso,
                content: oldPayload.content,
                title: oldPayload.title,
                entity_name: oldPayload.entity_name,
                aliases: oldPayload.aliases,
                relations: oldPayload.relations,
                tags: oldPayload.tags,
                reason: `[医生归并更新] ${doctorNotes}`
              });
              if (revisions.length > 5) revisions.length = 5;
            }

            await upsertMemoryPoint(memoryId, newVector, {
              ...oldPayload,
              content: newContent,
              status: "active",
              suspicion_count: 0,
              h_spectrum: nextH,
              t_last_update: nowMs,
              t_last_strong: nowMs,
              revisions: revisions.length > 0 ? revisions : undefined
            }, env);
          } else {
            const nextH = injectIntent(decayedH, 0.5);
            await setPointPayload(memoryId, {
              status: "active",
              suspicion_count: 0,
              h_spectrum: nextH,
              t_last_update: nowMs,
              t_last_strong: nowMs
            }, env);
          }

          const annotation: MemoryAnnotation = {
            id: crypto.randomUUID(),
            timestamp: nowIso,
            kind: "context",
            text: `【🩺 医生临床处方】归并精简：已合并吸收 ${retiredCount} 条同构碎片。理由: ${doctorNotes}`,
            source: "model_inferred"
          };
          await appendMemoryAnnotation(memoryId, annotation, env);

          actionDetails = `已成功将 ${retiredCount} 条同构碎片归并至主记忆 [${memoryId}]，消除认知冗余与重复。`;
        }
      } else if (verdict === "DEFERRED") {
        const deferCount = (oldPayload.defer_count || 0) + 1;
        const suspicionCount = (oldPayload.suspicion_count || 0) + 1;
        await setPointPayload(memoryId, {
          defer_count: deferCount,
          suspicion_count: suspicionCount
        }, env);
        actionDetails = `证据不足，已登记留观跟踪 (累计留观 ${deferCount} 次)，避免草率动刀。`;
      } else if (verdict === "ESCALATED_TO_USER") {
        await setPointPayload(memoryId, {
          pending_user_confirmation: true
        }, env);
        actionDetails = `案情重大且存疑，已将案卷转送至后花园控制台，等待用户主权裁决。`;
      }
    }

    // 7. Update Qdrant concerns collection
    const updatedCount = await updateCaseConcerns(userId, memoryId, rawCaseId, verdict, treatment, doctorNotes, env);

    return {
      success: true,
      case_id: rawCaseId,
      memory_id: memoryId,
      new_memory_id: resultingNewMemoryId,
      verdict,
      treatment: treatment || null,
      concerns_closed: updatedCount,
      action_details: actionDetails,
      doctor_notes: doctorNotes,
      message: `🩺 案卷 ${rawCaseId} 临床处方已成功下达并留档执行。`
    };
  }

  // 17. Tool: inspect_memory (Genealogy & Thermal Provenance Deep Inspection)
  if (name === "inspect_memory") {
    const rawTargetId = String(args.id || "").trim();
    if (!rawTargetId) {
      throw new Error("Missing required argument: id");
    }

    const maxDepth = Math.min(Math.max(Number(args.max_depth) || 5, 1), 10);

    // 1. Resolve target memory point polymorphically (supports UUID, CASE- prefix, image_id)
    const resolved = await resolveTargetMemoryPoint(rawTargetId, userId, env);
    if (!resolved || !resolved.payload) {
      throw new Error(`记忆点或关联资产 '${rawTargetId}' 未找到或无权访问。`);
    }

    const targetPointId = resolved.pointId;
    const targetPayload = resolved.payload;

    // Helper to compute node metrics without modifying database
    const computeNodeMetrics = (p: MemoryPointPayload) => {
      const decayedH = decaySpectrum(p.h_spectrum || new Array(7).fill(0), p.t_last_update || nowMs, nowMs);
      const chPrior = p.ch_prior ?? (p.type === "entity" ? 11.5 : 9.0);
      const chDynamic = computeDynamicCh(chPrior, decayedH);
      const resonantHeat = interpolateResonantHeat(decayedH, chDynamic);
      const V = computeEpistemicHealth(chDynamic, resonantHeat, p.t_last_strong || nowMs, nowMs);
      const classification = classifyHealth(V, p.tags || [], p.type || "", Boolean(p.retired), p.retired_reason || "", p.annotations);

      return {
        decayedH,
        chPrior,
        chDynamic,
        resonantHeat: Number(resonantHeat.toFixed(2)),
        validity: V,
        classification
      };
    };

    // 2. Trace upstream ancestors (predecessors)
    const ancestors: Array<{ id: string; payload: MemoryPointPayload }> = [];
    const visitedIds = new Set<string>([targetPointId]);
    let currPred = targetPayload.predecessor;

    while (currPred && ancestors.length < maxDepth) {
      if (visitedIds.has(currPred)) break; // cycle protection
      visitedIds.add(currPred);

      const parentPoint = await getPointById(currPred, env);
      if (!parentPoint || !parentPoint.payload || (parentPoint.payload.user_id && parentPoint.payload.user_id !== userId)) {
        break; // stop at unauthorized or missing boundary
      }

      ancestors.unshift({ id: currPred, payload: parentPoint.payload });
      currPred = parentPoint.payload.predecessor;
    }

    // 3. Trace downstream descendants (successors)
    const descendants: Array<{ id: string; payload: MemoryPointPayload }> = [];
    let currSucc = targetPayload.superseded_by;

    while (currSucc && descendants.length < maxDepth) {
      if (visitedIds.has(currSucc)) break; // cycle protection
      visitedIds.add(currSucc);

      const childPoint = await getPointById(currSucc, env);
      if (!childPoint || !childPoint.payload || (childPoint.payload.user_id && childPoint.payload.user_id !== userId)) {
        break; // stop at unauthorized or missing boundary
      }

      descendants.push({ id: currSucc, payload: childPoint.payload });
      currSucc = childPoint.payload.superseded_by;
    }

    // 4. Assemble full chronological lineage
    const fullChain = [
      ...ancestors,
      { id: targetPointId, payload: targetPayload },
      ...descendants
    ];

    const targetGenIndex = ancestors.length + 1;
    const totalGens = fullChain.length;

    const lineageSummaries: LineageNodeSummary[] = fullChain.map((node, idx) => {
      const p = node.payload;
      const metrics = computeNodeMetrics(p);
      const isTarget = node.id === targetPointId;

      return {
        generation: idx + 1,
        is_current_target: isTarget,
        id: node.id,
        created_at: p.created_at || p.timestamp,
        updated_at: p.updated_at,
        type: p.type,
        status: p.status || (p.retired ? "expired" : "active"),
        retired: Boolean(p.retired),
        retired_reason: p.retired_reason,
        source: p.source,
        source_badge: getSourceBadge(p.source),
        ch_prior: metrics.chPrior,
        ch_dynamic: metrics.chDynamic,
        resonant_heat: metrics.resonantHeat,
        h_spectrum_stored: p.h_spectrum || new Array(7).fill(0),
        h_spectrum_decayed: metrics.decayedH,
        content_snippet: p.content.length > 150 ? `${p.content.slice(0, 150)}...` : p.content,
        entity_name: p.entity_name,
        aliases: p.aliases,
        relations: p.relations,
        revisions_count: Array.isArray(p.revisions) ? p.revisions.length : 0,
        annotations_count: Array.isArray(p.annotations) ? p.annotations.length : 0,
        predecessor: p.predecessor,
        superseded_by: p.superseded_by
      };
    });

    // 5. Target node full metrics & payload details
    const targetMetrics = computeNodeMetrics(targetPayload);

    const result: InspectMemoryResult = {
      success: true,
      version: CONSTANCY_VERSION,
      target_id: targetPointId,
      target_details: {
        id: targetPointId,
        user_id: targetPayload.user_id,
        content: targetPayload.content,
        title: targetPayload.title,
        type: targetPayload.type,
        status: targetPayload.status || (targetPayload.retired ? "expired" : "active"),
        retired: Boolean(targetPayload.retired),
        retired_at: targetPayload.retired_at,
        retired_reason: targetPayload.retired_reason,
        source: targetPayload.source,
        source_badge: getSourceBadge(targetPayload.source),
        ch_prior: targetMetrics.chPrior,
        ch_dynamic: targetMetrics.chDynamic,
        resonant_heat: targetMetrics.resonantHeat,
        h_spectrum: targetPayload.h_spectrum || new Array(7).fill(0),
        h_spectrum_stored: targetPayload.h_spectrum || new Array(7).fill(0),
        h_spectrum_decayed: targetMetrics.decayedH,
        validity: targetMetrics.validity,
        health_status: targetMetrics.classification.status,
        health_badge: targetMetrics.classification.badge,
        created_at: targetPayload.created_at || targetPayload.timestamp,
        updated_at: targetPayload.updated_at,
        entity_name: targetPayload.entity_name,
        aliases: targetPayload.aliases,
        relations: targetPayload.relations,
        entities: targetPayload.entities,
        tags: targetPayload.tags,
        revisions: targetPayload.revisions,
        revisions_count: Array.isArray(targetPayload.revisions) ? targetPayload.revisions.length : 0,
        annotations: targetPayload.annotations,
        annotations_count: Array.isArray(targetPayload.annotations) ? targetPayload.annotations.length : 0,
        predecessor: targetPayload.predecessor,
        superseded_by: targetPayload.superseded_by,
        image_id: targetPayload.image_id,
        has_base64: Boolean(targetPayload.base64),
        base64_length: targetPayload.base64 ? targetPayload.base64.length : undefined,
        sha256: targetPayload.sha256,
        mime_type: targetPayload.mime_type,
        defer_count: targetPayload.defer_count,
        suspicion_count: targetPayload.suspicion_count,
        pending_user_confirmation: targetPayload.pending_user_confirmation
      },
      genealogy: {
        root_id: fullChain[0].id,
        latest_active_id: fullChain[fullChain.length - 1].id,
        target_generation: targetGenIndex,
        total_generations: totalGens,
        lineage_chain: lineageSummaries
      },
      message: `🔬 记忆点 [${targetPointId}] 诊断完成：处于因果演化链第 ${targetGenIndex}/${totalGens} 世代（当前状态: ${targetPayload.status || (targetPayload.retired ? "expired" : "active")}，来源: ${getSourceBadge(targetPayload.source)}，动态常度: ${targetMetrics.chDynamic}）。`
    };

    return result;
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
          },
          prompts: {
            listChanged: false
          }
        },
        serverInfo: {
          name: "constancy-mcp",
          version: CONSTANCY_VERSION,
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

      // Multi-part content transparent pass-through (e.g. fetch_image_vision)
      if (output && Array.isArray(output.content)) {
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: output.content,
            ...(output.isError ? { isError: true } : {})
          }
        };
      }

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
        result: {
          content: [
            {
              type: "text",
              text: `[v${CONSTANCY_VERSION}] Error executing ${name}: ${err.message}`
            }
          ],
          isError: true
        }
      };
    }
  }

  // 6. prompts/list
  if (method === "prompts/list") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        prompts: [
          {
            name: "constancy_agent_init",
            description: "【初始化引导】获取当前 Constancy 记忆系统的 Agent 工作法与行为准则",
            arguments: [
              {
                name: "role",
                description: "Agent 角色：'chat'(前线会话，默认)、'doctor'(专职巡诊医生)、'all'(全景规约)",
                required: false
              },
              {
                name: "verbosity",
                description: "详略度：'compact'(紧凑摘要，默认)、'detailed'(详尽规范)",
                required: false
              }
            ]
          }
        ]
      }
    };
  }

  // 7. prompts/get
  if (method === "prompts/get") {
    const promptName = params?.name;
    if (promptName !== "constancy_agent_init") {
      return {
        jsonrpc: "2.0",
        id,
        error: {
          code: -32602,
          message: `Unknown prompt: ${promptName}`
        }
      };
    }
    const pArgs = params?.arguments || {};
    const role = (pArgs.role || "chat").toLowerCase().trim();
    const verbosity = (pArgs.verbosity || "compact").toLowerCase().trim();
    const guideContent = generateAgentInitInfo(role, verbosity, userId, env.DOMAIN || "mcp.kufof.uk");
    return {
      jsonrpc: "2.0",
      id,
      result: {
        description: `Constancy Agent 指南 (${role}, ${verbosity})`,
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: guideContent.system_instructions
            }
          }
        ]
      }
    };
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
