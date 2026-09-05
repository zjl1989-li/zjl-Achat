// Built-in agent registry. Adapter selection lives in adapters.mjs.
// Pure ESM, no dependencies. ASCII only.
//
// `skills` is a DECLARATION typed by hand, not verified fact. DSH exposes no
// capability-listing RPC, so the only honest source is what the agent is
// observed doing: store.toolStats counts real tool/call events (see bus.mjs).
// Both are shown in the settings card, labelled 已装技能 vs 实测能力.

// config.adapterType: 'A' = DSH Typert RPC, 'B' = OpenAI model API,
//                    'C' = Bridge Adapter (file-bridge, closed-source product).
const DEFAULT_AGENTS = [
  {
    id: 'beichen', name: 'WorkBuddy', role: 'AI 量化交易分析师', color: '#f0997b',
    system: '你是WorkBuddy，一个直接、用数据说话的 AI 量化交易分析师。牛市提醒风险，熊市找机会。对用户诚实，没有确定性机会就说没有。说话简洁，中文。',
    model: 'deepseek-chat', adapterType: 'B', status: 'online', guiPath: '', skills: [],
    config: { adapterType: 'B', model: 'deepseek-chat', apiKeyEnv: 'DEEPSEEK_API_KEY' },
  },
  {
    id: 'dsh', name: 'DSH', role: '通用智能体 / 工具链', color: '#22c55e',
    system: '你是 DSH，一个通用智能体，擅长把任务拆成步骤、调用工具、产出可交付物。',
    model: 'dsh-2.0.2', adapterType: 'A', status: 'online',
    guiPath: 'D:/Tools/DSHDesktop/DSHDesktop.exe',
    skills: ['research', 'coding', 'review'],
    config: { adapterType: 'A', cwd: 'D:\\Projects', ports: [3080, 43120] },
  },
  {
    id: 'invest', name: '投资研究', role: '机构级投研', color: '#fbbf24',
    system: '你是投资研究助手，按机构投研流程：基本面/资金面/估值/风险多维度分析，给出有依据的结论。中文回答。',
    model: 'deepseek-chat', adapterType: 'B', status: 'online', guiPath: '', skills: ['stock-analysis'],
    config: { adapterType: 'B', model: 'deepseek-chat', apiKeyEnv: 'DEEPSEEK_API_KEY' },
  },
  // M3 file-bridge sample: achat ferries the turn to a local product that reads
  // bridge/beichen-bridge/inbox and writes back outbox. No network, no token.
  {
    id: 'beichen-bridge', name: 'WorkBuddy（桥接）', role: 'AI 量化交易分析师（文件桥接真身）', color: '#f0997b',
    system: '你是WorkBuddy，一个直接、用数据说话的 AI 量化交易分析师。牛市提醒风险，熊市找机会。对用户诚实，没有确定性机会就说没有。说话简洁，中文。',
    model: '', adapterType: 'C', status: 'online', guiPath: '', skills: [],
    config: {
      adapterType: 'C', localDir: 'bridge/beichen-bridge', pollMs: 1000, maxWaitMs: 180000,
      // launcher: how achat starts this agent locally when the user flips the
      // in-group "启动" switch. Both pieces run headless + silent:
      //   service    - the agent's OWN long-running service (e.g. `dsh serve`);
      //                null = invoked per-task instead (demo-agent below).
      //   monitor    - dumb shuttle that polls inbox and ferries to the agent.
      //   agentEntry - the real agent brain the monitor invokes per task.
      launcher: {
        enabled: true,
        transport: 'file-pipe',            // file-pipe | rpc | stdio | ui-auto
        service: null,                     // e.g. 'D:/Tools/DSHDesktop/DSHDesktop.exe'; null = per-task
        serviceArgs: [],
        headless: true,                    // launch without popping the main window
        monitor: 'scripts/bridge-monitor.mjs',
        agentEntry: 'scripts/demo-agent.mjs',
      },
    },
  },
];

export { DEFAULT_AGENTS };
