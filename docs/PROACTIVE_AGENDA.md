# Constancy 主动通信待议中枢 (Proactive Agenda Center) 架构规约

> **规约版本**: v1.1.0  
> **适用生态**: Constancy MCP 全局生态、外部独立 MCP（Fastmail 邮箱维护 / 日历巡检等）、Claude / ChatGPT 定时任务（Scheduled Tasks）、巡诊医生（Doctor）

---

## 1. 核心定位与设计哲学

主流 LLM 客户端（如 Claude Scheduled Tasks、ChatGPT Automations 等）普遍支持后台定时唤醒机制。然而，若缺乏严密的中枢治理，盲目的主动轮询极易沦为垃圾骚扰（如每小时弹窗问“主人需要我做什么吗？”）。

Constancy 主动通信待议中枢的核心定位是：
> **“跨会话、多源头的异步待议便签箱（Asynchronous Agenda Box）”**  
> **“在后台静默感知，在前台极克制开口。非高价值不扰，开口必有确凿事实与决断诉求。”**

```mermaid
flowchart TD
    subgraph 议题生产者 ["📥 异步多源感知 (静默生产者)"]
        direction TB
        FM["📬 Fastmail MCP (每日3次邮件维护)\n发现重要信件 / 需本人决断 / 日程候选"]
        DOC["🩺 巡诊医生 (定时体检)\n审出重大冲突 ESCALATED_TO_USER"]
        CHAT_P["💬 日常前线会话\n用户随口交代未来某时跟进的事项"]
    end

    subgraph 待议中枢 ["🗄️ Constancy 待议中枢 (constancy_agendas)"]
        direction TB
        COLL[("Qdrant 存储\n• 4维轻量伪向量 (零 Embedding 开销)\n• dedup_key 原地合并防刷\n• schedule_after 预约延后")]
    end

    subgraph 消费者与交互闭环 ["⏰ 主动通信与主人交互 (消费者)"]
        direction TB
        SCHED["⏰ Claude / ChatGPT 每小时定时任务\ncheck_proactive_agenda()"]
        USER["👤 用户 (桌面 / 移动 App)"]
    end

    FM & DOC & CHAT_P -->|post_proactive_agenda\n无声投递| COLL
    SCHED -->|整点轮询待议池| COLL
    COLL -.->|无待议 / 未到期| SCHED_SILENT["🤫 严格保持完全静默 (0弹窗0骚扰)"]
    COLL ==>|有待议且已到期 (紧急优先)| SCHED
    SCHED ==>|高信噪比主动交谈| USER
    USER -->|给出决策 / 要求延后| SCHED
    SCHED -->|resolve_proactive_agenda\n结案 done 或 snooze| COLL
```

---

## 2. 三大核心 MCP 工具契约

### 2.1 `post_proactive_agenda` (投递待议事项)
* **工具定位**：【📥 全角色通用 - 主动通信待议投递】
* **使用场景**：任何会话（外部定时任务如 Fastmail 邮件维护、日常前线会话记录未来待办、或巡诊医生）均可自由跨会话投递。
* **参数说明**：
  - `title`: 议题标题（简短精准，如“东航机票变动确认”、“Q3个税申报待签字”）；
  - `content`: 议题详细内容：背景上下文、邮件摘要、需用户确认或决断的事项；
  - `urgent` (可选 boolean): 是否紧急事项（默认 false）。紧急事项在轮询拉取时严格排在首位；
  - `dedup_key` (可选 string): 业务去重键（如 `msg_<email_id>`）。若存在相同 key 的未结议题则原地合并更新，防止外部定时任务重复投递导致副本堆积；
  - `schedule_after` (可选 ISO8601): 预约延后触发时间。在此时间之前 `check_proactive_agenda` 严格对轮询不可见。

### 2.2 `check_proactive_agenda` (整点巡查待议池)
* **工具定位**：【⏰ 客户端定时任务专享 - 普通日常会话请勿随意轮询】
* **使用场景**：专供后台每小时定时任务（Scheduled Tasks / Cron）唤醒时轮询待议池。
* **返回值**：
  - 若无待议事项：返回 `{ "has_agenda": false, "total_count": 0, "agendas": [] }`。
    - ⚠️ **绝对静默准则**：调用方必须保持完全静默直接收工，严禁向用户发送无意义问候；
  - 若有待办事项：返回按 `urgent` 优先 + 最新创建时间排序的议题列表。
* **参数说明**：
  - `limit` (可选 number): 单次拉取最大议题数，默认 5。

### 2.3 `resolve_proactive_agenda` (闭环核销与延期)
* **工具定位**：【✅ 闭环核销 - 主动通信议题办结/延期】
* **使用场景**：当当班会话已与用户完成该事项沟通、用户明确表示无需再提时标记为 `'done'`；若用户要求稍后提醒则标记为 `'snooze'` 并指定 `snooze_until`。
* **参数说明**：
  - `agenda_id`: 议题 UUID；
  - `status`: `'done'` (办结移出待议箱) 或 `'snooze'` (延期稍后提醒)；
  - `snooze_until`: 当 status 为 `'snooze'` 时必填，指定下一次唤醒的 ISO 8601 时间；
  - `note` (可选 string): 处置纪要。

---

## 3. 角色权责矩阵与防御体系

| 会话角色 | 核心关注工具 | 行为准则与调用时机 |
| :--- | :--- | :--- |
| **🚀 日常前线会话 (`role: "chat"`)** | `post_proactive_agenda`<br>`resolve_proactive_agenda` | 遇用户交代未来某时跟进的事项调用 `post_proactive_agenda`；聊完后调用 `resolve_proactive_agenda` 结案。<br>⚠️ **日常会话无用户明确查待办指令时，严禁随意调用 `check_proactive_agenda`**，避免打乱对话节奏。 |
| **⏰ 定时巡检任务 (`role: "scheduled"`)** | `check_proactive_agenda`<br>`resolve_proactive_agenda` | 启动立即调用 `check_proactive_agenda`；若 `has_agenda: false` **严格保持完全静默直接退出**；若为 `true` 则得体主动开口，聊完闭环核销。 |
| **🩺 专职巡诊医生 (`role: "doctor"`)** | `get_maintenance_cases`<br>`resolve_maintenance_case`<br>`post_proactive_agenda` | 专职审理长期记忆病案；若遇到重大敏感冲突下达 `ESCALATED_TO_USER` 处方后，顺手调用 `post_proactive_agenda` 投递至待议箱交接。 |
| **📬 外部维护任务 (Fastmail Scanner)** | `post_proactive_agenda` | 每日定时巡检邮件/日历，发现需决断事项时带上 `dedup_key` 默默投递至待议箱，全流程会话内零输出。 |

---

## 4. 客户端定时任务配置推荐 Prompt

用户可直接将以下 Prompt 复制到 Claude Scheduled Task / ChatGPT Automation 的整点任务中（建议运行频率：每小时 1 次）：

````markdown
你是一个贴心、懂节制的专属 AI 助手。你正在执行每小时的后台例行巡检。

1. 首先调用 `check_proactive_agenda()` 查看待议箱；
2. 如果 `has_agenda` 为 false，说明没有需要沟通的事项：
   - 保持静默，不要向用户输出任何消息，直接结束任务。
3. 如果 `has_agenda` 为 true：
   - 查看当前待议议题。请结合当下的时间、紧急程度与情境，判断是否适宜现在发起交谈；
   - 若适宜，主动以精简、得体的语气向用户陈述背景与需要确认的问题；
   - 在用户答复或处理完毕后，记得调用 `resolve_proactive_agenda` 将其关闭。
````
