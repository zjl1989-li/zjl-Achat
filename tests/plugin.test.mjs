// Plugin adapter loading (adapters.d/, EchoBird-style manifest registration).
// Zero dependencies, ASCII only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAdapter, warmPlugins, listPlugins } from '../server/adapters.mjs';

test('adapters.d plugin: manifest match outranks built-in probing', async () => {
  const ids = await warmPlugins();
  assert.ok(ids.includes('example-echo'), 'example plugin must load');
  assert.ok(listPlugins().some((p) => p.id === 'example-echo' && p.loaded));

  // config.exampleEcho present -> plugin class wins, whatever else the config says
  const agent = { id: 'pl-' + Date.now().toString(36), name: 'Plug', config: { exampleEcho: true, model: 'x' } };
  const ad = createAdapter(agent);
  assert.equal(ad.meta().adapterType, 'P');
  const r = await ad.send({ messages: [{ role: 'user', content: 'hello plugin' }] });
  assert.ok(typeof r.text === 'string' && r.text.includes('hello plugin'));

  // without the match key the same built-in resolution applies (B default)
  const plain = createAdapter({ id: 'pl2', name: 'Plain', config: { model: 'x' } });
  assert.equal(plain.meta().adapterType, 'B');
});
