# 人基常热动力学规范 (ACTD Specification)
## Anthropocentric Chrono-Thermal Dynamics v1.0

> **理论创建**：echo983  
> **学科定位**：控制论 (Cybernetics)、心理物理学 (Psychophysics)、数字信号处理 (DSP) 与 认知记忆系统 (Cognitive Memory)

---

## 1. 理论公理：认知二象性 (Cognitive Duality)

任意被智人（Homo sapiens）观测、命名或表征的认知对象 $O$（如命题、设计决策、代码片段、事实概念），其在记忆系统中的完备状态表征为**二元组**：

$$\mathcal{S} = \big\langle C_H^{\text{prior}},\; \mathbf{h}(t) \big\rangle$$

1. **骨架（本性先验）：人基常度 $C_H^{\text{prior}} \in [0, \infty)$**
   * 定义对象在不被外界触达时，根据其物理与认知本质能够维持“可预期不变性”的理论寿命上限。
2. **血肉（经验动态）：多尺度意图能谱向量 $\mathbf{h}(t) \in \mathbb{R}^K$**
   * 定义对象在现实时空中由于人类主观意图事件（IntentEvent）的刺激，而在各时间波段所激发的动态能量谱线。

---

## 2. 坐标统一定理 (Coordinate Alignment)

* **人基常度坐标**：以智人神经元动作电位 $t_0 = 1\text{ ms} = 10^{-3}\text{ s}$ 为基准：
  $$C_H = \log_{10}\left(\frac{T_{\text{ms}}}{1\text{ ms}}\right)$$
* **意图热度坐标**：以宏观动作基元 $1\text{ 分钟} = 60\text{ s} = 60,000\text{ ms}$ 为基准：
  $$s = \log_{10}(\text{minutes})$$

由于 $\log_{10}(60,000) = 4.77815 \dots \approx 4.78$，两坐标系满足严格的**对数平移公理**：

$$\mathbf{C_H = s + \kappa \approx s + 4.78}$$

### 7 维标准谱线通道定义 ($s_{\text{axis}} = [0, 1, 2, 3, 4, 5, 6]$)：

| 通道 $k$ | 尺度 $s_k$ | 半衰期 $HL_k$ | 对应常度 $C_H$ | 智人认知与交互层级 | 物理与认知内涵 |
| :---: | :---: | :---: | :---: | :---: | :--- |
| **0** | $0$ | 1 分钟 | $\approx 4.78$ | **微观注意力 (Focus)** | 瞬时打开、输入、光标停留 |
| **1** | $1$ | 10 分钟 | $\approx 5.78$ | **单次会话 (Session)** | 一次连续编码、排错会话 |
| **2** | $2$ | 100 分钟 ($\approx 1.6$h) | $\approx 6.78$ | **半日攻坚 (Task)** | 一上午或一下午的专注模块 |
| **3** | $3$ | 1,000 分钟 ($\approx 16.7$h) | $\approx 7.78$ | **生理昼夜 (Daily)** | 当日日记、强时效预报（如天气） |
| **4** | $4$ | 10,000 分钟 ($\approx 1$周) | $\approx 8.78$ | **冲刺周期 (Sprint)** | 本周主线任务、临时想法检验期 |
| **5** | $5$ | 100,000 分钟 ($\approx 2.3$月) | $\approx 9.78$ | **演进阶段 (Quarter)** | 架构设计、接口标准阶段性稳定 |
| **6** | $6$ | 1,000,000 分钟 ($\approx 2$年) | $\approx 10.78$ | **常青底噪 (Century)** | 核心实体定义、基础硬件物理规格 |

---

## 3. 动力学演进模型 (Dynamical Evolution)

### 3.1 零定时器连续懒衰减 (Continuous Lazy Decay)
系统不设置任何周期性后台轮询任务（Zero-Cron）。当任意对象在时刻 $t_{\text{now}}$ 被触达时，先将状态向量 $\mathbf{h}$ 沿连续时间轴平滑衰减至当前时刻：

$$\Delta t = \text{minutes}(t_{\text{now}} - t_{\text{last}})$$

$$h_k(t_{\text{now}}) = h_k(t_{\text{last}}) \cdot 0.5^{\frac{\Delta t}{10^{s_k}}} \quad (\forall k \in [0, 6])$$

$$t_{\text{last}} \leftarrow t_{\text{now}}$$

### 3.2 意图注入与尺度敏感核 (Intent Injection with Scale Kernel)
当入口捕获到强度为 $w$ 的有效意图事件时，沿尺度谱线注入非对称能量：

$$h_k \leftarrow h_k + w \cdot \exp(-\lambda \cdot s_k) \quad (\lambda = 0.5)$$

* **事件权重规范**：
  * 强操作（`open`, `execute`, `verify_confirmed`）：$w = 1.0$
  * 搜索命中并采纳（`search_hit_adopt`）：$w = 0.8$
  * 浏览与预览（`preview`, `peek`）：$w = 0.4$
  * 浅层关联暴露（`reveal`, `list`）：$w = 0.2$
* **时间戳更新**：若为强操作，同步更新强验证时间戳 $t_{\text{last\_strong}} \leftarrow t_{\text{now}}$。

---

## 4. 常度自愈与跃迁机制 (Emergent Constancy)

一个命题的有效常度不再是死板的常数，而是根据其在宏观长波尺度的能量积淀产生**自动升格（跃迁）**：

$$C_H^{\text{dynamic}} = C_H^{\text{prior}} + \gamma \cdot \log_{1p}\left( \sum_{k=4}^{6} \beta_k \cdot h_k \right)$$

* **升格现象（草稿 $\to$ 实体）**：
  * 一个初始常度为 $C_H=8.0$ 的临时点子，若在数月内持续在 $s=4$（周）和 $s=5$（季度）尺度被调用，其长波能量维持高位，有效常度自动跃迁至 $C_H \ge 10.5$，自动沉淀至**【核心实体清单】**。
* **降级现象（常识 $\to$ 遗忘）**：
  * 长波能量随时间耗尽，自动回落至物理老化的休眠轨道。

---

## 5. 尺度匹配的时效健康度 (Scale-Matched Validity Index, $V$)

面向大模型推理与决策时，将多尺度谱线向量 $\mathbf{h}$ **动态投影为与当前常度共振的单一标量**：

### 5.1 频段共振提取
根据该命题的动态常度，计算对应的最优共振通道浮点标度：
$$s^* = \text{clamp}(C_H^{\text{dynamic}} - 4.78,\; 0,\; 6)$$
通过线性插值（Lerp）从向量 $\mathbf{h}$ 中提取等效共振热度：
$$H_{\text{eff}} = \text{lerp}(\mathbf{h},\; s^*)$$

### 5.2 统一健康度公式
$$V(t) = \exp\left( - \frac{\text{ms}(t_{\text{now}} - t_{\text{last\_strong}})}{10^{C_H^{\text{dynamic}}}} \cdot \frac{1}{1 + \ln(1 + H_{\text{eff}})} \right)$$

---

## 6. 决策三态机规范 (The Tri-State Decision Machine)

基于健康度 $V \in [0, 1]$，为 AI Agent 定义严格的行为准则（真正读空气）：

```text
       V >= 0.7                      0.2 <= V < 0.7                     V < 0.2
 ┌───────────────────┐            ┌───────────────────┐           ┌───────────────────┐
 │   🟢 确信有效     │            │   🟡 临界漂移     │           │   ⚪ 静默沉淀     │
 │      (Fresh)      │            │    (Drifting)     │           │     (Dormant)     │
 └─────────┬─────────┘            └─────────┬─────────┘           └─────────┬─────────┘
           │                                │                               │
    直接免打扰使用                   带前置提示委婉核实               自动软遗忘(绝不诈尸)
```

1. **🟢 确信有效 ($V \ge 0.7$)**：
   * **行为准则**：直接采信，作为确定性上下文喂给模型。严禁多余的繁文缛节。
2. **🟡 临界漂移 ($0.2 \le V < 0.7$) —— 核心分寸感**：
   * **行为准则**：严禁直接武断断言，系统生成强制性提示词引导大模型以审慎礼貌的口吻向用户确认：
   * *“系统记录您在某时间前曾倾向于方案 X，鉴于已跨越常规迭代周期，请问目前此项判断是否依然适用？”*
3. **⚪ 静默沉淀 ($V < 0.2$)**：
   * **行为准则**：常规检索物理屏蔽，杜绝一切陈年垃圾干扰当下的注意力窗口。

---

## 7. 存储架构与工程复杂度 (Storage & Complexity)

在 Qdrant 中的 Point Payload 仅需存储：
```json
{
  "ch_prior": 10.5,
  "h_spectrum": [0.0, 0.2, 0.8, 1.5, 3.2, 2.1, 0.4],
  "t_last": 1789135000,
  "t_last_strong": 1789134000
}
```
* **存储开销**：7 个 Float32（28 字节）+ 2 个时间戳（16 字节）$\approx$ **44 字节**。
* **计算复杂度**：$O(K) = O(7)$ 次乘加，Worker 计算耗时 $< 0.01\text{ ms}$。
* **维护成本**：纯被动触发，零系统守护进程。
