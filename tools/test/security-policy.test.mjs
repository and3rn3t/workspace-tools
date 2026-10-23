import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computePlan } from '../lib/plan.mjs';
import { repoSettings, DEFAULT_SECURITY } from '../lib/workspace.mjs';

const ws = (repo, extra = {}) => ({
  owner: 'x', defaults: {}, policies: { protection: { standard: {} }, renovate: {} },
  repos: { [repo]: { group: 'web', summary: 's', ...extra } },
});
const meta = (repo, security) => ({ repos: { [repo]: { description: '', homepage: '', topics: [], archived: false, protected: true, security } } });
const security = changes => changes.filter(c => c.category === 'security').map(c => `${c.field} ${c.actual}→${c.desired}`);

test('repoSettings: security defaults on, overridable per repo', () => {
  assert.deepEqual(repoSettings('r', ws('r')).security, DEFAULT_SECURITY);
  assert.deepEqual(repoSettings('r', ws('r', { security: { updates: false } })).security, { alerts: true, updates: false });
});

test('computePlan: security changes only where GitHub differs and is readable', () => {
  assert.deepEqual(security(computePlan(ws('__r__'), meta('__r__', { alerts: false, updates: false }))), ['alerts off→on', 'updates off→on']);
  assert.deepEqual(security(computePlan(ws('__r__'), meta('__r__', { alerts: true, updates: true }))), []);
  assert.deepEqual(security(computePlan(ws('__r__'), meta('__r__', { alerts: null, updates: null }))), []);
  assert.deepEqual(security(computePlan(ws('__r__', { security: { updates: false } }), meta('__r__', { alerts: true, updates: true }))), ['updates on→off']);
  assert.deepEqual(security(computePlan(ws('__r__', { archived: true }), meta('__r__', { alerts: false, updates: false }))), []);
});
