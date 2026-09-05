// Bus-level conversation isolation: adapter instances are cached per
// (agent, conversation), so ANY session state an adapter holds is scoped to
// one group - one group = one project, memory can never bleed across groups.
// Regression for the agentId-singleton cache that shared one DSH session
// (and any other native state) across conversations.
// Pure node:test, zero dependencies, ASCII only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adapterFor, dropAdapter } from '../server/bus.mjs';

test('bus: adapter instances are isolated per (agent, conversation)', () => {
  const agent = { id: 'iso-' + Date.now().toString(36), name: 'IsoAgent', config: { model: 'test-model' } };
  const ctl = adapterFor(agent);                 // control plane (ping/probe)
  const c1a = adapterFor(agent, 'conv1');
  const c1b = adapterFor(agent, 'conv1');        // same conv -> SAME instance
  const c2 = adapterFor(agent, 'conv2');         // other conv -> DIFFERENT instance
  assert.equal(c1a, c1b);
  assert.notEqual(c1a, c2);
  assert.notEqual(c1a, ctl);
  // Settings change drops every conversation instance + the control plane.
  dropAdapter(agent.id);
  assert.notEqual(adapterFor(agent, 'conv1'), c1a);
  assert.notEqual(adapterFor(agent), ctl);
});

test('bus: dropAdapter only touches the named agent', () => {
  const a = { id: 'isoA-' + Date.now().toString(36), name: 'A', config: { model: 'm' } };
  const b = { id: 'isoB-' + Date.now().toString(36), name: 'B', config: { model: 'm' } };
  const aInst = adapterFor(a, 'sharedConv');
  const bInst = adapterFor(b, 'sharedConv');
  dropAdapter(a.id);
  assert.notEqual(adapterFor(a, 'sharedConv'), aInst);
  assert.equal(adapterFor(b, 'sharedConv'), bInst);   // neighbour untouched
});
