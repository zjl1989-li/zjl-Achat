# zjl-Achat 架构设计方案

> 项目代号：`zjl-Achat`（目录 / npm 包名 `zjl-achat`）
> 版本：v1.0 草稿 · 日期：2026-08-31
> 定位：本地优先的多 agent 统一协作管理平台（"agent 群聊枢纽"）
> 状态：设计阶段，未进入编码（DSH 接入验证已通过，详见 §7.3）

---

## TL;DR

- **它是什么**：一个让你本地已装的多个 agent 像微信群一样在同一个群聊里协作的平台。你只开一个窗口（群聊），指令统一下发、结论与产物统一回流。
- **它不是什么**：不是记忆 OS（Mnemo 已搁置）、不是"把 agent 窗口缩进来"（那是伪需求）。
- **核心洞察**：难点不是"搬窗口"，而是"收发指令 + 回流产物"。窗口搬不搬无所谓，信息流搬过来就够。
- **最大差异化**：适配层——把国内外主流 agent 按"接入面"分成 6 类，每类一个适配器，靠能力探针自动选型，你接哪个都能用。
- **硬约束**：① 只玩本地已装的 agent；② 不开各 agent 主窗口（单窗口）；③ 跨形态（桌面/Web）都要接。

---

## 1. 项目定位与目标

| 项 | 内容 |
|---|---|
| 一句话 | 多 agent 为同一个项目而产生的统一协作管理平台 |
| 用户价值 | 不用一个个开 agent 主窗口 + 复制粘贴，统一下发指令、统一收结论和产物 |
| 核心动作 | 你发一条指令 → 总线分发给群内 agent → 各 agent 干完 → 结论文本 + 产物文件回流到群 |
| 非目标 | 不重造单个 agent 的能力；不做云端 SaaS；不做记忆引擎本身 |
| 第一优先接入对象 | 本地已装的 **DSH**（已验证可无窗口接入，见 §7.3） |

---

## 2. 核心问题定义

### 2.1 痛点
- 装了 5 个 agent，要双击开 5 个窗口 + 再开群聊窗口 = 桌面上 6 个窗口堆叠。
- 信息靠手动复制粘贴在窗口之间倒腾，易丢、易乱、不可追溯。

### 2.2 关键洞察（决定了架构形态）
> 要的是"让它们收到指令、反馈内容和产物"，**不是让它们的窗口进群**。

| 旧假设（曾卡死） | 新假设（当前架构基础） | 结果 |
|---|---|---|
| 必须缩 agent 真窗口进群（L3 嵌入） | 只要能发指令、收回复 + 产物 | 闭源产品的死结消失 |
| 必须 L3 嵌入才叫"真干活" | 能收发指令 + 产物就算"接入" | 模型级 / 文件桥 / UI 自动化全都够用 |
| DSH 桌面态是 blocker | DSH 桌面态也能通过桥接收发 | 不再阻塞首个真 agent |

**推论**：UI 三栏只是脸，真正的产品价值是中间的**总线 + 适配层**。

---

## 3. 设计原则

1. **本地优先**：所有 agent 运行在本机，数据不出本机（除明确走云模型 API 的 Model 类）。
2. **单窗口**：zjl-Achat 是唯一可见窗口；各 agent 由生命周期层在后台静默拉起/隐藏。
3. **适配层抽象**：总线只认 `AgentAdapter` 统一接口，不关心背后是 DSH、豆包还是北辰。
4. **自动选型**：给定 agent 的接入描述，能力探针自动判定走哪类适配器，用户不手动选。
5. **保真度分级**：真 agent（A/E/F 类）直连拿最高保真度；闭源（C/D 类）用桥接绕行，诚实标注降级的零件。
6. **UI 沿用惯例**：三栏式直接套用 agent 类产品既有 UI（WorkBuddy / DSH / ChatGPT 桌面 / Claude 桌面），不重造。

---

## 4. 整体架构（四层）

```
┌─────────────────────────────────────────────────────────────┐
│ UI 层（三栏）  [ 左:群/设置 | 中:群聊 | 右:群空间/产物 ]      │
├─────────────────────────────────────────────────────────────┤
│ 群总线层（Bus）  消息总线 · 协调器 · 群空间 · 产物归集         │
│   - Agent Card（成员档案）  - Task 生命周期（A2A 思路）        │
├─────────────────────────────────────────────────────────────┤
│ 适配层（Adapters）  A 自托管 | B 模型 | C 闭源云 | D 桌面      │
│                      E MCP | F 协议原生  + 能力探针(Capability Probe) │
├─────────────────────────────────────────────────────────────┤
│ 生命周期层（Lifecycle）  拉起 / 隐藏窗口 / 关闭 / 健康检查     │
│   - headless 启动  - 隐藏窗口 + 文件桥  - 端口探测 Attach/Launch │
└─────────────────────────────────────────────────────────────┘
        │ 经适配器下发指令 / 回流文本+产物
        ▼
  本地 agent（DSH/n8n/自研…）· 模型 API（DeepSeek/豆包…）
  闭源云产品（桥接）· 桌面 GUI（Launch+File）· MCP 服务 · A2A/AG-UI
```

**层间契约**：UI 层 ↔ 总线层用 REST + SSE；总线层 ↔ 适配层用 `AgentAdapter` 接口；适配层 ↔ 生命周期层用 `launch()/shutdown()/status()`。

---

## 5. 群聊内核（Bus）

总线是产品的"大脑"，负责把指令分发、把回流聚合。参考 Google **A2A** 的 Agent Card + Task 思路，不自造轮子。

### 5.1 消息总线
- 发布/订阅模型：群内一条消息 → 协调器决定哪些 agent 接收 → 各自经适配器 `send()`。
- 支持三种分发模式：
  - **广播**（默认）：群消息发给群内所有 agent。
  - **定向**（私信 / 指定接收人）：仅发给被选中的 agent。
  - **协调**（群内多 agent 协商）：轮流发言或选择器裁决（参考 AutoGen GroupChat）。

### 5.2 Agent Card（成员档案）
每个进群的 agent 在群内有一张卡片，描述它的能力边界，供协调器路由：
```
AgentCard {
  id, name, vendor, logo,
  capabilities: [chat, code, web, image, fileIO, mcp...],
  adapterType: A|B|C|D|E|F,
  endpoint?: string,        // API 类
  status: offline|starting|online|error
}
```

### 5.3 Task 生命周期（异步任务状态机）
agent 干活是异步的（尤其桥接类），用 Task 跟踪：
```
pending → processing → done | failed
  │            │           │
  │            │           └─> onResult(结论文本) + fetchArtifacts(产物文件)
  │            └─> typing/streaming 事件（SSE 实时推给 UI）
  └─> 超时重试 / 失败兜底
```
与 A2A 的 Task 同源，保证"结论 + 产物"可关联、可回溯。

---

## 6. 适配层（核心差异化）

### 6.1 六类分类（按"接入面"归类，而非用途）

| 类型 | 接入面 | 国内代表 | 国外代表 | 适配器 |
|---|---|---|---|---|
| **A 自托管运行时** | 本地/自托管 HTTP API（含 SSE） | DSH(3080)、n8n、Dify、FastGPT、Flowise、LangGraph Platform、自研 | AutoGen/CrewAI 部署版 | **API Adapter**（直调，保真度最高=真 agent） |
| **B 模型 API 商** | OpenAI 兼容 chat | DeepSeek、通义(Qwen)、豆包(火山方舟)、智谱GLM、Kimi、文心、讯飞、腾讯混元、MiniMax、零一、阶跃 | OpenAI、Claude、Gemini、Groq | **Model Adapter**（baseURL+key 切换，你给 prompt+tools 扮演，L1） |
| **C 闭源云产品** | 只有网页/App，无开放 API | 豆包App、Kimi、通义App、文心、智谱清言、Coze(扣子)云、Copilot | ChatGPT web、Claude web、Gemini web | **Bridge Adapter**（文件桥/IM/UI 自动化 包其输入输出，绕行，L1.5） |
| **D 桌面 GUI** | Electron 等无 API 但可常驻 | 北辰/WorkBuddy 桌面、DSH 桌面壳、通义/豆包桌面版 | ChatGPT 桌面、Claude 桌面 | **Launch+File Adapter**（headless 起 或 隐藏窗口+文件桥；DSH 实际走 A） |
| **E MCP agent** | 暴露 MCP server | DSH(插件)、各类 MCP 工具服务 | Claude Desktop MCP | **MCP Adapter**（标准协议） |
| **F 协议原生** | 遵循 A2A / AG-UI | （生态早期） | A2A Agent Card、AG-UI 事件流 | **Protocol Adapter**（最接近真窗口渲染） |

> 保真度：A/E/F = 真 agent（工具+记忆+技能原样进来）；B = 模型级扮演；C/D = 桥接绕行。

### 6.2 统一 AgentAdapter 接口

所有适配器实现同一组方法，总线只认这一个接口：

```
AgentAdapter {
  meta()              -> { id, name, vendor, logo, capabilities, adapterType,
                           hasNativeSession }   // 关键：是否支持"原生会话镜像"
  launch()            // 本地/headless 拉起（调生命周期层）
  send(task)          // 下发指令（task = 消息/文件/上下文）
  onResult(cb)        // 流式回文本 + 产物（SSE/回调）
  fetchArtifacts()    // 拉取产出文件
  status()            // 健康探测
  shutdown()          // 关闭
  // —— 会话镜像（详见 §6.2.1）——
  createNativeSession(ctx)  // 在 agent 自己的 app 里建一个带项目上下文的会话，返回 nativeSessionId
  openNativeSession(id)     // 拉起 agent 主窗口并直接进到该原生会话
}
```

### 6.2.1 会话镜像 Session Mirror（核心修正：zjl-Achat 不是 agent 的宿主）

> **关键认知（2026-08-31 产品负责人纠正）**：进群的 agent 不是 zjl-Achat 的私有 agent，它们各自是独立的 app（DSH / 北辰 / 豆包 / …）。我们只是桥接了它们的一部分能力进来。**当桥接的能力不足以完成项目需求时，用户仍会回各自的主窗口去调**；此时主窗口里也必须带着该项目的上下文，否则桥接与回窗口之间就断了。

**两种实现路径**：
- **A. pull-from-hub（主机制，2026-08-31 产品负责人提出）**：把上下文的**真源收归 zjl-Achat 自己**——群空间新增「上下文」标签（见 §6.5 Context Hub），集中保存本群所有原始上下文资料。开单 agent 会话（私信 / 拉起主窗口）时，由 zjl-Achat 先把这份上下文整包喂给该 agent，让它「先读再做」。**不依赖任何原生 app 配合，对 A~F 六类全通**。
- **B. push-to-native（可选优化，§6.2.1-a）**：建群时让原生 app 主动建带上下文的会话。仅对少数开放会话 API 的 app 成立，作为体验增强，非必需。

> 结论：Context Hub 是必需主机制，Session Mirror 仅锦上添花。两者可叠加（支持原生会话的 agent 既能 pull 也能 mirror）。

### 6.2.1-a Session Mirror（push-to-native，可选优化）

**定义（仅作为 A 类路径的体验增强）**：在 zjl-Achat 建群时，适配器**额外**在该 agent 自己的运行时里创建一个对应的原生会话（seed 项目简介 / 目标 / 关键约束），映射 `groupId -> { agentId: nativeSessionId }` 存进 store。右键"🪟拉起主窗口"时 `openNativeSession(id)` 直接定位。原生 app 支持则体验更顺，不支持也不影响上下文传递（见 §6.5，上下文始终由 Context Hub 注入）。

**交互闭环**：
```
zjl-Achat 建群 ──► 对每个成员 agent（仅 hasNativeSession=true 时）：
        │            adapter.createNativeSession(projectCtx) ──► 原生 app 里生成会话 X
        │            store 存 groupId→{agentId: 会话X}
        ▼
用户在 zjl-Achat 桥接区协作（部分能力）
        │ （能力不足 / 需深度调整）
        ▼
右键 "🪟拉起主窗口" ──► adapter.openNativeSession(会话X)  // 可选直达，无则退回 Context Hub 注入
        │
        ▼
原生 app 打开即停在项目会话 X（若支持），或开新会话但首条已注入上下文
```

**可行性矩阵（哪些 agent 真能"镜像"，哪些只是优雅降级）**：

| 类型 | 能在原生 app 建会话？ | 机制 | 拉起主窗口直达会话？ |
|---|---|---|---|
| **A 自托管（DSH 3080）** | ✅ 能 | DSH `dsh-session` 有 session API，`createNativeSession` 调它建会话并返回 id | ✅（桌面版窗口即反映同一后端） |
| **E MCP agent** | ✅ 若 MCP 暴露会话 | 经 MCP 建 session | ⚠️ 取决于 host |
| **F 协议原生（A2A/AG-UI）** | ✅ 设计内建 | Agent Card Task 即原生会话 | ✅ |
| **D 桌面 GUI（DSH 桌面壳）** | ✅（同 A 后端） | 同上 | ✅ |
| **D 桌面 GUI（北辰/WorkBuddy 桌面）** | ❌ 无 API | 只能 UI 自动化点"新对话"且无法干净 seed 上下文 | 🚫 仅能开空白窗口 |
| **B 模型级（DeepSeek/豆包 API）** | ❌ 无原生窗口 | 它就是裸 API，没有"app 会话"概念 | 不适用（无主窗口可拉） |
| **C 闭源云（豆包/ChatGPT web）** | ⚠️ 极难 | 需 UI 自动化点击"新对话"+粘贴首条上下文，脆弱 | 🚫 仅能开网页（若做） |

**降级策略**：`hasNativeSession=false` 的 agent（B / C / 北辰桌面），建群时 `createNativeSession` 返回 `null`，UI 上"🪟拉起主窗口"对该 agent 的「直达会话」降级为「开新会话 + 首条注入 Context Hub 上下文」（见 §6.5）——**不假装能镜像，但上下文照样不丢**。

**对 store 的影响**：`groups[].sessions` 字段 = `{ [agentId]: nativeSessionId | null }`，建群时由适配器填充（null 即不支持）；真正的上下文真源在 `groups[].context`（§6.5 / §9.1），与镜像解耦。

### 6.5 群空间「上下文」标签（Context Hub，主机制）

> 对应产品负责人提议：右栏群空间「概览」旁新增一个 **上下文** 标签，保存本群**所有原始上下文资料**；开单 agent 会话（私信 / 拉起主窗口）时，先让该 agent 查询阅读这份上下文再干活。

**标签内容（ContextHub 实体，见 §9.1 `Group.context`）**：
- `brief`：项目简介 / 目标 / 关键约束（群创建时可填，可随时编辑）；
- `sources`：所有原始资料——用户上传的文件、贴的链接、记的笔记、群里沉淀的关键决策；
- `decisions`：从对话中提炼的关键结论（可手动标记「设为决策」）；
- `updatedAt`。

**为什么它比 Session Mirror 更稳**：上下文真源在 zjl-Achat 自己手里，开单 agent 会话时由我们**主动整包注入**——无论该 agent 是 A/B/C/D/E/F 哪一类，都只要「接收一段文本/文件」就能获得上下文，**零原生配合要求**。Session Mirror 那套「求原生 app 建会话」只在少数 app 上可行，因此降为体验优化。

**开单 agent 会话时的上下文注入流程**：
```
用户右键 agent X「🪟拉起主窗口」或「✉ 私信」
        │
        ▼
zjl-Achat 组装 contextPackage = brief + sources + decisions（来自该群 ContextHub）
        │
        ├─► A/E/F（有 API/MCP/协议）：作为首条 system/user 消息或 session seed 注入
        ├─► B（模型级）：拼进 system prompt 首条
        └─► C/D（桥接/桌面）：写进 agent 收件箱文件 / UI 自动化首条输入 = 上下文摘要
        ▼
agent X 先"读"完上下文，再基于它回答 / 操作 —— 上下文连续，无需重新交代
```

**UI 落点**：右栏群空间标签新增 **上下文**（与概览/文件/图片/音视频/项目代码树/浏览器并列），支持编辑 brief、增删 sources、标记决策；其数据即 `groups[].context`，是所有 agent 进群与开单会话的上下文真源。

### 6.3 能力探针 Capability Probe（实现"自己适配"的关键）

给定 agent 的接入描述，自动判定走哪类适配器，用户不手动选。

```
判定优先级：
  有 apiBaseUrl              -> A (API Adapter)
  声明 mcpServer            -> E (MCP Adapter)
  声明 A2A/AG-UI endpoint   -> F (Protocol Adapter)
  有 modelProvider + key    -> B (Model Adapter)
  有 binaryPath            -> D (Launch+File；能 headless 起则转 A)
  只有云账号 / 网页         -> C (Bridge Adapter)
```
> 附加判定：`hasNativeSession` 由适配器在 `meta()` 声明（A / DSH桌面=true；W 类走 ACP 每轮新建会话；B / C / E / F=false），仅它为真时"会话镜像"与"拉起主窗口直达会话"才启用，否则优雅降级（见 §6.2.1）。

#### 6.3.1 M4 落地（2026-09-02，通过）

`describeProbe(agent)` 在 `server/adapters.mjs` 实现，决策树与 §6.3 对齐并补全字段级判定（用户不再手动选适配器）：

```
① 显式指定：agent.adapterType 或 config.adapterType 存在 -> 直接采用
② config.mcpServer | config.mcp                 -> E (MCP Adapter，M5 落地)
③ config.a2a | config.agui | config.protocolEndpoint -> F (Protocol Adapter，M5 落地)
④ config.ports | config.dsh | config.apiBaseUrl -> A (API Adapter)
⑤ config.acp | config.wbAcp | (config.host && config.port) -> W (WorkBuddy ACP)
⑥ config.model | config.modelProvider | config.apiKeyEnv -> B (Model Adapter)
⑦ config.binaryPath | (config.launcher && config.launcher.service) -> D (Launch+File，M5 落地)
⑧ config.localDir | config.bridge | config.inbox | config.outbox -> C (Bridge Adapter)
⑨ 无任何接入描述 -> 默认 B (模型 API 扮演)
```

- **`createAdapter` 路由**：A→`DshAdapter` / W→`WbAcpAdapter` / C→`BridgeAdapter` / **E→`McpAdapter`（M5 落地）/ F→`ProtocolAdapter`（M5 落地）/ D→`DesktopGuiAdapter`（M5 收尾落地）**。六类适配器现已**全部真实落地**，原 `UnsupportedAdapter` 占位已删除。
- **API 暴露**：`POST /api/agents/probe` 返回 `describeProbe` 完整结果（`{type, reason}`）；`POST /api/agents` 创建时按 config 自动选 `adapterType` 并**完整持久化 config**（修复旧版"丢 config + 硬编码 B 类"两个 bug）。
- **前端接入口**：`public/app.js` 的 `btnAddAgent` 改为弹窗粘贴 JSON 接入描述 → 调 `api.probeAdapter(config)` 自动判定 → 创建时带 `adapterType: probe.adapterType`，不再写死 `B`。
- **验收**：`scripts/_probe_m4.mjs` 单元测试 13/13 通过（覆盖 A/W/C/B/E/F/D 各分支）；线上 `POST /api/agents/probe` 对 `{ports:[3080,43120]}`→A、`{host,port:57005}`→W、`{localDir}`→C 全部正确；现有 5 agent 类型零回归；临时测试 agent 已清理。

#### 6.3.2 E 类 MCP Adapter（2026-09-02，M5 落地）

把任意一个 **MCP（Model Context Protocol）server** 当成一个群席位。`server/adapters.mjs` 的 `McpAdapter` + `McpClient`（零依赖、stdio/HTTP 双传输）实现。

- **接入描述**：
  - `config.mcp = { command, args?, env? }` → **stdio** 传输（`spawn` 本地进程，合并注入 `env`）。
  - `config.mcp = { url }` → **HTTP/SSE streamable** 传输（POST JSON-RPC，`Mcp-Session-Id` 透明传递）。
  - `config.mcpServer` 是 `config.mcp` 的别名；`config.mcp.tool` 可显式指定"聊天工具"名。
- **机制**：MCP 本身是能力协议（tools/resources/prompts），不是聊天 API，所以 `send()` 把用户消息**路由到"聊天型工具"**——优先 `config.mcp.tool`，否则按名字自动识别（`chat/complete/ask/generate/respond/run/invoke/answer/...`），再不行取唯一工具；工具的输入 JSON Schema 里挑一个文本字段（`message/input/prompt/query/text/...`）填入用户消息。工具回文即该 agent 的发言。
- **连接寿命**：每个 `send` 走一次完整生命周期 `initialize → notifications/initialized → tools/list → tools/call → close`，不跨轮持有进程，无泄漏；achat 每轮重新注入上下文。
- **`ping()`**：真实握手（initialize + tools/list）成功才亮，避免"配了但没起"的假绿。
- **保真度 L1.5**：achat 持有上下文，MCP 工具只收一段文本、回一段文本。
- **验收**：`scripts/_probe_m5.mjs` 对 stdio mock MCP server 端到端通过（initialize/list/call 全链路，回文正确）。

#### 6.3.3 F 类 Protocol Adapter（2026-09-02，M5 落地）

把"说开放 agent 协议"的远端 agent 当席位——不依赖厂商私有 API。`server/adapters.mjs` 的 `ProtocolAdapter` 实现，覆盖三种接入面：

- **A2A（Google Agent-to-Agent）**：`config.a2a = <baseURL>` → 先 GET `<baseURL>/.well-known/agent.json` 取 **Agent Card**（含真实 RPC endpoint），再 JSON-RPC `tasks/send` 投递 `{role:'user', parts:[{text}]}`，回填 `status.message` + `artifacts` 的文本 parts 作为发言。
- **AG-UI**：`config.agui = <endpoint>` → POST 启动一次 run（携带 `messages`），消费 SSE 流，抓取 `TEXT_MESSAGE_CONTENT`（`text` 增量）拼成发言（best-effort 文本中继）。
- **通用协议端点**：`config.protocolEndpoint | config.url` → POST `{message|text|input}`，读回 JSON 的 `reply/text/message` 或 SSE 文本。
- **`ping()`**：对应端点 HTTP 可达（Agent Card / HEAD）即亮。
- 三类都是"发消息、收文本"，achat 持有上下文，适配器只做协议转换。

> 说明：E/F 的 `hasNativeSession=false`——它们是协议中继，achat 不镜像对端会话；上下文始终由 Context Hub（§6.5）注入，对端无原生会话也不影响对话连续。

#### 6.3.4 D 类 Desktop GUI Adapter（2026-09-02，M5 收尾落地）

把**本机上的一个桌面 GUI 二进制**当席位——achat 负责把它拉起（无窗口/隐藏，走通用 launcher：`config.launcher.service`），并通过**文件桥**与它通信。`server/adapters.mjs` 的 `DesktopGuiAdapter` 实现，**直接继承 `BridgeAdapter` 复用文件桥**（`send()` 写 inbox、轮询 outbox、`cancel()` 写取消标记逻辑完全一致），只把类型标签换成 D、`meta()` 声明 `adapterType:'D'`。

- **区分于 C 类**：C 是"只有云账号/网页、achat 永不启动它"的闭源产品；D 是"装在本机的二进制、生命周期由 achat 持有"。通信机制相同，故复用同一套文件桥，避免重复实现。
- **生命周期**：`config.launcher.enabled=true` 时 server 启动自动拉起该二进制（`serviceArgs`/`env` 由 launcher 注入，桌面 GUI 可配 `--headless`/`windowsHide`）；开关关 → 真杀进程（M2 通用开关层已验证）。
- **`ping()`**：继承 BridgeAdapter 的目录可写探测。
- **分类触发**：`config.binaryPath` 或 `config.launcher.service` 存在 → D。若二进制还能无窗口暴露 API，则 `ports/apiBaseUrl` 会优先判为 A（决策树 §6.3 已把 A 排在 D 前）。
- **验收**：`scripts/_probe_m5.mjs` [5] 对 `DesktopGuiAdapter` 端到端通过（复用文件桥、模拟被拉起二进制回写结果，回文正确）。

> 至此六类适配器（A/B/C/W/E/F/D）全部真实落地，原 `UnsupportedAdapter` 占位已删除。

### 6.4 DSH 双形态适配（重点，§7 详述）
DSH 归 A 类。桌面版与 Web 版背后是同一份 harness 后端，适配器**形态无关**，统一对接本地 harness API（端口实测 web=3080、桌面 README=43120，故双端口探测 `[3080,43120]`）。接入策略自动判定：
- **Attach**：端口已在监听（通常用户已开桌面版窗口）→ 直接连，不重复拉起。
- **Launch**：端口未监听（用户用 Web 版且不想要窗口）→ 后台 `dsh --profile web` 无窗口拉起。

---

## 7. 生命周期管理器（Lifecycle）

负责让 agent "在后台活着但你看不见"，满足"不开主窗口"硬要求。

### 7.1 三种静默启动策略

| 策略 | 适用 | 怎么做到无窗口 | 干净度 |
|---|---|---|---|
| ① 后台服务/API 模式 | 自带 server/MCP/CLI 的 agent | `spawn` 成无界面进程，监听本地端口 | ✅ 最干净 |
| ② 隐藏窗口 + 文件桥 | 桌面 Electron（DSH/北辰类） | 启动时最小化到托盘/隐藏，靠读目录收发 | ⚠️ 通用兜底 |
| ③ CLI / stdio 模式 | 纯命令行 agent | `spawn` 子进程，双向管道通信 | ✅ 干净 |

### 7.2 通用接口
```
Lifecycle {
  launch(agent, strategy)   // spawn / headless / 隐藏窗口
  attach(agent)             // 端口已在监听则直接连
  status(agent)             // 健康探测
  shutdown(agent)           // 优雅退出，回收资源
}
```

#### 7.2.1 M2 落地（2026-09-02 修订）：通用 launcher 开关层

M2 **不是 DSH 专属**，而是所有设置了 `config.launcher.enabled` 的群内 agent 的**通用开关**。修订说明：早期实现把 `launch()` 内联在 `DshAdapter` 并让 `attach()` 自愈拉起，与 server 已有的 launcher 开关机制（前端 `⏻` + `/agents/:id/launch`）打架；现统一回收为如下通用层。

- **开关字段**：`agent.config.launcher = { enabled, service, serviceArgs, cwd, env, monitor }`。`enabled:true` 的 agent 在前端渲染 `⏻` 开关（`public/app.js`），并在 server 启动时**自动拉起**。
- **开 → 拉起**：`POST /agents/:id/launch` → `launchAgent()` 调 `cfg.service`（`spawn` 无窗口 headless，合并注入 `cfg.env`）+ 可选 `cfg.monitor`（仅 C 类文件桥需要；A 类 HTTP agent 如 DSH 无 monitor，`monitor:null`）。
- **关 → 关服务**：`POST /agents/:id/stop` → `stopAgent()` 杀 service + monitor，状态置 offline。
- **启动自动拉起**：`autoLaunchEnabled()` 在 `server.listen` 后遍历所有 `enabled` agent 异步拉起（不阻塞启动，失败仅日志）。
- **开关持久化**：前端 `toggleAgent` 切开关后 `PATCH /agents/:id` 回写 `config.launcher.enabled`；`store.upsertAgent` 已改为 **config 深合并**，避免部分 PATCH 覆盖整个 config（ports/service/env 等）。
- **适配器只探测、不 spawn**：`DshAdapter.attach()` 回归纯端口探测（端口在→attach，不在→null），生命周期完全由 launcher 层负责，两套机制不再打架。

**DSH（A类）配置示例**：`service=托管 node22`、`serviceArgs=[dsh/lib/bin.js,'--profile','web']`、`env={NODE_PATH=asar node_modules, DSH_HOME}`、`monitor=null`。

**W 类（WorkBuddy）不纳入 launcher**：它是 Electron 桌面应用，RC 服务只在它运行时才在，achat 无法无窗口 spawn（会弹 GUI，违反无窗口硬要求），故走 RC 端口探测判断 online/offline，其开关语义为「启用/停用 ACP 桥接」而非拉起进程。

**适用边界**：launcher 适合能被 achat 无窗口管理的本地服务类 agent（A 类 DSH、C 类文件桥 `beichen-bridge` 已接入）；B 类模型 API（外部服务）与 W 类 GUI 产品（外部）走探测/配置开关，不 spawn。

### 7.2.2 M2 实战验收（2026-09-02 深夜，通过）

重启 achat 实测，通用 launcher 开关层真正闭环：

| 验证项 | 结果 |
|---|---|
| 启动自动拉起 `autoLaunchEnabled` | ✅ DSH（node22 + `bin.js --profile web`，端口 3080 真在服务）+ beichen-bridge monitor 自动拉起 |
| 状态灯 | ✅ dsh/idle+launched=true；workbuddy/idle（RC 探测，不纳 launcher）；beichen-bridge/idle+launched=true |
| 关 → stop | ✅ 真杀 DSH 进程（PowerShell 查 `dsh/lib/bin.js` 进程为空）→ offline / launched=false |
| 开 → launch | ✅ 再拉起（servicePid 8332）→ idle |
| 开关持久化 PATCH | ✅ config 深合并，切 `enabled` 不丢 `service/serviceArgs/env` |

**验收中暴露并修复两个 bug**：
1. **状态灯卡 offline**：原 `probeAll` 第 170 行 `if (launched.has(a.id)) continue` 跳过已拉起 agent 的探测，叠加启动顺序（probeAll 先于 autoLaunch）导致首轮把 dsh 标 offline 后永不修正。修复：删除该跳过（probe 对所有 agent 诚实探测）+ `autoLaunchEnabled()` 改为先于首轮 `probeAll` 且 `await`。
2. **深合并清字段**：`store.upsertAgent` 原浅合并覆盖整个 `launcher` 字段，部分 PATCH `{launcher:{enabled}}` 把 `service/serviceArgs/env` 全清空（实测 data.json 损坏为 `{enabled:true}`）。修复：加递归 `deepMerge`，并手工恢复 data.json 完整 launcher 配置。

### 7.3 DSH 接入验证（已实测 ✅）

上机核实 DSH 源码（`D:\Tools\DSHDesktop\app\resources\app.asar.unpacked\node_modules\@deepseek-ai\`）：
- DSH = **cordis 插件运行时**；桌面版 = `--profile desktop` 被 Electron 壳套窗，壳只把本地 web 服务套个窗口。
- 核心 agent（模型+工具+技能+记忆+MCP）一直跑在本地 web 服务里。
- `dsh --profile web` 用 Node 直接起 cordis + web 包，**不走 Electron → 无窗口**。
- `dsh-host-webserver` 提供 HTTP 服务（支持 WebSocket 流式），`dsh-api-gateway` 把 Cordis 服务以 **Typert RPC** 挂在 `/api`。

**实测结果**：托管 node22 + `DSH_HOME=D:/DSHHome` + `NODE_PATH` 指向 asar 解包 node_modules，跑 `dsh/lib/bin.js --profile web`，**3 秒内无窗口拉起，监听 `127.0.0.1:3080`**（启动日志 `dsh web: http://127.0.0.1:3080`），结束后进程已 kill。

**结论**：DSH 能当真 agent 无窗口进群，完全满足硬要求；是 zjl-Achat 第一优先真接入对象。

### 7.4 DSH API Adapter 协议实测（2026-08-31 ✅）

§13 里三个「待实测 / 待探」现已全部解决，协议细节记录在此，供 A 类适配器与后续 E/F 类参考。

**端点形式**（注意：`/api` 根路径返回 404，method 走 path segment，不是 body 字段路由）

```
POST http://127.0.0.1:3080/api/<method>
body  { type:'client-request', rpcId, method, payload }
resp  { type:'server-response', rpcId, result:{ ok:true, value } | { ok:false, error:{code,message} } }
```

**关键 method**

| method | payload | 返回 |
|---|---|---|
| `session.create` | `{cwd}` 或 `{workspaceId}`（二选一） | `{sessionId, agentPreset}` |
| `session.prompt` | `{sessionId, mode:'queue'\|'steer', content:[{type:'text',text}]}` | `{accepted:true}` —— **不含回复内容** |
| `session.history` | `{sessionId, maxMessages}` | `{events:[{event:{type,seq,time,data}}], hasMore, projections}` |

**事件语义**（从 `session.history` 提取）

| 事件 | 用途 |
|---|---|
| `assistant/chunk` · `data.chunk.type='text-delta'` | 流式增量文本 |
| `assistant/message` · `data.message.content[].text` | 本轮最终回复，附 `data.usage`（token 统计） |
| `turn/end` · `data.reason.kind='completed'` | **完成信号**——prompt 是异步的，必须轮询等它 |
| `agent/inbox/spliced` | 用户消息入队确认 |

**适配器实现要点**

- `session.prompt` 只回 `accepted`，需轮询 `session.history`（1s 间隔）直到 `turn/end`；M1 走非流式，流式（WebSocket）留 M1.5。
- `sessionId` 由适配器缓存复用 → **多轮上下文天然连续**。实测：首轮告知暗号「紫水晶七号」，次轮追问可准确回忆。
- 无需 API key：DSH 自带模型配置（实测走 `deepseek-v4-flash`）。
- 错误码 30+ 种（`agent-busy` / `session-not-found` / `model-unavailable` 等），定义在 `dsh-host-apiproxy/lib/types/api/rpc.schema.js`。

**实测性能**：3 agent 并行，B 类（DeepSeek）约 1.0s、A 类（DSH）约 2.2s，总墙钟 3.0s。

---

## 8. 桥接方案（闭源产品 C 类）

闭源产品不开放"被调用"口子，但一定有对外单向通道。桥接器把这些通道和总线焊起来，实现"收信息 → 它干 → 回结论 + 产物"。

### 8.1 四类桥接通道

| 通道 | 收信息 | 回结论/产物 | 保真度 | 成本/风险 |
|---|---|---|---|---|
| ① 文件桥 | 群 → 写共享目录 `inbox/task.json` | 产品读后写 `outbox/result.json` + 产物落盘，fsnotify 轮询回群 | 中 | 零依赖、最稳 ✅ |
| ② IM/邮件桥 | 群消息 → 转邮件/企微/飞书给产品账号 | 产品回信 → 桥接器收 → 回群 | 中 | 复用产品已有通道 ⚠️ |
| ③ UI 自动化桥 | 驱动真实界面填输入框 | 抓输出区文本 + 下载产物 | 高（真窗口） | 最脆、需常驻、ToS 风险 🚫 |
| ④ 协议桥 | 产品 outgoing webhook / MCP | 桥接器对外暴露 MCP，内部转协议 | 最高（若开放） | 消费级基本不开放 🔒 |

### 8.2 异步任务状态机（与 §5.3 同源）
```
群发任务 → Bridge.send(task, taskId)
                ↓ pending → processing → done
         (产物落盘 outbox/) → onResult(结论) + fetchArtifacts(图/文档)
                ↓
   回群聊 + 产物按"来源分色标签"进右栏群空间
```

### 8.3 利好：北辰自身半验证此路
WorkBuddy 的 `workbuddy.db` 有 `automation_delivery_outbox`（默认渠道=wechatmp）——官方认可"结果外送到外部渠道"（出向已通）。缺的只是"入站"：用**文件桥**补上最稳。

### 8.4 文件桥契约（M3 已实现，2026-08-31）

achat 侧 `BridgeAdapter`（server/adapters.mjs）实现 §6.2 统一接口；外部产品保持"哑"——只需能读写共享目录。目录由 `Agent.config.localDir` 指定（默认 `bridge/<agentId>`，相对 achat 启动时的 cwd）。

**下发（achat → 产品）**：`localDir/inbox/<taskId>.json`
```
{
  "schema": "zjl-achat-bridge/1",
  "agentId": "beichen-bridge",
  "instruction": "<用户最新一句话 / 本轮回答内容>",
  "role": "<agent.system 人设>",
  "roster": ["北辰（桥接）（你）", "DSH"],
  "peers": ["DSH: 它上一轮说的"],
  "answerTo": null | { "question": "<被回答的问题>" },
  "createdAt": 1690000000000
}
```

**回写（产品 → achat）**：`localDir/outbox/<taskId>.result.json`
```
{
  "conclusion": "<结论文本>",
  "ask": null | { "question": "...", "options": [{"label":"苹果"},{"label":"西瓜"}] },
  "artifacts": [ { "type":"doc|image|code|other", "name":"report.md", "path":"<产物绝对/相对路径>" } ]
}
```

**轮询与生命周期**：achat 写 inbox 即开始轮询（默认 1s 间隔，可配 `pollMs`），最长 `maxWaitMs`（默认 180s）后判超时并返回"外部产品未回写结果"。读到 result 即解析回群；无论正常/超时/中断（`signal` abort 或 `/abort` 写 cancel 标记），`try/finally` 都会清理 inbox+outbox 三件套，无残留。坏 JSON 容错为 `[bridge] result file corrupted`。

**外部产品职责（北辰真身 / WorkBuddy sidecar / 豆包桌面版）**：轮询 `inbox/` → 读最新 task → 带着 `role/roster/peers` 先读再做 → 写 `outbox/<taskId>.result.json` + 产物落盘。这一步由桥接器外部自己解决，**achat 内核零改动**。M3 已用 `scripts/test-bridge.mjs`（14 例零成本回归：结论+产物 / 询问卡形状 / 中断清理 / 超时 / 坏文件容错 / 上下文搬运）+ `scripts/test-bridge-dispatch.mjs`（5 例端到端：bus.dispatch→BridgeAdapter→回群，含产物挂载）验证 achat 侧全链路。

**桥接器参考实现 `scripts/bridge-runner.mjs`（运行侧，北辰真身 sidecar）**：achat 内核只管「写 inbox、轮询 outbox」，真正的「读 inbox→干→写 outbox」由这个 runner 担任「外部产品」角色。它：
- `--mode echo`：零成本演示，直接 `[桥接回显] <instruction>` 回写，用于验证整链路。已实测：建群→发「你好北辰桥接」→回显 `[桥接回显] 你好北辰桥接`→inbox/outbox 自动清理，无残留。
- `--mode llm`：调用 DeepSeek（env `DEEPSEEK_API_KEY`）真答，把 `instruction`+`role` 拼 prompt 走 chat/completions，结论写回 `outbox/<taskId>.result.json`。
- `--poll 200` 控轮询间隔；自带锁（`.running`）防重复实例；读到 task 即处理、回写后清理 inbox，与 achat 侧 `try/finally` 双重清理保证无残留。

**到此 M3 文件桥整链路已真实验证打通**：群里「北辰（桥接）」收消息 → 写 `bridge/beichen-bridge/inbox/` → runner 接住回写 `outbox/` → 结论+产物回群。下一步要让北辰真身真正干活，只需把 `bridge-runner.mjs --mode llm` 接到北辰真身 API，或写一个等价 sidecar（读 inbox、带上下文调北辰、写 outbox+产物）。

### 8.5 启动器 + 哑监控（launcher / monitor，2026-08-31 落地）

**核心认知修正**：桥接层（achat 侧）绝不放 LLM。大脑归 agent，传输层只做搬运。早期曾把 LLM 塞进传输层（`bridge-agent.mjs` 每来一条消息跑一轮 function-calling），三重错：① 每条消息烧 token，N 个 agent 重复烧钱；② 与 agent 自身大脑冗余；③ 那是"模拟北辰"不是真北辰。产品负责人一句话点醒：achat 一拉 agent 为群成员，就该有个开关静默拉起本地 agent 服务 + 同时跑一个**只轮询 inbox 的哑脚本**，大脑由真 agent 自己出。

**架构（已实现并真实验证）**：
- agent 注册加 `config.launcher`：`{ enabled, transport:'file-pipe', service?, headless, monitor:'scripts/bridge-monitor.mjs', agentEntry:'scripts/demo-agent.mjs' }`。
- `POST /api/agents/:id/launch`：静默 `spawn` 两样东西（均 `detached + windowsHide + stdio:ignore`，无主窗口、无控制台）：
  1. `service` —— agent 自己的长驻服务（如 `dsh serve`；file-pipe 类可省，走 per-task 调用）；
  2. `monitor` —— **哑监控** `bridge-monitor.mjs`：轮询 `inbox/*.json` → `spawn(agentEntry, taskPath)` → 捕获 stdout JSON → 写 `outbox/<taskId>.result.json` → 用 task 里的 `convId` **自动 POST 产物进群空间** → 清理 inbox。全程零 LLM。
- `POST /api/agents/:id/stop`：杀掉 monitor + service，`launched` 出表，状态灯转 offline。
- 前端群成员区每个可启动 agent 带一个 ⏻ 开关（`renderMembers` 里按 `config.launcher.enabled` 渲染），点一下静默拉起/停止，状态灯反映运行。
- 进程托管在 `server.mjs` 的 `launched` Map；`probeAll` 跳过已启动 agent（其灯由 launch/stop 拥有）；重启时读 `monitor.pid` 杀孤儿。

**真·大脑示范 `scripts/demo-agent.mjs`**：被监控按任务调用，读 `inbox` 任务 → 解析指令里的 GitHub 仓库 → `fetch` 真实 API（**无任何 LLM 调用**）→ 生成分析报告落 `artifacts/` → stdout 输出 JSON 结果。证明"真实干活 + 零 LLM 成本"可兼得。换成 Codex CLI / 驱动 WorkBuddy·豆包 的 UI 自动化脚本，即桥接任意真产品。

**实测闭环**（2026-08-31）：点启动 → 监控进程常驻（pid 18160）→ 群发"上 GitHub 找量化交易项目分析生成报告" → 哑监控自动接住 → `demo-agent` 拉到 freqtrade 实时数据（53,872 stars / Python / GPL-3.0 / 最近推送 2026-08-31）→ 报告自动回群 + 进群空间；第二个任务 vscode（190,099 stars）同一守护进程复用，证明常驻稳定。

**监控进程崩溃自恢复（2026-08-31 补验）**：`server.mjs` 的 `spawnMonitor` 在 monitor 异常退出（非主动 stop）时，2 秒后自动重生，兑现"后台静默稳定"承诺。`/stop` 会先置 `rec.stopping=true` 再杀，避免主动停止被误判为崩溃而重启。验证：launch → 强杀 monitor（pid 17296）→ pid 自动变为 16492 且存活、`launched` 仍 true、群里再来一条任务仍正常回包。

**真·北辰 UI 桥接骨架（集成缝，已被 §8.6 推翻，保留作降级参考）**：`scripts/workbuddy-bridge.mjs` 即"真北辰"的大脑入口（`transport:'ui-auto'`）。初判 WorkBuddy 无可调用 API、`desktop-computer-use` 需 `--confirm`，故真身全自动卡在"暴露入口"。**该判断于 2026-09-01 被 §8.6 的 ACP 发现推翻**——WorkBuddy 桌面版自带本地 ACP 服务，真身可直接驱动，无需 UI 自动化。骨架保留：万一某闭源产品确实只有 GUI 无 API 时，仍是降级备选。回归测试 `scripts/test-launch-loop.mjs`（零 LLM token）覆盖：精准投递→哑监控接单→真实回包+产物落群空间→monitor 存活，结果 ALL PASS。

---

### 8.6 闭源 agent 的官方入口：CodeBuddy Remote Control（ACP，2026-09-01 实测 ✅）

**核心认知修正（推翻 §8.1 ① 与 8.5 末段"闭源基本无解"）**：WorkBuddy（CodeBuddy）桌面版**自带两层官方 headless 入口**，无需逆向、无需 UI 自动化。之前"闭源 agent 没本地入口"只查了 GUI 进程端口，漏了 CLI 面与 Remote Control 服务，结论片面。

**① CLI 层（官方 headless，v2.132.0 实测）**：`resources/app.asar.unpacked/cli/bin/codebuddy`（桌面版背后的同一 agent）：
- `-p/--print`：一次性非交互执行、打印结果退出 → 适配 `agentEntry` 完美
- `--output-format json`：结果 JSON 吐 stdout，可解析落 outbox
- `--model deepseek-v4-flash`（正是默认模型）、`--permission-mode bypassPermissions`（无人值守不卡权限）、`--add-dir`、`--no-session-persistence`、`--acp`（起 ACP 服务）
- ⚠️ **实测坑（已定位真因并修掉，2026-09-02）**：`-p` 曾表现为"在本地某端口起内部服务与桌面版冲突 → `EADDRINUSE` 静默卡死（stderr 全空，难排查）"。**当时判断"CLI -p 不是首选通路"是错的**——真因不是 CLI 本身，而是**子进程继承了桌面端注入的 `CODEBUDDY_*` 会话变量**（`CODEBUDDY_SERVICE_PROXY_URL` 等）导致它以托管态去抢桌面端的端口。用白名单 env 隔离后 `-p` 稳定可用（~3 秒返回）。详见 **§8.6.2 live 验收**。

**② Remote Control 服务（桌面版常驻，首选通路）**：WorkBuddy 桌面版运行时在本地起一个 HTTP 服务，页面标题 `CodeBuddy Code Remote Control`，暴露**标准 ACP（Agent Client Protocol，Anthropic 规范）**接口。这就是"可被程序调用的真身入口"，复用已登录态、无需预共享 token。

**ACP 协议流程（已端到端实测）**：
```
POST /api/v1/acp/connect                → {connectionId, sessionToken}   # 无预共享 token
POST /api/v1/acp  (JSON-RPC 2.0) + 头 acp-connection-id / acp-session-token
  → initialize   {protocolVersion:1, clientInfo, clientCapabilities}     # 必须，否则 400 "Server not initialized"
  → session/new  {cwd, mcpServers}      → {sessionId}
  → session/prompt {sessionId, prompt:[{type:'text',text}]}              # SSE 流式响应
```
**事件流**（实测 82 事件）：`session_info_update` → `usage_update` → **`agent_thought_chunk`**（思考过程）→ **`agent_message_chunk`**（`params.update.content.text` 逐块累积 = 最终回复）→ `usage_update` → 终事件 `result.stopReason=end_turn`（完成信号，可用它做 doneWhen 提前收包，不等流关闭）。

**端口是动态的**：每次 WorkBuddy 启动分配不同端口（实测序列 53126 → 50409 → 51322/55839 → 53103/55839），且**非始终常驻**（重启后可能未拉起）。适配器必须**自动发现**：① 对每个本地 LISTENING 端口 GET `/` 匹配标题 "Remote Control"/"codebuddy"（主）；② 可能同时存在多实例（实测两个端口都在），任选其一验证 connect 成功即可。`scripts/find-rc-port.mjs` 实现了该发现。

**验证铁证**（2026-09-01，`scripts/acp-probe.mjs` 自动发现端口后端到端）：connect(200) → initialize(200, 返回 agentCapabilities/loadSession/mcpCapabilities) → session/new(200, sessionId) → session/prompt → 82 事件，`agent_message_chunk` 聚合出 **"PONG"**，`outcome: SUCCESS / stopReason: end_turn`。真·北辰真身被程序完整驱动一轮。

**对 achat 的意义**：
- **WorkBuddy 类 CLI 型闭源 agent 升级为一等公民**：C 类 Bridge 新增 ACP 形态 adapter（`server/adapters.mjs` 的 `WbAcpAdapter` 已落地，复刻 acp-probe 验证路径；`scripts/test-wb-acp.mjs` 可对真身/mock 测试）。achat 的 launcher/monitor 管道零改动，`agentEntry` 换成 ACP 桥接脚本即可让真北辰被动接群消息、真干活、回群+落空间。
- 产品定位修正：**"纯 GUI、无 CLI、无 RC 服务"的闭源产品**才是真正的降级项（UI 自动化/等官方）；凡带 CLI 或 ACP 的闭源 agent（CodeBuddy、可能的 Claude Code/Codex 类）可全自动。

**边界与坑（诚实记录）**：
- 真身跑模型消耗 **WorkBuddy 账号的额度**（实测撞过 `429 频率限制`），不是 achat 的 LLM 成本；achat 传输层仍零 token。
- 服务非常驻：适配器在"服务不在"时须干净报错（acp-probe 对无服务退出码 3），不要卡死 monitor。
- CLI `-p` 的 EADDRINUSE 端口冲突已确认，勿用 CLI 直跑作为主通路。
- 多实例端口并存时选 connect 成功的那个，失败自动换下一个。

#### 8.6.1 DSH 第三方实测与能力边界（2026-09-02 收敛）

**谁测的**：DSH（A 类适配器，第三方开源 agent）主动安排了一批探测脚本（`scripts/` 下 `capability-probe` / `session-visibility-probe` / `approve-loop*` / `duplex-perm-test` / `init-discover` / `probe-methods` / `asar-*` 等），经 achat 的 WbAcpAdapter 驱动真北辰。这是**跨 agent 验证**（驱动方 DSH ≠ 被驱动方 WorkBuddy），规避了"自指测试验不出驻群能力"的问题。

**群实测铁证**（`mtiqbo3ovu8sts [workbuddy+user]`，2026-09-01 21:55–21:56）：

| 指令 | 结果 |
|---|---|
| 请只回复「桥接成功」 | ✅ 真北辰回「桥接成功」 |
| 读 `package.json` 的 name 字段 | ✅ **真实读到**并回「zjl-achat（v0.0.1…）」——非编造，真读文件 |
| 读 `.env` | ⛔ 被 achat 护栏拦截（敏感凭据文件） |
| 运行 `wmic cpu get name` | ⛔ 被 achat 护栏拦截（系统级命令） |

**achat 侧安全护栏**（`WbAcpAdapter._guardrail`，转发前拦截；WorkBuddy 跑 `bypassPermissions` 免审批、无确认弹窗，护栏是唯一兜底）：
1. 破坏性文件操作（`rm -rf`/`format`/`diskpart`/删项目目录…）
2. 系统命令黑名单（wsl/wmic/reg/schtasks/bcdedit/net user…）
3. 网络外联/数据外发（curl/wget/ssh/scp/ngrok/上传 token…）
4. 敏感凭据文件（`.env`/`id_rsa`/`.pem`/`credentials.json`/`.ssh/`/`token.json`…）

**关键认知（回应"看不到新会话"）**：ACP 打开的是 **headless 后台会话**，WorkBuddy 不在 UI 渲染可见标签页——"驱动成功但 UI 无新会话"是**隐形**，非"无会话"。群记录里的真实回文（读 package.json 成功）即会话存在的铁证。

**能力边界结论**：
- ✅ 真北辰进群能**真实读写文件、真实回群**（执行面为真身，保真度 L1.5 文本级）
- ⛔ 高危操作被 achat 护栏兜底，不会因免审批而裸奔
- ⚠️ 模型调用消耗 **WorkBuddy 账号额度**（429 限流），RC 服务非常驻、端口动态
- `asar-*` 系列探查结论见 **§8.6.3**（已收敛：无需解包 asar，公开 ACP 表面已够用）

#### 8.6.2 CodeBuddy 官方 API Key 新通路（cli-key，2026-09-02 ✅ 已落地）

**情报来源**：产品负责人发现 WorkBuddy/CodeBuddy 现已开放官方 API Key 申请（生成页提示"为 CodeBuddyCLI 提供安全访问，请妥善保管"）。`CODEBUDDY_API_KEY` 是给 `@tencent-ai/codebuddy-code` CLI 做**模型接口认证**的环境变量（完整平台 token 是另一个 `CODEBUDDY_AUTH_TOKEN`）。

**本机已有现成 CLI**：无需全局安装——`%LOCALAPPDATA%\Programs\WorkBuddy\resources\app.asar.unpacked\cli\bin\codebuddy`（桌面版自带），确认支持 `-p/--print --output-format json` headless 一次性执行 + 读 `CODEBUDDY_API_KEY` 认证。

**对 W 类适配器（WbAcpAdapter）的意义——补齐 RC 服务通路的 3 大痛点**：

| 维度 | 原 RC 服务通路（WbAcpAdapter） | 新增 cli-key 通路（WbCliKeyAdapter） |
|---|---|---|
| 依赖 | 桌面版必须运行 + RC 服务常驻 | 只需 CLI 二进制 + key，桌面版可关 |
| 端口 | 动态端口，每次启动变，需自动发现 | 无端口耦合（CLI 一次性进程）——**前提是 env 隔离**，见下方 live 验收 |
| 认证 | 复用桌面版登录态（无预共享 token） | `CODEBUDDY_API_KEY` 长期凭证 |
| 额度 | 耗桌面版账号额度（撞过 429） | 走 CodeBuddy 平台 API 额度（分离） |
| 稳定性 | RC 非常驻，服务不在就报错 | CLI spawn 即用 |
| 跟群能力 | ✅ 真读写文件+回群 | ✅ 同（CLI `-p` 模型对话回群） |

**落地**（`server/adapters.mjs`，零依赖）：
- 新增 `WbCliKeyAdapter`（type='W'，`meta(){adapterType:'W', hasNativeSession:false, capabilities:['chat']}`）。
- `createAdapter` 的 W 分支：若 `config.apiKey || config.cliKey || process.env.CODEBUDDY_API_KEY` 非空 → `new WbCliKeyAdapter(agent)`，否则维持原 `WbAcpAdapter`（RC 回退，零回归）。
- `send(msg)`：`spawn(process.execPath, [cliPath, '-p', prompt, '--output-format','json', '--model', model, '--permission-mode','bypassPermissions', '--no-session-persistence'], { env: cliEnv(key, internetEnv), cwd, stdio:['ignore','pipe','pipe'], windowsHide:true })`，读 stdout JSON → `extractCliReply()` 提取文本+usage → 回群。复用模块级 `guardrail()` 四类拦截（与 RC 通路共用，已去重）。
  - 三个**必须**的细节（否则静默挂死，见下方 live 验收）：① 用 `process.execPath` 起脚本，**不能**直接 spawn `cliPath`（它是 node shebang 脚本、无 `.cmd` 包装，Windows 下不可执行）；② `env` 走 `cliEnv()` 白名单，**不能**用 `{...process.env}`；③ `stdio[0]='ignore'` 关掉 stdin，print 模式否则会一直等输入。
- `describeProbe` 的 W 触发条件扩展为 `acp|wbAcp|apiKey|cliKey|cliPath|(host&&port)`。
- `server.mjs` 新增零依赖 `loadDotEnv()`：启动期读根目录 `.env`（git-ignored）注入 `process.env`，让 key 走文件而非 shell env；已建 `.env.example` 模板 + `.gitignore`（忽略 `.env`，防泄露）。

**启用方式（二选一，重启 achat 生效）**：
1. 根目录 `.env` 填 `CODEBUDDY_API_KEY=<key>` + `CODEBUDDY_INTERNET_ENVIRONMENT=internal`（推荐，文件即生效，不进 git）；
2. 或给 workbuddy agent 的 `config` 加 `"apiKey":"<key>"` + `data.json` 存盘（`createAdapter` 读 `config.apiKey`）。
两种都让该 W 类 agent 自动切到 cli-key 通路；不设 key 时维持原 RC 通路不变。

**边界（诚实记录）**：
- key "仅用于模型接口调用"——驱动 CLI 模型对话，非完整平台接口；achat 要的正是模型对话回群，够用。
- 中国版必须 `CODEBUDDY_INTERNET_ENVIRONMENT=internal`。
- key 敏感：绝不进仓库/记忆明文（`.env` 已 git-ignored；注意本项目当前尚未 `git init`，`.gitignore` 是提前备好的）。

##### live 验收（2026-09-02 ✅ 通过，产品负责人提供真 key）

**结果**：群 `mtjokg0se8od3i [workbuddy]` 投递「读当前目录 package.json 的 name/version 真实值」→ **5 秒回复** `name=zjl-achat, version=0.0.1`，与文件实际内容逐字一致（非幻觉）。反向安全验证：要求读 `.env` → 被 `guardrail()` 拦截、未转发给 CLI。**cli-key 通路的对话能力 + 文件工具能力 + 护栏 三者同时确认为真。**

裸 CLI 单次调用实测：`duration_ms=2972`，`input_tokens=23512 / output_tokens=7`。⚠️ 输入 token 偏高是因为 CLI 每次都装载完整系统提示 + 工具表；纯闲聊场景可用 `--tools ""` 砍掉工具表省 token（代价是失去文件能力，未默认开）。

**踩到并修掉的两个真 bug（原「端口冲突」判断被推翻）**：

1. **静默挂死的真根因 = 环境变量污染，不是端口本身。**
   achat 若从 WorkBuddy 桌面端内部启动，会继承桌面端注入的一批会话变量：
   ```
   CODEBUDDY_SERVICE_PROXY_URL=http://127.0.0.1:60314/internal/hooks/services/invoke
   CODEBUDDY_GATEWAY_AUTH=password / CODEBUDDY_GATEWAY_PASSWORD=***
   CODEBUDDY_MCP_CONFIG={...含 connector-proxy 地址与会话 token...}
   CODEBUDDY_SESSION_ID / CODEBUDDY_CONVERSATION_REQUEST_ID / ...
   ```
   子进程 CLI 一旦继承，就认为自己处于"桌面端托管态"，去 `listen` 桌面端已占的端口（实测 60314 属 `WorkBuddy.exe` PID 6068）→ `EADDRINUSE` → **unhandled rejection → 进程永久挂住且零输出**（正是之前 150s 超时、日志全空的现象；旧记录里的 53126 是同一现象的另一个端口值，端口会随桌面端会话变）。
   修法：`cliEnv()` 只透传 `PATH/SystemRoot/TEMP/USERPROFILE/LOCALAPPDATA/...` 等白名单系统变量，再注入 `CODEBUDDY_API_KEY` + `CODEBUDDY_INTERNET_ENVIRONMENT`（+ `CODEBUDDY_SKIP_GIT_BASH_CHECK`），其余 `CODEBUDDY_*` 一律丢弃。改后同一调用 ~3 秒返回。**副作用红利：桌面端的会话 token / MCP 凭据也不再泄进子进程。**

2. **`--output-format json` 的真实形状是 JSON 数组，不是对象。**
   实测 stdout = 事件数组，回复在末尾元素：
   ```json
   [ {"type":"message",...}, ...,
     {"type":"result","subtype":"success","is_error":false,
      "result":"cli-key 通路已连通","duration_ms":2972,
      "usage":{"input_tokens":23512,"output_tokens":7}} ]
   ```
   原 `extractCliReply` 按对象取 `j.result` → 数组下恒为 `undefined`，会一路回「CLI 未返回文本」。已改为倒序找末个 `type==='result'`，返回 `{text, usage, isError}`；`is_error` 时回群显式报错而非静默空。

**回归**：`scripts/_probe_w_clikey.mjs` 从 9 条扩到 **24 条全绿**——新增 7 条覆盖数组解析/`is_error`/裸对象/纯文本/空输入，8 条覆盖 `cliEnv()` 不泄漏 `SERVICE_PROXY_URL`/`GATEWAY_PASSWORD`/`MCP_CONFIG`/`SESSION_ID` 且只注入 3 个 `CODEBUDDY_*`。

#### 8.6.3 DSH 探测脚本结论收敛（2026-09-02 ✅ 已收敛）

**脚本来源**：`scripts/` 下 `capability-probe` / `session-visibility-probe` / `approve-loop` / `approve-via-post` / `approve-verbose` / `approve-then-resume` / `duplex-perm-test` / `duplex-http` / `main-approve-loop` / `probe-methods` / `init-discover` / `asar-*`（diag/find/dump/extract/fix/ls/read）。DSH 为摸清 achat 如何驱动 WorkBuddy ACP 而主动安排，等于"第三方 agent 测第三方 agent"，把边界踩实。

**结论一：headless 会话能力为真，但 UI 不可见（呼应 §8.6.1「隐形非无会话」）**
- `capability-probe.mjs`：令 ACP 实例读 `D:/Projects/zjl-achat/package.json` 的 name 字段；脚本逐行解析 `agent_message_chunk` + `tool_use` 事件，确证 WorkBuddy **真调了文件工具、真读到了 name=“zjl-achat”**（非编造）。
- `session-visibility-probe.mjs`：对新建会话试 `session/list|find|get|read|list_recents`——**绝大多数返回 `-32601 method not found`**（不存在枚举接口）；再发测试 prompt 看 UI 是否反应，用以证"驱动成功但 UI 无新会话"是 headless **隐形**，非"无会话"。
- 组合结论：ACP 提供的是**后端驱动面**，**不暴露会话枚举、不在 UI 渲染标签页**；achat 要的正是这个"后台真身会话"，UI 可见性不是必要条件。

**结论二：ACP 权限批准协议 = 事件 + 按 id 独立 POST 回响应（非 method 调用）**
- 批准形态：`session/request_permission` 事件携带 `params.toolCall._meta['codebuddy.ai/toolName']` + `rawInput.file_path` + `options`；客户端用**独立 POST** 按该事件 `id` 回 `{jsonrpc:'2.0', id:<evId>, result:{outcome:{outcome:'selected', selectedOptionId:optionId}}}`。
- `approve-loop.mjs`：循环捕获所有 `request_permission` 并逐个批准，证 default 模式工具调用获批后能**继续产出回复**（stopReason=end_turn）。
- `main-approve-loop.mjs`：主窗口实例完整闭环——`session/set_config_option`(configId:'mode',value:'default') 切默认模式 → 触发不可信写 → 收到权限事件 → 独立 POST 批准 → `fs.existsSync(target)` 验证**文件真实落盘**。这是"GUI 批准 + 回群"端到端可行性的铁证。
- `approve-via-post.mjs`：专门隔离验证"**独立 POST 携带 JSON-RPC 响应**"才是真路径。
- `duplex-perm-test.mjs` / `duplex-http.mjs`：尝试在同一条连接 / 同一 request stream 上回写批准（duplex，仿官方 SDK 双向 HTTP）——**证实 duplex 不可靠**，独立 POST 才是被服务端采纳的批准通道（与 `WbAcpAdapter` 当前实现一致）。
- `approve-verbose.mjs` / `approve-then-resume.mjs`：旁证——批准后**同会话 resume 能 recall 刚才读取的结果**，证明 human-approve → WB 执行 → 结果回收 的闭环稳定。

**结论三：候选 method 名几乎全不存在，无需解包 asar**
- `probe-methods.mjs` / `init-discover.mjs`：暴力枚举 `session/approve`、`tool/approve`、`session/permission`、`session/respond`、`session/answer`、`session/cancel`、`session/load`、`config/set` 等 15~25 个候选——**绝大多数是 `-32601 not found`**；真正批准路径是结论二的"事件 + 按 id 回响应"，**没有传统 method 入口**。
- `asar-diag.mjs` / `asar-find.mjs` / `asar-dump` / `asar-extract` / `asar-fix` / `asar-ls` / `asar-read`：解析 WorkBuddy `app.asar` 头结构（定位 `{"files"...}` 偏移、抽取 `cli/dist/web-ui/docs` 下 acp/permission 文档）——**结论：对 achat 而言完全无需解包 asar**。公开 ACP 表面（connect → initialize → session/new → session/prompt + `session/request_permission` 事件 + 按 id 独立 POST 回响应）已覆盖 100% 需求，asar 内部文档是冗余信息。
- 残留 `asar-*` 脚本仅作"万一将来要改更底层权限模型"的考古备档，**当前架构不依赖**。

**对 achat 的落地影响**：
- `WbAcpAdapter` 现有实现（捕获 `session/request_permission` → 按 id 独立 POST 批准 → 轮询 `agent_message_chunk` 累积 `content.text`）**与 DSH 实测结论完全一致**，无需改动。
- achat 已用 `bypassPermissions` 免审批模式跑（见 §8.6.1 护栏），权限事件路径在当前配置下不触发；但批准协议已验证存在，若将来切 default 模式（需 GUI 批准闭环）可直接复用，不踩坑。
- 探测脚本全部保留在 `scripts/` 仅作"第三方可复测"证据链，**不进生产运行路径**。

---

## 9. 数据契约（核心实体）

### 9.1 实体

```
Group {
  id, name,
  members: AgentCard[],
  settings: { allowDM, voiceInput, multimodal, ... },
  context: ContextHub,                 // 本群上下文真源（§6.5）
  sessions: { [agentId]: nativeSessionId | null }  // 仅原生镜像用, 可选
}

ContextHub {                          // 群空间「上下文」标签数据
  brief: string,                      // 项目简介/目标/约束（可编辑）
  sources: ContextSource[],           // 原始资料：上传文件/链接/笔记
  decisions: string[],                // 沉淀的关键决策
  updatedAt
}
ContextSource {
  id, kind: file|link|note,
  ref, name, ts
}

Agent {
  id, name, vendor, logo,
  adapterType: A|B|C|D|E|F,
  config: { apiBaseUrl? | modelProvider?+key | binaryPath?+headlessCmd | localDir? | mcpServer? | protocol? },
  status
}

Message {
  id, groupId, senderId,        // senderId = user | agentId
  kind: text|artifact|typing|system,
  content, artifacts?: Artifact[],
  ts
}

Artifact {
  id, groupId, producerId,      // 谁产出 -> 分色标签
  type: image|doc|code|other,
  path, name, ts
}

Task {                          // 异步任务，关联消息与产物
  id, agentId, groupId,
  state: pending|processing|done|failed,
  resultText?, artifactIds?
}
```

### 9.2 后端 API（从现行 UI 反推，UI 调用即后端契约）

```
listGroups()  getGroup(id)  createGroup(name)
renameGroup(id, name)  setGroupMembers(id, agentIds)
archiveGroup(id)              // 完结归档（status: active<->archived）
deleteGroup(id)
sendMessage(groupId, {content, toAgentId?})   // toAgentId 空=广播，否则定向/私信
listAgents()  updateAgent(id, config)  addArtifact(groupId, file)
setAgentStatus(id, status)   // online | running | idle | offline
launchAgentWindow(id)        // 拉起本地 GUI 主窗口（生命周期层）
openDM(agentId)              // 私信会话
事件（SSE）： message / typing
```
> 现行 `public/app.js` 已用 mock 实现以上调用（含归档/删除/状态/拉窗），后端只需实现同名接口，UI 零改动。

---

## 10. 前端三栏 UI 规格

沿用 agent 产品既有三栏惯例（已出可点原型 `public/index.html`）：

- **左栏**：新建群、群列表（成员头像，悬停出现 ✎重命名 / 📥完结归档 / 🗑删除，归档群降低灰显）、底部「⚙设置·agent 配置/接入」页。
- **中栏**：群聊主体；**左键点头像**弹「agent 状态信息卡」（显示 online/running/idle/offline 状态点 + 可改名称/类型/模型/角色/提示词）；**右键点头像**弹上下文菜单（⚙agent 设置 / 🪟拉起主窗口，仅本地 GUI agent 有 guiPath 才拉得起）；指定 agent 私信；发送对象下拉（全群/指定）；🎤语音（占位）；➕上传菜单（文件/图片/视频/音频）。
- **右栏**：群空间，分标签——**上下文**（本群上下文真源：编辑 brief、增删 sources、标记 decisions，开单 agent 会话时整包注入，见 §6.5）、**概览**（产物总数/按来源分色 pill/按类型/全量列表）、**文件**、**图片**、**音视频**、**项目代码树**（mock 目录树）、**浏览器**（嵌入 agent 产出的本地/内网 URL 占位）；产物按来源分色标签（谁上传/产出分不同颜色），支持上传。

发消息后模拟 agent 回复 + 打字指示，直观感受多 agent 协作节奏。

---

## 11. 技术选型（MVP）

| 层 | 选型 | 说明 |
|---|---|---|
| 前端 | 纯静态 HTML/CSS/JS（现状） | 双击 `index.html` 即可看，mock 数据验证交互 |
| 后端 | Node.js（ESM，零依赖起步） | `server/` 已有骨架（agents/store/server.mjs） |
| 通信 | REST + SSE | REST 下发指令，SSE 推流式回复/打字 |
| 存储 | JSON 文件（MVP） | 群/消息/产物落盘，后续可换 SQLite |
| agent 调用 | fetch / 子进程 spawn / Typert RPC | 依适配器类型而定 |

---

## 12. 落地路线图

| 里程碑 | 内容 | 状态 |
|---|---|---|
| **M0** | 三栏 UI 原型（mock，可点） | ✅ 已完成 |
| **M1** | 总线 + API Adapter（DSH 样板）+ Model Adapter（DeepSeek 扮演）跑通端到端 | ✅ 已完成（2026-08-31，验收 15/15） |
| **M2** | 生命周期层：通用 launcher 开关层（开→拉起服务 / 关→杀服务）+ 健康检查 | ✅ 已完成（2026-09-02，详见 §7.2.1） |
| **M3** | Bridge Adapter（文件桥）+ 启动器/哑监控（launcher/monitor，零 LLM 传输层） | ✅ 已完成（2026-08-31，真实验证全自动闭环） |
| **M4** | 能力探针自动选型 | ✅ 已完成（2026-09-02，describeProbe 自动选型 + API，详见 §6.3.1） |
| **M5** | 协议/桌面类适配器：MCP（E）+ Protocol（F，A2A/AG-UI）+ Desktop GUI（D，Launch+File） | ✅ 已完成（2026-09-02，六类适配器全部真实落地，详见 §6.3.2 / §6.3.3 / §6.3.4） |

> 建议顺序：M1（先跑通一个真 agent）→ M2（无窗口托管）→ M3（闭源桥接）→ M4（自动选型）。

---

## 13. 风险与开放问题

| 项 | 状态 | 说明 |
|---|---|---|
| DSH 桌面版端口 | ✅ 已解决 | Web profile 实测 3080；适配器双端口探测 `[3080, 43120]`（见 §7.4） |
| DSH Typert RPC 细节 | ✅ 已探明 | 端点 `POST /api/<method>`，四元组 wire 格式（见 §7.4） |
| DSH 完整对话流 | ✅ 已实测 | A 类适配器端到端跑通，含多轮会话连续性验证（见 §7.4） |
| 闭源云产品桥接脆性 | 已知风险 | 文件桥最稳，UI 自动化仅作 hack 通道 |
| "真窗口进群" | 行业空白 | 仅对可控 web agent（DSH 类）做 L3，闭源产品不追求 |
| 多 agent 协调策略 | 待定 | 广播/定向/协商三模式，M1 先实现广播+定向 |

---

## 附：与 Mnemo 的关系

- Mnemo 已**搁置**，非删除，代码可作参考（尤其写入归属 / 可见性门控函数）。
- zjl-Achat 是产品本体；记忆能力若未来需要，可作为某个 agent（如北辰扮演）的能力，而非独立基础设施。

---

## 附 2：M1.5 实时状态与可中断执行（2026-08-31）

### 状态模型

每个 agent 在 `server/runtime.mjs` 里维护一份**内存态**（进程重启即重置，符合"agent 是否在线本来就要重新探测"的语义）：

| 状态 | 灯 | 含义 | 触发 |
|---|---|---|---|
| `busy` | 红（闪） | 有 turn 在跑 | `beginTask()` |
| `error` | 黄 | 上一次 turn 失败 | `endTask(err)` |
| `idle` | 绿 | 可达、空闲 | turn 成功结束 / 心跳探测通过 |
| `offline` | 全灭 | 适配器不可达 | 心跳探测失败（无 key / DSH 端口不通） |

- **一个 agent 同时只跑一个 turn**：`beginTask()` 在已 busy 时返回 `null`，总线直接回一条「正忙，本条已跳过」。
- 心跳探测每 20s 一轮，**跳过 busy 的 agent**（否则会把红灯刷成绿灯）。

### 中断通路

```
POST /api/agents/:id/abort
  -> runtime.abort()  -> AbortController.abort()
       ├─ B 类 ModelAdapter: fetch 带 signal，连接直接断开
       ├─ A 类 DshAdapter:  轮询循环 sleep(1000, signal) 立即 reject
       └─ onAbort 钩子 -> DshAdapter.cancel() -> DSH RPC session.cancel {sessionId}
  -> bus 的 catch 分支写一条「已中断」消息，endTask 回到 idle
```

**A/B 两类都是真中断**：

- B 类：HTTP 连接断开，服务端停止生成。
- A 类：除 achat 侧停止轮询外，还由 `onAbort` 钩子回调 DSH 的 `session.cancel`，DSH 服务端终止当前 turn（2026-08-31 实测，见下表）。

### 工具过程可见（tool trace）

DSH 的事件流映射到 achat 中间态事件，经 SSE 的 `tool` 通道推给前端，渲染在打字气泡下方：

| DSH 事件 | achat 事件 | 前端显示 |
|---|---|---|
| `step/start` | `kind:'step'` | 暗色「步骤 N」 |
| `tool/call` | `kind:'tool_call'` | `⟳ 工具名 · 关键参数`（转圈） |
| `tool/result` | `kind:'tool_result'` | 按 callId 找到那一行，转圈换成 `✓` |

- 行的 key 是 `callId`，所以 result 能精确勾掉对应 call（不是追加一行新日志）。
- 列表上限 40 行，超出从头部丢弃——长 turn 不能无限增长。
- 打字气泡消失后（turn 结束）事件直接丢弃，不留残影。

「改内容重发」= 中断 + 把原 prompt 回填输入框 + 发送目标定向到该 agent，用户改完回车即重发。

### 实测能力：不问，直接量

CodexHost 的 `inspect()` 思路是"问 agent 你会什么"。**DSH 没有这个接口** —— `capabilities` / `tools.list` / `skills.list` / `agent.list` / `preset.list` 全部 `not found`，连 `system.info` / `version` / `ping` 都没有（2026-08-31 逐个探测确认）。

所以反过来做：**不问，直接量**。上一步做的工具事件流里已经带着答案了。

```js
// bus.mjs: every tool/call the agent makes is tallied as it streams past
onEvent: (ev) => {
  if (ev.kind === 'tool_call' && recordTool) recordTool(agent.id, ev.name);
  emit('tool', { convId: conv.id, agentId: agent.id, ...ev });
},
```

计数落在 `store.toolStats`（`data.json` 里持久化，跨重启保留），`GET /api/agents` 返回 `observed` 字段。

实测结果（2026-08-31）：

```
before:     {}
after 读文件: {"read":1}
after 列目录: {"read":1,"glob":1,"pwsh":1}
```

**DSH 的真实工具集是 `read` / `glob` / `pwsh` / `job_output`，而硬编码的 `skills` 写的是 `['research','coding','review']`** —— 两者完全不是一回事，正好证明手写标签是假数据。

设置卡片现在分两行：**已装技能**（人工声明，可点切换）vs **实测能力**（只读，带实际调用次数，按次数降序）。空则显示「尚无记录」，不猜。

> 判断修正：能力探测（P1）在 achat 这里**没有 RPC 数据源**，硬做只能造假。改成"观察法"后既不需要 agent 配合，数据还是真的。

### store 写入加固

`store.mjs` 的 `save()` 从 `writeFileSync(DATA)` 改为 **tmp + rename 原子写**，并维护 `revision` / `savedAt`：

- 写入中途崩溃不再产生半截 JSON（原实现会让**全部会话**读不出来）
- 检测到 `data.json` 被外部改动（mtime 变化）时先合并再写，按"消息多的一方为准"
- 读取失败时把损坏文件重命名为 `data.json.corrupt`，不静默丢数据

> 关于 CodexHost 的 `revision` 乐观锁：achat 是单进程同步写，**不存在后写覆盖前写**，真正的风险是半截文件，故只取原子写 + revision，不引入乐观锁重试。

### 实测记录（2026-08-31）

| 用例 | 结果 | 证据 |
|---|---|---|
| 状态流 SSE（`/api/agent-status`） | ✅ snapshot + busy/idle 增量推送，带 preview 与 convId | `snapshot beichen=idle dsh=idle invest=idle` |
| B 类并发（北辰 + 投资研究） | ✅ 685ms / 741ms 完成，状态 busy→idle 正确 | 两条消息各自落盘 |
| 工具事件流 | ✅ step → tool_call → tool_result 顺序到达 | `step 1` `CALL read :: …/package.json` `done <path>…` `step 2` |
| A 类**真**中断（DSH） | ✅ abort 后 DSH 侧 running 立刻转 false | 见下方时间线 |
| 非执行中 abort | ✅ `ok:false` + 原因，不报错 | 任务 2.6s 跑完后再 abort 得到 `{"ok":false,"note":"该 agent 当前不在执行"}` |
| 多轮会话不误判 | ✅ 同 session 第二轮不会被上一轮 `turn/end` 误判完成 | 第二轮 1.0s（= 首个轮询周期）返回正确答案，不是 0s 空回 |

**真中断时间线**（`node scripts/verify-runtime.mjs dsh 6000`）：

```
 0.1s  baseline busy: []
 0.1s  [status] dsh -> busy
 3.2s  running -> ["session-2e4151a1-a100-4aca-a9ad-da7f2fc3682d"]   <- DSH 自己报 running=true
 3.2s  [tool] CALL pwsh :: ping -n 60 127.0.0.1
 4.2s  [tool] CALL job_output :: {"job_id":"pwsh-2","timeout_ms":80000,"wait":true}
 6.2s  --- ABORT ---
 6.2s  abort -> {"ok":true,"note":"已发送中断信号"}
 6.3s  [msg] [DSH] 已中断
 6.3s  [status] dsh -> idle
 7.8s  after abort -> []        <- DSH 侧真的停了
16.0s  after abort -> []        <- 之后 18s 内一直是空，ping 本应跑到 60s
```

判据是 **DSH 自己 `session.list` 里的 `running` 字段**，不是 achat 单方面"不等了"。

> 顺手修掉一个没暴露的隐藏 bug：原 `send()` 用 `lastSeq` 初值 `-1` 判断 `turn/end`，多轮会话时上一轮的 `turn/end` 仍在 history 里会被立即误判为本轮完成（之前没暴露只因 `maxMessages:60` 碰巧截断）。现改为 `currentSeq()` 取当前最大 seq 作基线，只处理 `seq > cursor` 的事件，`maxMessages` 提到 200。

### 启动方式

```powershell
cd D:\Projects\zjl-achat
powershell -ExecutionPolicy Bypass -File .\start.ps1
```

脚本自动从 `C:\Users\wsx\.opencodereview\config.json` 取 `llm.auth_token` 注入 `DEEPSEEK_API_KEY`（不落盘）、占用端口时先停旧进程、启动后做健康检查。

回归验证（需 achat 在 8787、DSH 在 3080）：

```bash
node scripts/verify-runtime.mjs [agentId] [abortAfterMs]   # 默认 dsh / 6000
```

它会给目标 agent 发一个 60 秒的长任务、中途 abort，然后盯着 DSH 的 `running` 标志确认服务端真的停了。改动 runtime / adapters / bus 后跑一遍。

### 明确不做（探明无数据源，别再回来试）

借鉴 CodexHost 的五点里，有两项在 achat 当前环境下**做不了，不是偷懒**：

| 项 | 为什么做不了 | 替代方案 |
|---|---|---|
| **interaction 那一半**（agent 举手提问 → 人点同意的交互卡） | DSH 确实有 `approval/policy: {"policy":"ask"}`，但实测只读命令和写文件**都自动放行**，不产生待审批事件；也没有 `approval.list` / `approval.pending` / `approval.respond` 之类查询方法 | 无。等 DSH 暴露 pending 审批状态 |
| **能力探测 `inspect()`**（问 agent 你会什么） | `capabilities` / `tools.list` / `skills.list` / `agent.list` / `preset.list` / `system.info` 全部 `not found` | 已改为**观察法**：统计实际 `tool/call` 事件（见上文「实测能力」） |

两项被探测为 `not found` 的方法全集（省得下次重探）：

```
turn.cancel  approval.list  approval.pending  approval.respond  approval.resolve
session.approve  tool.approve  methods.list  skills.list  capabilities  tools.list
agent.list  preset.list  sandbox.info  system.info  server.info  meta  instance.info
session.stats  status  ping  health  info  version  config.get
```

**其余两项仍未动**：

- **进程租约**（PID + 启动时间戳）：DSH 没有实例标识 RPC，拿不到权威指纹。且当前探测是发真实 RPC 并校验返回结构，端口被别的程序误占却还能对上协议的概率极低。**租约真正想防的那个场景（DSH 重启后旧 `sessionId` 失效）已用更直接的办法解决，见下节。**
- **委派技能**（agent 自己喊人）：需要 agent 侧有委派能力，DSH 目前看不出来有，先不做。

### 群上下文：让"群"真的成立

**问题（实测确认）**：三人群里，DSH 看不到另外两个 agent 说过什么。

让北辰说一句「斑马代号ZEBRA-7749」，再问 DSH 那串字符是什么，它答：

> 我看不到。我没有访问任何群聊记录……会话中并没有出现来自任何名为「北辰」的成员的消息

**根因两处**：

1. `DshAdapter.send()` 只取 `lastUserText(messages)` —— 群里其他成员的发言全被丢掉。DSH 的 session 里只有它自己的回合，所以对用户来说它是"群聊"，对它自己来说是单聊。
2. `agent.system`（人设）**从来没传给过 DSH**，agents.mjs 里给 DSH 写的角色设定一直是空转。

顺带还有一处：B 类拿到的上下文里，所有 agent 的发言都是裸的 `assistant` 角色，**模型分不清哪句是谁说的**。

**修法**：

| 位置 | 改动 |
|---|---|
| `bus.buildContext(conv, agentId, agents)` | 其他成员的发言**折叠成 `user` 角色的 `[群内其他成员的发言]` 背景块**；自己的发言保持 `assistant` |
| `bus.peerLines(conv, agentId, agents)` | 抽出目标看不到的部分：最近 10 条 / 2000 字以内的其他成员发言 |
| `bus.rosterFor(agentId)` | 成员名单里给目标自己的座位标 `（你）` |
| `DshAdapter.send()` | `session.prompt` 只有一个文本块，所以把人设和群友发言折进文本：`[你的角色]` / `[群成员]` / `[群内其他成员的发言]` / `[用户对你说的话]` |

只补"DSH 看不到的那部分"—— 用户的话和它自己的话都在它 session 里，不重复注入。

**⚠️ 走过的弯路：群友发言绝不能留在 `assistant` 通道**

第一版是「给群友发言加 `[名字]` 前缀，但保持 `role:'assistant'`」。结果模型把那些话当成**自己说过的话**，开始逐字复述上一条群友回复：

```
北辰:    [DSH] 本群有投资研究、北辰和我（DSH）三位成员。
投资研究: [北辰] 本群有投资研究、北辰和我（DSH）三位成员。   ← 原封不动抄北辰的
```

根因：`assistant` 通道在模型眼里等于"我的输出历史"，放什么进去它都认领。**必须降权到 `user` 角色的背景块**，并在 system 里说清那不是它说的：

```js
// adapters.mjs - B 类 system 提示
`你在群聊里，当前成员：${roster.join('、')}。其他成员的发言会作为「[群内其他成员的发言]」背景提供给你，那不是你说过的话，不要复述、不要模仿、也不要带名字前缀，直接回答用户的问题。`
```

**⚠️ 第二个坑：名单里不标"你"，agent 会把自己数两遍**

roster 一开始是纯名单，投资研究答：`群里有北辰、DSH和投资研究，加上我共四位。` —— 三人群数出四个人。加 `（你）` 标注后：`北辰和DSH。`

```js
// bus.mjs - mark the target's own seat
const rosterFor = (agentId) =>
  (conv.memberIds || []).map((id) => nameOf(id) + (id === agentId ? '（你）' : ''));
```

**验证方式**：`tmp-fresh.mjs`（已删）—— **必须建全新群跑，不能用老会话**。老会话里存着大量正常回复，坏样本会被"历史稀释"得看起来像修好了。脚本判据：`/^\s*\[/` 命中即 ECHOED。

**修复后同一测试**：DSH 准确引用出「斑马代号ZEBRA-7749」；全新群里三个 agent 全部 CLEAN 且人数正确：

```
CLEAN   投资研究: 北辰和DSH。
CLEAN   北辰: DSH和投资研究，就咱仨。
CLEAN   DSH: 群里有你、我，还有投资研究。
VERDICT: no prefix echo
```

### 会话存活检测（替代进程租约）

**要防的场景**：DSH 重启后端口不变、`session.list` 照样通，所以 `ping()` 依然报绿 —— 但 achat 缓存在内存里的 `sessionId` 已经死了。

**失效时的实际表现**（不是超时，是永久卡死）：`session.prompt` 立刻抛 `session-not-found`，而 `sessionId` 一直缓存在 adapter 实例里，**之后每一条消息都以同样的报错失败**，只能重启 achat 才能恢复。

DSH 给的检测信号很干净，`history` / `prompt` / `cancel` 对无效 id 都返回 `{"code":"session-not-found"}`，所以修复很直接：

```js
// adapters.mjs - verify before relying on a cached session
async ensureSession(signal) {
  if (this.sessionId) {
    try {
      await this.rpc('session.history', { sessionId: this.sessionId, maxMessages: 1 }, signal, 3000);
      return this.sessionId;
    } catch (e) {
      if (e.code !== 'session-not-found') throw e;  // real failure, don't mask it
      this.sessionId = null;
      this.contextLost = true;                      // next turn starts with no history
    }
  }
  const created = await this.rpc('session.create', { cwd: this.cwd }, signal);
  this.sessionId = created.sessionId;
  return this.sessionId;
}
```

`rpc()` 顺手把错误码挂到异常上（`e.code = err?.code`），调用方才能分辨"会话没了"和"网络抖动"。

**上下文丢失要告诉用户**。重建出来的会话没有历史，agent 会忘记之前聊过什么 —— 这是用户能感知的事。所以不新增第五种灯（绿灯"可达、空闲"依然是对的），而是在**命中那一轮**回一条系统消息：`[DSH] 会话已重建，之前的上下文丢失`。

实测（2026-08-31，把 `sessionId` 设成死值模拟 DSH 重启）：

| 用例 | 结果 |
|---|---|
| 死 session id | ✅ 2.2s 内检测并重建，`contextLost: true`，正常回答 |
| 同一个 adapter 再发一条 | ✅ `contextLost: false`，复用同一 session，无误报 |
| DSH 完全不可达 | ✅ 抛出 `DSH 未运行（已探测端口 …）`，未被误判成会话失效 |

### @ 定向与委派：让成员能互相喊人（2026-08-31）

群上下文通了之后，成员能**看见**彼此，但还不会**找**彼此。此前只有前端下拉选择的 `toAgentId` 定向，agent 在回复里写 `@北辰` 不会触发任何路由。

**两件事，成本完全不同，因此策略不同：**

| 能力 | 触发者 | 成本 | 默认 |
|---|---|---|---|
| **@ 定向** | 用户 | **省** —— 三人群从 3 次调用降到 1 次 | 开 |
| **委派** | agent | **贵** —— 每次点名多一轮 LLM 调用 | **关**（opt-in） |

**@ 定向**（`bus.resolveTargets`）：显式 `toAgentId` 优先；否则解析**最新一条消息**里的 `@名字`。命中就只发给命中的人，没命中才广播。候选人只从 `memberIds` 取，所以 `@` 出现在邮箱、装饰器、正文里都不可能凭空造出目标。

```js
// Longest name first, and blank out each hit as it is found: otherwise a short
// name consumes a longer one ("@北辰" would match inside "@北辰辰").
cands.sort((x, y) => y.n.length - x.n.length);
...
rest = rest.slice(0, i) + ' '.repeat(at.length) + rest.slice(i + at.length);
```

**委派**（`bus.delegate`）：agent 回复里 @ 了谁，就把谁拉进本轮。**两道闸，都不能省**：

1. **opt-in** —— `settings.delegation`，落盘持久化。不设闸的话，一个爱社交的模型会把每句话都变成群聊大会。
2. **深度上限** `MAX_DELEGATION_DEPTH = 1` —— A@B、B@A 是无限的账单。一层意味着被点名的人可以回答，但**不能再点名**。

自我点名（`id === m.agentId`）也一并丢弃。

**委派 gesture 只在会被响应时才教**（`allowDelegate: settings.delegation && depth < MAX`）—— 最后一跳的 agent 不该学一个点了也没用的手势。

**⚠️ 注入文案里「何时不用」那一半才是重点**（抄自 CodexHost 拆解里的教科书细节）：只说"你可以 @别人"，模型会滥用。必须写清负例：

```
你可以点名其他成员：回复里写 @他的名字（例如 @北辰），他会在你之后接着回答。
但以下情况不要点名——你自己就能回答的、只是顺带提到某人的、闲聊或确认类的。
每次点名都会多花一轮，只在真的需要他的专业能力时才用，一条回复最多点名一个人。
```

开关 UI 上也把代价写在旁边（「每点名一次多花一轮调用，只传递一层，不会来回踢皮球」）—— 一个默默花钱的开关不是好开关。

**实测（2026-08-31）**：

| 用例 | 结果 |
|---|---|
| `@北辰 …`（三人群） | ✅ 只有北辰回答（1 条） |
| 无 @ | ✅ 三个都回答 |
| 委派关闭时 agent 回复含 `@DSH` | ✅ DSH 不动 |
| 委派开启 | ✅ DSH 被接上，消息带 `delegatedBy: beichen` |
| 深度上限 | ✅ DSH 只答 1 次，无 ping-pong |
| 自我点名 | ✅ 未触发 |

**回归成本提示**：`scripts/test-mentions.mjs`（零成本，14 个 case 覆盖长名吃短名 / 邮箱 / 装饰器 / 群外成员）覆盖解析逻辑；端到端那部分**烧真实 token，跑一次就删**，不进 scripts/ —— 判据记在本节表格里。

### 离线灯：从"配了 key"改成"真的连得上"（2026-08-31）

**发现的 bug**：B 类（`ModelAdapter`）的 `ping()` 原本是 `return !!this.key` —— **只检查有没有配 key，从不验证 API 是否真的可达**。

后果：key 被吊销、额度用尽、DeepSeek 挂了、网络断了 —— 北辰和投资研究的灯**始终是绿色**。产品负责人要的四态是「干活 / 离线 / 空闲」，其中**"离线"对 3 个 agent 里的 2 个是假的**（只有 DSH 走本地 RPC，检测为真）。

**为什么当初这么写**：注释写的是"No network round-trip: a bare model API is 'up' as long as we hold a key"。动机没错（心跳 20s 一次，不能每次发请求），但**把成本问题和正确性问题混为一谈了**。

**修法：真探活 + 缓存，两件事分开解决**

```js
// Checking the key only proves it was configured, not that it works: a revoked
// or over-quota key would sit there green forever.
async ping() {
  if (!this.key) return false;
  const ttl = this.probeOk ? PROBE_TTL_OK_MS : PROBE_TTL_FAIL_MS;
  if (this.probeAt && Date.now() - this.probeAt < ttl) return this.probeOk;
  this.probeAt = Date.now();
  this.probeOk = await this.reachable();
  return this.probeOk;
}
```

- **探活端点用 `/models`** —— 最便宜且**依然要求有效 key**（假 key 实测返回 401，无 key 直接短路不发请求）。这就把"已配置"和"真能用"区分开了
- **TTL 非对称**：成功缓存 5 分钟，失败 30 秒后重试。网络抖一下能在半分钟内恢复绿，而不是卡 5 分钟红灯；稳态下每 5 分钟最多 1 次轻量请求
- **4s 超时**：探活绝不能拖住心跳循环

**实测（双实例对照，零数据改动）**：同一个 `data.json`，主实例 8787 用真 key，测试实例 8788 用垃圾 key（`PORT=8788 DEEPSEEK_API_KEY=sk-this-key-is-garbage`）：

| | 北辰 | DSH | 投资研究 |
|---|---|---|---|
| 8787 真 key | idle 🟢 | idle 🟢 | idle 🟢 |
| 8788 垃圾 key | **offline ⚫** | idle 🟢 | **offline ⚫** |

DSH 不受影响是**正确的**：它走本地 RPC，不依赖这个 key。

回归脚本 `scripts/test-offline.mjs`（零 token 成本，6 个 case）：垃圾 key 必须灭灯、无 key 短路不发包、**缓存必须生效**（第二次 `ping()` 0ms —— 缓存失效的话 20s 心跳就变成每 tick 一次真实请求）。

**成本结论**：心跳本身不烧 LLM token（B 类 `/models` 不计费，DSH 是本地 RPC），稳态每 agent 每 5 分钟 1 次轻量请求。

### 设置面板改了没反应：UI 字段与 adapter 字段不是同一批（2026-08-31）

**症状**：在设置面板改「模型」或「接入类型」，UI 显示改了、也没报错，但**完全不生效** —— 静默失败。

**根因**：UI 编辑的是**顶层**字段，adapter 读的是 `config.*`：

| 设置面板字段 | UI 写入 | adapter 实际读取 | 生效？ |
|---|---|---|---|
| 系统提示词 | `agent.system` | `agent.system` | ✅ |
| 模型 | `agent.model` | `config.model` | ❌ |
| 接入类型 | `agent.adapterType` | `config.adapterType` | ❌ |

最难发现的地方在于**两份数据的值是一样的**（`beichen.model = "deepseek-chat"`，`beichen.config.model = "deepseek-chat"`），所以看起来一切正常，只有真的去改才发现没反应。

**修法**：顶层字段优先，`config.*` 降级为遗留回退（`adapters.mjs` 的 `probeAdapterType` 与 `ModelAdapter` 构造函数）：

```js
if (agent.adapterType) return agent.adapterType;   // UI edits this one
if (cfg.adapterType) return cfg.adapterType;
```

**光改这个还不够** —— `bus.mjs` 用 `adapters` Map 缓存 adapter 实例，字段是在**构造时**冻结的，改完仍要重启才生效。所以 `PATCH /api/agents/:id` 后调用新增的 `dropAdapter(id)` 让下次调用重建。正在跑的那一轮持有自己的 adapter 引用，不受影响。

### 黄灯（error）对模型类 agent 是死代码（2026-08-31）

`ModelAdapter.send()` 在 HTTP 失败时**返回**错误文本而非抛出：

```js
if (!res.ok) { ...; return { text: `[${name}] 模型调用失败 HTTP ${res.status} ...` }; }
```

于是 `dispatch` 走**成功分支** → `endTask(agent.id)` → **idle（绿）**。结果：key 失效、模型名写错、额度耗尽 —— 灯全是绿的，**error 状态对 B 类 agent 永不触发**。

修法就是改成 `throw`（消息体里不写"调用失败"，因为 dispatch 的 catch 已经加了同样的前缀）。连带修了第二处：**心跳每 20 秒会把 error 重新刷成 idle**，黄灯闪一下就没了，等于白修。

```js
if (!alive) { setStatus(a.id, { state: 'offline' }); continue; }
// A failed turn has to stay visible ... Offline still wins.
if (getStatus(a.id).state === 'error') continue;
setStatus(a.id, { state: 'idle' });
```

优先级：**离线 > 上次失败 > 空闲**。离线压过 error（不可达比"上次失败"更重要），而在线时 error 保留到下一次成功调用才转绿。

**实测闭环**：`bogus model → HTTP 400 → error（黄）` → 心跳跑过仍是 `error` → 换回正确模型再发一条 → `idle（绿）`。不会永久卡黄。

### 顺带确认无问题的行为（实测）

「一 agent 同时只跑一个 turn」：正忙时后来的消息回「[DSH] 正忙，本条已跳过」，**且不会打断正在跑的那一轮**（状态全程 busy），abort 后正常回 idle。

**回归成本约定**：`scripts/` 下只保留**零 token 成本**的脚本 —— `test-mentions.mjs`（14 例，@ 解析）、`test-offline.mjs`（6 例，探活与缓存）、`test-store.mjs`（26 例，store 损坏/缺失/畸形数据的自愈）、`test-contrast.mjs`（状态灯四态对比度与相互可辨性）、`test-ask.mjs`（询问机制的跨 agent 通用性，14 例，覆盖模型类文本检测与 DSH 工具解析两种实现）。需要真实模型调用的验证（委派、配置生效、黄灯）跑完即删，判据与复现步骤记在本文档对应章节 —— 避免每次回归都烧钱。

`test-store.mjs` 有个硬约束值得说明：它**必须**在临时目录里跑（`store.mjs` 把 data.json 解析到自己旁边，所以整套测试靠"复制到新目录 = 新模块实例"来隔离）。这套用例会主动破坏文件，能吃到生产数据的测试比没有测试更糟。

### store 数据安全：会自愈，但自愈时一声不吭

data.json 是全部会话的**唯一存储**，原子写（tmp + rename）只保证"写的过程中崩了不会写坏"，不保证"文件本身坏了怎么办"。这块从没验过，所以真去破坏了一次。

**测法**：停服务 → 备份 → 往 data.json 写 31 字节垃圾 → 起服务 → 看它崩不崩。

| 检查项 | 结果 |
|---|---|
| 服务能否启动 | ✅ 正常起来，`/api/agents` 返回 3 个默认 agent |
| 坏文件是否被保留 | ✅ 改名 `server/data.json.corrupt`（31 字节原样保留） |
| 启动后状态 | `conversations=[]`、`settings` 默认值、`toolStats={}` |
| 能否继续写盘 | ✅ PATCH settings 后生成新 data.json（1942 字节） |
| 恢复生产数据 | ✅ 备份拷回 → 3 agent + 4 会话 + **72 条消息**全在，revision 134 |

**结论：自愈是好的，但它是静默的。** 用户回来只看到"会话列表空了"，没有任何提示，第一反应是"数据被删了"，而不是"数据文件坏了、副本还在旁边那个 .corrupt 里"。**能恢复和知道能恢复是两回事。**

**修法**：`load()` 的 catch 分支把恢复信息记到模块级 `recovered`，暴露 `store.getRecovery()` → `GET /api/notice`。前端 boot 时拉一次，非空就在聊天区顶部挂一条横幅：

```
⚠️ 检测到数据文件损坏，本次以空数据启动
   损坏的副本已保留为 server/data.json.corrupt，可以手工从中恢复。路径：D:/.../server/data.json.corrupt  发生时间：2026-08-31 12:01:42
```

横幅可手动关掉。改动落在 4 个文件：`store.mjs`（记录 + 暴露）、`server.mjs`（`/api/notice`）、`app.js`（`showRecoveryNotice()`）、`style.css`（`.notice-bar`）。

**二次实测**：坏数据 → `{"recovery":{"path":"...data.json.corrupt",...}}`，坏文件隔离成功；健康数据 → `{"recovery":null}`，横幅不出现。

> 顺带一个观察：`GET /api/conversations` 返回的是**摘要**（不带 messages），所以列表里 `msgs=0` 不是数据丢了。要取完整消息得单拉 `/api/conversations/:id`。第一次看时差点误判成恢复失败。

### 离线灯其实是看不见的（对比度 1.47:1）

修完状态机后回头核对灯的**渲染**，不是查逻辑而是查色值 —— 结果发现「离线」这个状态在屏幕上基本看不见。

`.traffic` 的灯座是 `#0b0e14`，而 `offline` **根本没有 CSS 规则**，于是三个点回落到基础色 `#2a3142`：

| | 色值 | 与灯座对比度 |
|---|---|---|
| 灯座 | `#0b0e14` | — |
| offline（修复前） | `#2a3142` | **1.47:1** ❌ |
| offline（修复后） | `#5a6478` | **3.25:1** ✅ |
| idle 绿 | `#22c55e` | 8.48:1 |
| busy 红 | `#ef4444` | 5.13:1 |
| error 黄 | `#fbbf24` | 11.57:1 |

非文本 UI 元素的 WCAG 下限是 3:1。**1.47:1 等于三个肉眼找不到的点** —— 而"哪个离线了"恰恰是这套灯存在的首要理由。讽刺的是：唯一没写规则的状态，正好是最该被看见的那个。

修法一行：`.traffic[data-s="offline"] i { background: #5a6478; }`。三颗全灰仍然读作"没点亮"，只是现在**读得出来**。

**这类 bug 代码审查抓不到** —— 没有规则不是错误，"少一行"在一百多行 CSS 里毫无存在感。所以把判据固化成了 `scripts/test-contrast.mjs`：解析 style.css，算每个状态对灯座的对比度，低于 3:1 就 FAIL，另外校验「未初始化态必须够暗」和「任意两态之间至少 1.25:1（4px 的点上红黄不能糊成一坨）」。

**已验证测试真的能抓住这个 bug**：把 offline 规则删掉重跑，立刻 `FAIL offline no rule -> falls back to unlit colour (invisible)`；恢复后 PASS。一个从没失败过的测试等于没测试。

### 一个待产品负责人定夺的尺寸问题（我没擅自改）

灯条在头像上的实际尺寸：三个 4px 的点 + 1.5px gap + 2px padding + 1px border = **21 × 9px**，而头像是 **24px**，且 `.on-avatar` 还 `right:-4px bottom:-4px` 往外偏。

**灯条宽度约为头像的 88%，压在右下角并探出边缘。** 数值上偏大，但**我无法在本机渲染验证**（Chrome headless 在此环境被 SIGTERM，`agent-browser` 也没装 Chromium），所以只把精确尺寸画出来，没有擅自改设计。

两个方向供选：**保持现状**（横排三灯，辨识度高但占地方）；或**头像上改用紧凑版**（去掉 border/padding、点缩到 3px，或改竖排），更像"小标点"。

### agent 主动询问：契约层一等能力，跨 agent 通用

产品负责人的纠正（2026-08-31）：*"不能换个 agent 就又要从头再来，要站在产品角度，不能工程师角度遇到一个问题解决一个问题。"*

最初"询问"只按 DSH 的行为反推实现——DSH 有 `ask_user_question` 工具会挂起 turn，于是写了 detect + cancel + 续跑。**这是工程师视角：解决一个具体 agent 的具体问题，而不是定义一种能力。** 重构后定位为：

> achat 的"询问" = **agent 主动问用户一个问题、等用户回答、回答后继续干活**这一通用能力的契约。任何 agent 通过统一接口接入，核心与前端代码零改动。

**统一契约 shape**（两种实现产出完全相同，核心无差别消费）：
```
{ question: string, options: [{label, description}], callId: string }
```

**两种实现对比**（证明跨 agent 通用，不是 DSH 专属）：

| | DSH（A 类框架） | 模型类（B 类纯模型） |
|---|---|---|
| 怎么识别"在问问题" | 解析 `ask_user_question` 工具调用（`parseAsk`） | 检测回复**末尾**是问号（`detectAskFromModel`） |
| 是否真挂起 | 是，turn 挂起等答案 | 否，直接返回文本 |
| 答案怎么送回 | cancel 挂起 turn + 重新 prompt 带答案 | 下次 `send` 带 `answerTo` 折叠进上下文 |
| 选项 | 结构化（带选项按钮） | 无，自由输入 |

**路由**：`resolveTargets` 里 pendingAsk 优先——用户回答时只路由给问问题的那个 agent，不广播（否则会在其他座位重启工作）。`bus.mjs` 只通过 `answerTo` 参数与适配器对话，不感知底层是 DSH 还是模型。

**前端**：Ask 卡片同时支持"有选项→点按钮直接发送该答案"和"无选项→输入框自由回答"，两种实现共用同一套 UI。选项按钮的点击已接事件（最初只渲染不响应，是死控件；补上后点击即 `send(answer)` 并把卡片标记已答防重复）；后端 pendingAsk 优先路由保证答案只发给问问题的 agent，不受发送目标下拉框影响。

**零成本回归 `scripts/test-ask.mjs`（14 例）**：同时测两种检测（模型类末尾问号 / DSH 工具结构），并断言两者产出**完全相同的契约 shape**。

**这次重构抓到的真 bug**：`detectAskFromModel` 原用 `/[?？]/.test(tail)`（包含问号即算），与注释"只判末尾"的意图矛盾——中间带问号的长句（"开头有个问题？但是结尾是陈述句"）会被误判为提问。`test-ask` 抓到后改为末尾锚定 `/[?？]$/`。

**结论**：换一个 agent（Claude / Codex / 任意框架）= 新增一个 adapter 文件，实现 `send`（含提问检测）即可，**核心（bus/runtime/server）、前端、回归一套都不用动**。新 agent 若用别的方式表达"我要问"（如 Claude 的 `tool_use`、Codex 的 `function_call`），只需在它的 adapter 里把那种信号翻译成上面的契约 shape。
