// Example plugin adapter for tmesh.
//
// The contract is the same as every built-in adapter class:
//   constructor(agent)      - read agent.config, keep a reference
//   meta()                  - { adapterType, hasNativeSession, capabilities }
//   async ping()            - liveness probe for the heartbeat / status light
//   async send({ messages, convId, ... }) -> { text, ask?, artifacts? }
//
// bus.js guarantees per-conversation instances: one group = one instance, so
// any session state you keep on `this` is naturally conversation-scoped.
//
// This example echoes the last user message back - enough to see the full
// round trip without any external service. Delete this folder for production
// use, or copy it as a starting point for your own adapter.
export default class ExampleEchoAdapter {
  constructor(agent) {
    this.agent = agent;
    this.type = 'P'; // P = plugin
    this.turns = 0;  // conversation-scoped state (one instance per group)
  }

  meta() {
    return { adapterType: 'P', hasNativeSession: false, capabilities: ['chat'] };
  }

  async ping() {
    return true; // no external service to reach - always alive
  }

  async send({ messages, signal, onEvent, convId }) {
    this.turns += 1;
    const lastUser = [...(messages || [])].reverse().find((m) => m.role === 'user');
    const text = (lastUser && lastUser.content) || '';
    return {
      text: `[${this.agent.name} · example-echo] 收到（本群第 ${this.turns} 轮）：\n\n${text}`,
    };
  }
}
