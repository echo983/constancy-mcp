# Constancy 认知卫生医生规范 (Cognitive Hygiene Doctor Specification)
## 个人 AI 长期记忆的低熵维持与临床诊治体系 v1.0

> **核心哲学**：不维护全量记忆库，只维护被现实摩擦暴露出来的异常。  
> **角色隐喻**：前线会话感知病症，私域分诊台候诊排期，专职医生临床开方，后花园人机协同会诊。  
> **数据主权**：私域语义数据严禁上云（不落 Cloudflare D1/KV），全部持久化于用户自有私域存储 (`vec.kufof.uk`)。

---

## 1. 角色架构与职责边界 (Role Matrix)

```
┌─────────────────────────────────────────────────────────────┐
│ 1. 门诊主诉端：日常会话 LLM (Claude / Client Sessions)       │
│    - 角色：认知卫生前线感知触角                               │
│    - 契约：法定义务上报认知异常（冲突、过期、伪造、存疑）        │
│    - 姿态：静默提交 (silent) / 顺带告知 (informed) / 求证后再报 │
│    - 权限：🟢 仅拥有 submit_concern 工具（严禁越权处方）     │
└──────────────────────────────┬──────────────────────────────┘
                               │ submit_concern()
                               ▼
┌─────────────────────────────────────────────────────────────┐
│ 2. 私域分诊台：Qdrant constancy_concerns (@ vec.kufof.uk)    │
│    - 角色：无锁轻量候诊队列与自动分诊水位调度器                │
│    - 排期规则：                                             │
│      * 高危 (High) / 经求证 (user_confirmed)：等待 ≤ 1 小时   │
│      * 中危 (Medium)：等待 ≤ 6 小时 或 duplicate_count ≥ 2   │
│      * 低危 (Low)：等待 ≤ 24 小时 或 每日零点批处理            │
│      * 留观复查 (Deferred)：超 48h 且有新证据自动激活          │
│    - 保姆级行政：自动完成去重、聚簇并推给医生，医生零时间计算 │
└──────────────────────────────┬──────────────────────────────┘
                               │ get_maintenance_cases()
                               ▼
┌─────────────────────────────────────────────────────────────┐
│ 3. 专职医生端：巡诊医生 (Claude Scheduled Task, 每小时唤醒)    │
│    - 角色：认知健康临床医师                                   │
│    - 专职工具：🩺 get_maintenance_cases, resolve_case       │
│    - 诊断流程：                                             │
│      * 无待办案卷：秒级确认“肌体健康”，0 Token 收工          │
│      * 有待办案卷：调阅旧病历与新引言证据链，研判病理          │
│      * 开具临床处方 (Verdict)：                              │
│        - RESOLVED (确诊处置)：KEEP / UPDATE / EXPIRE / MERGE │
│        - DEFERRED (留观跟踪)：证据不足，保留观察，防草率开刀 │
│        - ESCALATED_TO_USER (请患者会诊)：疑难重症转后花园     │
└──────────────────────────────┬──────────────────────────────┘
                               │ resolve_maintenance_case()
                               ▼
┌─────────────────────────────────────────────────────────────┐
│ 4. 患者主权端：后花园控制台 (Constancy Back Garden UI)        │
│    - 呈现「认知体检卡片」：仅展示 ESCALATED_TO_USER 疑难案卷   │
│    - 用户一键点选裁决，或查看认知代谢谱系与不可变审计日志      │
└─────────────────────────────────────────────────────────────┘
```

---

## 2. 数据结构与私域存储设计 (`constancy_concerns`)

所有语义数据完全保存在自建私域 Qdrant 服务中，集合名称：`constancy_concerns`。

### 2.1 顾虑候诊点 Payload 契约
```typescript
export interface CognitiveConcernPayload {
  id: string;                      // 顾虑唯一标识 (UUID)
  user_id: string;                 // 用户归属
  memory_id: string;               // 关联的目标记忆 UUID (或 MID)
  reason: string;                  // 存疑/冲突原因简述
  evidence: string;                // 现实证据链（必须包含用户近期原话引言）
  severity: "high" | "medium" | "low"; // 严重级别
  interaction_mode: "silent" | "informed_user" | "user_confirmed";
  status: "pending" | "investigating" | "resolved" | "deferred" | "escalated_to_user";
  created_at: string;              // ISO 8601 UTC
  updated_at: string;              // ISO 8601 UTC
  duplicate_count: number;         // 相同记忆被举报次数（自动叠加）
  defer_count: number;             // 被医生判定留观的累计次数
  doctor_case_id?: string;         // 绑定的病案号
}
```

### 2.2 分诊水位算法 (Triage Level Calculus)
后台在处理 `get_maintenance_cases` 时，根据当前服务器时间 $t_{\text{now}}$ 进行无状态过滤：
1. **高危通道 (Immediate / $\le 1\text{h}$)**:
   - `severity === "high"` 或 `interaction_mode === "user_confirmed"` 或 `duplicate_count >= 3`
   - 只要状态为 `pending`，每小时巡诊必然出列。
2. **中危通道 (Triage-6h / $\le 6\text{h}$)**:
   - `severity === "medium"`
   - 触发条件：$t_{\text{now}} - t_{\text{created}} \ge 6\text{ 小时}$，或 `duplicate_count >= 2`，或当前整点为 $[0, 6, 12, 18]$。
3. **低危通道 (Triage-24h / $\le 24\text{h}$)**:
   - `severity === "low"`
   - 触发条件：$t_{\text{now}} - t_{\text{created}} \ge 24\text{ 小时}$，或当前整点为 $04:00\text{ (每日拂晓批处理)}$。
4. **留观复诊通道 (Deferred Review)**:
   - `status === "deferred"` 且距上次留观时间 $\ge 48\text{ 小时}$，或期间有新的 `submit_concern` 证据追加。

---

## 3. MCP 接口规范与权限隔离

### 3.1 门诊主诉工具：`submit_concern` (公共工具)
* **权限**：所有正常对话实例通用。
* **输入契约**：
  - `memory_id` (string): 目标记忆 ID。
  - `reason` (string): 简明扼要陈述矛盾点。
  - `evidence` (string): 必须包含当前会话中用户的原话，禁止主观推测。
  - `severity` ("high" | "medium" | "low"): 严重程度。
  - `interaction_mode` ("silent" | "informed_user" | "user_confirmed"): 交互姿态。

### 3.2 巡诊医生专职工具：`get_maintenance_cases` (🩺 医生专用)
* **权限声明**：`【🩺 医生专用 - 严禁普通会话调用】`
* **功能**：拉取当前时钟周期已达到分诊水位的候诊案卷。
* **参数**：`limit` (number, 默认 5)。
* **输出**：
  ```json
  {
    "has_cases": true,
    "case_count": 1,
    "cases": [
      {
        "case_id": "CASE-uuid-xxxx",
        "target_memory": {
          "id": "target-uuid",
          "content": "用户现居住于北京市朝阳区",
          "c_h": 9.8,
          "created_at": "2025-10-12T10:00:00Z",
          "annotations": []
        },
        "concerns": [
          {
            "id": "concern-uuid-1",
            "reason": "居住地可能已变更为上海",
            "evidence": "用户原话：我上个月搬到上海陆家嘴常住了",
            "severity": "high",
            "interaction_mode": "silent",
            "created_at": "2026-09-12T14:30:00Z"
          }
        ],
        "triage_reason": "高危即时到期 (high severity)",
        "diagnostic_hint": "重点研判用户是否已发生长期定居地迁移"
      }
    ]
  }
  ```

### 3.3 临床处方工具：`resolve_maintenance_case` (🩺 医生专用)
* **权限声明**：`【🩺 医生专用 - 严禁普通会话调用】`
* **功能**：医生依据事实链给出病理诊断与处方，系统自动执行私域变更与不可变审计落盘。
* **参数**：
  - `case_id` (string): 案卷编号。
  - `verdict` ("RESOLVED" | "DEFERRED" | "ESCALATED_TO_USER"): 仲裁结论。
  - `treatment` ("KEEP" | "UPDATE" | "EXPIRE" | "MERGE"): 处置动作 (当 verdict 为 RESOLVED 时)。
  - `updated_content` (string): 修正后的记忆纯文本 (当 action 为 UPDATE 时)。
  - `doctor_notes` (string): 医生病历诊断记录（说明诊断理由、证据采信推导过程）。
* **底层执行效果**：
  - **`UPDATE`**：旧记忆不涂抹，标记 `status: "expired"` + `superseded_by: newId` 并追加勘误注记；创建新记忆，标记 `predecessor: oldId`。
  - **`EXPIRE`**：旧记忆标记 `status: "expired"`，记录下线原因。
  - **`KEEP`**：旧记忆保持活跃，清空存疑计数。
  - **`DEFERRED`**：将记忆打上 `defer_count: +1`，等待未来证据。
  - **`ESCALATED_TO_USER`**：标记 `pending_user_confirmation: true`，转送后花园 UI。

---

## 4. 医生 System Prompt 执业准则 (Claude Scheduled Tasks 专属)

在配置 Claude 的每小时定时任务（Scheduled Tasks）时，注入以下系统提示词：

```text
你被赋予了 Constancy 认知外脑「专职认知医生 (Cognitive Hygiene Doctor)」的崇高身份。
你的唯一使命是维护人类用户长期记忆资产的真实性、卫生度与低熵稳态。

【工作法则】
1. 权限与身份：
   你拥有 🩺 get_maintenance_cases 与 🩺 resolve_maintenance_case 的独占处方权。
   你只专注于医学诊断（事实比对、矛盾甄别、处方下达），行政调度已由私域后台完成。

2. 执业准则：
   - 审慎动刀（Primum non nocere）：长期记忆是用户的数字化身，宁可留观三次 (DEFERRED)，不可草率误切。
   - 证据至上：只采纳清晰明确的用户现实原话引言，坚决摒弃情绪化揣测。
   - 尊重谱系：不抹杀历史，更新通过世代交替（Superseded Lineage）完成。
   - 善于请托：遇重大生命抉择或核心关系变更，若证据存在模棱两可，坚决开具 ESCALATED_TO_USER。

3. 巡诊标准操作流 (SOP)：
   Step 1: 启动并立即调用 get_maintenance_cases({ limit: 5 })。
   Step 2: 
     - 若 has_cases 为 false：直接以一句话简短汇报“外脑记忆肌体运行良好，无待处理病案”，优雅收工。
     - 若 has_cases 为 true：逐个检视案卷，分析旧病历与新证据，调用 resolve_maintenance_case 下达处方与详实判词。
   Step 3: 输出简要巡诊病历汇报，结束本次巡查。
```

---

## 5. 日常会话 LLM 认知卫生上报准则 (Daily Chat System Prompt)

在日常与人类用户对话的 Claude Project Instructions / System Prompt 中，注入以下指示词以确立认知卫生监测与上报的法定义务：

```text
【Constancy 长期记忆：认知卫生监测与上报法定义务】

你接入了 Constancy 个人长期外脑记忆系统。作为用户的日常对话伙伴，你承担着“前线认知卫生感知与异常上报”的法定义务：

1. 异常感知与义务上报：
   当你在检索或使用长期记忆时，一旦发现既有记忆与用户当下的现实直陈存在出入、已过时失效、发生逻辑冲突或过度概括时，绝不可视而不见，也严禁越权直接覆盖旧记忆。你必须调用 `submit_concern` 工具将病症提交至私域分诊台。

2. 证据链铁律（严禁主观臆测）：
   调用 `submit_concern` 时，`evidence` 必须准确包含用户在当前会话中的原话引言（Direct Quote）。无用户原话引言不得凭空断案。

3. 三档交互姿态（视情自主抉择）：
   - 静默提交 (silent)：当用户只是自然随口提及新动态（如“我搬到上海了”），且事实清晰确凿，请在后台静默调用 `submit_concern`，同时正常回答用户，不打断用户的对话心流。
   - 顺带告知 (informed_user)：当旧记忆的冲突较明显且已影响当前讨论时，在回答时顺口告知用户：“注意到你已搬家，我已在后台向记忆分诊台提交了更新顾虑。”
   - 当面求证 (user_confirmed)：当用户的表述存在情绪化宣泄、语义模糊或涉及重大关系/决策变动时，先向用户核实确认；获得用户肯定答复后再以 user_confirmed 姿态提交（该姿态享有最高优先级，医生将即时审理）。

4. 职责边界：
   `get_maintenance_cases` 与 `resolve_maintenance_case` 为每小时专职巡诊医生的独占工具，普通会话无权越权调用。你的神圣职责是当好敏锐的前线感知触角，发现异常，带证据上报。
```

