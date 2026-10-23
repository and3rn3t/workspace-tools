import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flakiness, isFlaky, FLIP_LIMIT } from '../lib/flaky.mjs';

const SINCE = '2026-10-09T00:00:00Z';
const r = (at, ok, sha = at) => ({ at: `2026-10-${at}T12:00:00Z`, ok, sha });

test('same commit passing and failing is flaky', () => {
  const stats = flakiness([r('10', true, 'abc'), r('11', false, 'abc'), r('12', true, 'def')], SINCE);
  assert.deepEqual(stats, { mixedShas: 1, flips: 2 });
  assert.equal(isFlaky('CI', stats), true);
});

test('flips are counted in time order, only inside the window', () => {
  const runs = [r('15', true), r('12', false), r('10', true), r('14', false), r('01', false), r('02', true)];
  // in window: 10✓ 12✗ 14✗ 15✓ → 2 flips; the 01✗ → 02✓ flip before SINCE is ignored
  assert.deepEqual(flakiness(runs, SINCE), { mixedShas: 0, flips: 2 });
});

test('FLIP_LIMIT threshold', () => {
  assert.equal(FLIP_LIMIT, 3);
  const two = flakiness([r('10', true), r('11', false), r('12', true)], SINCE);
  assert.equal(two.flips, 2);
  assert.equal(isFlaky('CI', two), false);
  const three = flakiness([r('10', true), r('11', false), r('12', true), r('13', false)], SINCE);
  assert.equal(isFlaky('CI', three), true);
});

test('steady pass or steady fail is not flaky', () => {
  assert.equal(isFlaky('CI', flakiness([r('10', false), r('11', false), r('12', false)], SINCE)), false);
  assert.equal(isFlaky('CI', flakiness([], SINCE)), false);
});

test('settings-driven workflows (bot updaters, deploy, release…) are never flaky', () => {
  const stats = { mixedShas: 2, flips: 5 };
  for (const name of ['Dependabot Updates', 'Deploy to Cloudflare', 'Release Drafter', 'Publish', 'Close stale issues', 'Label sync']) assert.equal(isFlaky(name, stats), false, name);
  assert.equal(isFlaky('E2E (Scheduled)', stats), true);
});

test('does not reorder the caller\'s array', () => {
  const runs = [r('12', true), r('10', false)];
  flakiness(runs, SINCE);
  assert.deepEqual(runs.map(x => x.at.slice(8, 10)), ['12', '10']);
});
