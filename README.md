# zjl-Achat

[![CI](https://github.com/zjl1989-li/zjl-Achat/actions/workflows/ci.yml/badge.svg)](https://github.com/zjl1989-li/zjl-Achat/actions/workflows/ci.yml)

仿微信群聊式的**多 agent 群聊枢纽** —— 把你本机和云端的各种 AI agent（DSH、模型 API、CodeBuddy、桌面应用、MCP 等）拉进同一个群聊里协作，本地优先、零依赖、纯 Node ESM。

> 一个群 = 多个 agent + 你。@谁谁回答，支持 SSE 实时推送、产物（图片/文件/代码）归档、群空间上下文共享。

## 特性

- **纯本地运行**：Node.js（≥18）单进程，REST + SSE，数据就是一个 JSON 文件，无数据库、无 npm 依赖
- **多形态 agent 接入**：本地 RPC 服务 / OpenAI 兼容模型 API / 文件桥 / 桌面 GUI / MCP / A2A 协议 / CLI-key，探针自动选型
- **接入即配好**：添加 agent 时自动生成 launcher，设置卡片一键启停，托盘常驻 + 看门狗自动拉起
- **群空间**：上下文资料整包共享给群内 agent（Context Hub），产物按类型归档、图片本地代理直接预览
- **桌面体验**：Edge App 窗口 + 系统托盘（WinForms）+ 桌面通知/提示音 + 消息分页

## 快速开始

```bash
git clone https://github.com/zjl1989-li/zjl-Achat.git
cd zjl-Achat
cp .env.example .env   # 按需填入 DEEPSEEK_API_KEY / CODEBUDDY_API_KEY
node server/server.mjs
# 打开 http://127.0.0.1:8787
```

系统托盘常驻（可选，Windows + PowerShell 5.1）：运行 `desktop/tray.ps1`，右键托盘图标可打开/退出，内置 30 秒看门狗自动重启服务。

## 架构速览

```
server/            零依赖 Node ESM 后端
  server.mjs         HTTP 服务（REST + SSE + 静态资源 + 图片/头像代理 + 安全加固）
  store.mjs          JSON 存储（内存 + 快照 + 损坏保护 + 头像落盘）
  bus.mjs            消息总线（@提及路由、屏蔽哨兵、工具事件统计）
  adapters.mjs       六类适配器（A=RPC B=模型API C=文件桥 D=桌面GUI E=MCP F=协议）
  agents.mjs         内置 agent 注册表 + 启动器配置
public/            纯静态前端（原生 JS，无框架）
desktop/           托盘管理器（PowerShell WinForms）
scripts/           开发探针 / 回归测试脚本
tests/             node:test 单元测试
```

- 服务只绑定 `127.0.0.1`，带 Host 头校验、SSRF 拦截与静态路径穿越防护
- 所有运行时数据在 `server/data.json`（首次启动自动生成），`data.json` 与头像目录不入库

## 测试

```bash
npm test        # 全量回归（9 个脚本）
npm run test:unit   # node:test 单元测试
```

## 安全提示

- 请勿将服务端口暴露到公网；如需局域网访问，请自行加反代与鉴权
- 各 agent 的 API Key 通过 `.env` 或 agent 配置注入，注意不要提交到仓库

## License

[MIT](LICENSE)
