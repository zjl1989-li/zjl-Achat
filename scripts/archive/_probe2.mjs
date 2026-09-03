// Quick liveness probe for both adapters (debug helper).
import { readFileSync } from 'node:fs';
import { probeAgent } from '../server/bus.mjs';

const store = JSON.parse(readFileSync(new URL('../server/data.json', import.meta.url), 'utf8'));
const all = store.agents || [];
const dsh = all.find((a) => a.id === 'dsh');
const wb = all.find((a) => a.id === 'workbuddy');
console.log('dsh cfg:', JSON.stringify(dsh?.config));
console.log('wb cfg:', JSON.stringify(wb?.config));
console.log('probing dsh...');
console.log('dsh ->', await probeAgent(dsh));
console.log('probing workbuddy...');
console.log('wb ->', await probeAgent(wb));
console.log('done');
