# zjl-Achat

[![CI](https://github.com/zjl1989-li/zjl-Achat/actions/workflows/ci.yml/badge.svg)](https://github.com/zjl1989-li/zjl-Achat/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**把你手上所有的 AI agent 拉进同一个微信群。** DSH、DeepSeek、WorkBuddy/CodeBuddy、MCP server、桌面应用——不管它们开不开 API，都能进群、被 @、交任务、回产物。

> 一个群 = 多个 agent + 你。一个群 = 一个项目：会话记忆按群隔离，永不串味。

## 为什么不一样

市面上把 agent 凑在一起的工具，几乎都只接「有官方 API 的」。zjl-Achat 的核心是一套**闭源 agent 桥接层**：

| 接入面 | 机制 | 例子 |
|---|---|---|
| 自托管 RPC | 原生 session API，事件流实时回传 | [DSH](https://github.com/zjl1989-li/dsh-harness-zh) 无窗口进群 |
| 模型 API | OpenAI 兼容接口 | DeepSeek / 任意兼容网关 |
| 闭源桌面 ACP | 驱动桌面应用的 ACP 远控服务 | WorkBuddy（腾讯 CodeBuddy） |
| 闭源 CLI-Key | 官方 API key + CLI headless | CodeBuddy CLI |
| 文件桥 | 纯文件收发，零侵入、最稳 | 任何能读写本地文件夹的产品 |
| MCP / A2A / AG-UI | 标准协议接入 | MCP server、开放协议 agent |
| 桌面 GUI | 自动拉起 + 文件桥回传产物 | 本地桌面应用 |
| 插件 | `adapters.d/` 放一个文件夹即接入新 agent | [示例插件](server/adapters.d/example/) |

加上**记忆引擎**，它不只是转发消息：

```
对话流水(L1, 按群隔离) --蒸馏--> 知识库(L2, Obsidian .md 本地仓)
知识库(L2) --检索注入--> 每轮上下文(L0, 带 token 预算)
```

- **L0 工作记忆**：上下文按 `ctxBudgetChars` 预算裁剪，超长的老对话自动瘦身，token 不再失控
- **L1 情景记忆**：适配器实例按 `(agent, 群)` 隔离——一个群一个项目，跨群永不串味
- **L2 语义记忆**：一键蒸馏（顶栏漏斗图标）把群聊结论沉淀成 Obsidian 笔记，同名追加日期小节——**沉淀，不堆叠，不硬删**；共识结论自动入库
- **技能库 / 权限库**：技能 JSON 声明式注册；权限按「群 × agent × 能力」授权，默认拒绝、全量审计

## 快速开始

要求：Node.js ≥ 18。无 npm install、无数据库、无 Docker。

```bash
git clone https://github.com/zjl1989-li/zjl-Achat.git
cd zjl-AChat
cp .env.example .env   # 按需填入 DEEPSEEK_API_KEY / CODEBUDDY_API_KEY
node server/server.mjs
# 打开 http://127.0.0.1:8787
```

系统托盘常驻（可选，Windows + PowerShell 5.1）：运行 `desktop/tray.ps1`，右键托盘图标打开/退出，内置 30 秒看门狗自动重启服务。

**应用内更新**：设置弹窗底部一键检查 GitHub 最新 release；有新版可直接在 UI 内安全更新（拒绝脏工作区 / 分叉历史，fast-forward-only + 自重启），本地改动永不被覆盖。

## 三库（左侧栏）

- **资料库**：检索 / 预览 / 删除沉淀笔记（Obsidian `.md` 本地仓，`server/kb/`，直接用 Obsidian 打开这个文件夹就是你的知识库）
- **技能库**：声明式技能清单，agent 按任务调用；加技能 = 改 JSON，不改代码
- **权限库**：谁在哪个群能用什么能力，默认拒绝，授权 / 撤销 / 审计轨迹一目了然

## 架构速览

```
server/              零依赖 Node ESM 后端
  server.mjs           HTTP 服务（REST + SSE + 静态资源 + 图片代理 + 安全加固）
  store.mjs            JSON 存储（内存 + 快照 + 损坏保护 + 头像落盘）
  bus.mjs              消息总线（@提及路由、按群隔离的适配器实例、L0 预算、recall 注入）
  adapters.mjs         八类内置适配器 + 插件加载器（adapters.d/）
  memory/
    knowledge.mjs        资料库（Obsidian .md，沉淀式写入 + 关键词检索）
    skills.mjs           技能库（skills.json 声明式注册）
    acl.mjs              权限库（fail-closed + 审计轨迹）
    distill.mjs          蒸馏管（L1→L2：群摘要 / 钉住消息 → KB 笔记）
  adapters.d/            插件适配器目录（plugin.json 清单 + module，见 example/）
public/              纯静态前端（原生 JS，无框架；SVG 图标，无 emoji）
desktop/             托盘管理器（PowerShell WinForms）
tests/               node:test 单元测试（隔离 / 三库 / 插件 / 记忆引擎）
```

- 服务只绑定 `127.0.0.1`，带 Host 头校验（防 DNS 重绑）、SSRF 拦截与静态路径穿越防护
- 所有运行时数据在 `server/data.json`（首次启动自动生成），运行时数据均不入库

## 写一个插件适配器

不改一行核心代码，接入任何新 agent：

```
server/adapters.d/my-agent/
  plugin.json   → { "id": "my-agent", "match": { "configKey": "myAgent" }, "module": "./adapter.mjs" }
  adapter.mjs   → export default class { constructor(agent) meta() ping() send() }
```

之后任何 `config: { "myAgent": {...} }` 的 agent 自动走你的适配器。完整可运行的参考实现见 [`server/adapters.d/example/`](server/adapters.d/example/)。

## 测试

```bash
npm test           # 全量回归（脚本 + 单测，30+ 用例，CI 矩阵 Node 18/20/22 × Ubuntu/Windows）
npm run test:unit  # node:test 单元测试
```

## 安全提示

- 请勿将服务端口暴露到公网；如需局域网访问，请自行加反代与鉴权
- 各 agent 的 API Key 通过 `.env` 或 agent 配置注入，注意不要提交到仓库
- 知识库默认落本地 `server/kb/`；如自行接入云后端（如 ima），敏感记忆请勿上云

## License

[MIT](LICENSE)
