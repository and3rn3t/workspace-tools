import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PYTPL } from '../lib/manifest.mjs';
import { scoreRepo, GROUPS, EXTRA } from '../lib/scores.mjs';
import { fixtureRepo, cleanupFixtures } from './fixtures/repo.mjs';

after(cleanupFixtures);

const CODEQL = readFileSync(join(PYTPL, 'codeql.yml'), 'utf8');
const PRESENT = new Set(['ok', 'drift', 'vary', 'blessed']);

// have/total must equal the manifest items (minus miss-src) plus the extras.
function assertArithmetic(s) {
  const counted = s.ev.items.filter(i => i.status !== 'miss-src');
  const groupTotal = Object.values(s.groups).reduce((a, g) => a + g.total, 0);
  const groupHave = Object.values(s.groups).reduce((a, g) => a + g.have, 0);
  assert.equal(groupTotal, counted.length);
  assert.equal(groupHave, counted.filter(i => PRESENT.has(i.status)).length);
  assert.equal(s.total, groupTotal + EXTRA.length);
  assert.equal(s.have, groupHave + s.extras.filter(Boolean).length);
  assert.equal(s.score, Math.round((s.have / s.total) * 100));
  for (const g of Object.values(s.groups)) assert.equal(g.have + g.missing.length, g.total);
}

test('scoreRepo: extras — CI, AGENTS, two bots', () => {
  const r = fixtureRepo({
    'pyproject.toml': '',
    '.github/workflows/codeql.yml': CODEQL,
    'AGENTS.md': '# agents\n',
    'renovate.json': '{}',                                         // Renovate on…
    '.github/dependabot.yml': 'updates:\n  - package-ecosystem: npm\n', // …and Dependabot updates
  });
  const s = scoreRepo(r.name);
  assert.deepEqual(EXTRA.map(x => x.key), ['ci', 'agents', 'onebot']);
  assert.deepEqual(s.extras, [true, true, false]);
  assert.deepEqual(Object.keys(s.groups), GROUPS.map(g => g.key));
  assert.ok(s.groups.guards.have >= 1);                       // codeql.yml present
  assert.ok(s.groups.community.missing.includes('.github/CODEOWNERS'));
  assertArithmetic(s);
});

test('scoreRepo: Renovate disabled + Dependabot is one bot; no workflows = no CI', () => {
  const r = fixtureRepo({
    'pyproject.toml': '',
    'renovate.json': '{"enabled": false}',
    '.github/dependabot.yml': 'updates:\n  - package-ecosystem: pip\n',
  });
  const s = scoreRepo(r.name);
  assert.deepEqual(s.extras, [false, false, true]);
  assertArithmetic(s);
});

test('scoreRepo: blessed absences count as present', () => {
  const plain = scoreRepo(fixtureRepo({ 'pyproject.toml': '' }).name);
  const blessed = scoreRepo(fixtureRepo({ 'pyproject.toml': '', '.consistency-ignore': '.github/CODEOWNERS\n' }).name);
  assert.equal(blessed.have, plain.have + 1);
  assert.equal(blessed.total, plain.total);
  assertArithmetic(blessed);
});
