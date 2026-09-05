// Self-update helpers: semver compare + the safety rails of applyUpdate.
// Network / git paths are NOT tested here (CI must stay offline-deterministic).
// Zero dependencies, ASCII only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareSemver, getCurrentVersion } from '../server/updater.mjs';

test('compareSemver: numeric dotted compare, v-prefix and short forms', () => {
  assert.ok(compareSemver('v1.0.1', '1.0.0') > 0);
  assert.ok(compareSemver('1.0.0', 'v1.0.1') < 0);
  assert.equal(compareSemver('v1.0.0', '1.0.0'), 0);
  assert.ok(compareSemver('1.2', '1.1.9') > 0);   // missing patch == 0
  assert.ok(compareSemver('0.9.5', '1.0.0') < 0);
  assert.ok(compareSemver('2.0.0', '1.9.9') > 0);
  assert.equal(compareSemver('1.0', '1.0.0'), 0); // short form equals padded
});

test('getCurrentVersion: reads the live package.json (changes after a pull)', () => {
  const v = getCurrentVersion();
  assert.ok(/^\d+\.\d+\.\d+/.test(v), 'version must be dotted semver, got ' + v);
});
