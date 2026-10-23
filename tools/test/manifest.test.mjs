import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MANIFEST, PYTPL, ROOT, evaluate, detectTypes, typeLabel, ignoredFor } from '../lib/manifest.mjs';
import { fixtureRepo, cleanupFixtures } from './fixtures/repo.mjs';

after(cleanupFixtures);

// Only template sources tracked in this repo (tools/templates) — CI has no
// ai-template-repo / .github checkout, so those entries are miss-src there.
const CODEQL = readFileSync(join(PYTPL, 'codeql.yml'), 'utf8');
const CODEOWNERS = readFileSync(join(ROOT, 'tools', 'templates', 'CODEOWNERS'), 'utf8');
const statusOf = (ev, dest) => ev.items.find(i => i.item.dest === dest)?.status;

test('detectTypes / typeLabel', () => {
  assert.deepEqual([...detectTypes(fixtureRepo({ 'pyproject.toml': '' }).path)], ['python']);
  const node = fixtureRepo({ 'package.json': '{}', 'pnpm-lock.yaml': '' });
  assert.equal(typeLabel(node.path), 'node·pnpm');
  assert.equal(typeLabel(fixtureRepo({ 'App/App.xcodeproj/project.pbxproj': '' }).path), 'xcode');
  assert.equal(typeLabel(fixtureRepo({ 'Cargo.toml': '' }).path), 'other');
});

test('ignoredFor skips comments and blank lines', () => {
  const r = fixtureRepo({ '.consistency-ignore': '# why\n\nLICENSE\n  presentation:screenshot  \n' });
  assert.deepEqual([...ignoredFor(r.path)], ['LICENSE', 'presentation:screenshot']);
});

test('evaluate: ok / missing / vary', () => {
  const r = fixtureRepo({
    'pyproject.toml': '',
    '.github/workflows/codeql.yml': CODEQL,  // identical → ok
    'renovate.json': '{"extends": []}',      // differs, drift:false → vary
  });                                        // no CODEOWNERS → missing
  const ev = evaluate(r.name);
  assert.equal(statusOf(ev, '.github/workflows/codeql.yml'), 'ok');
  assert.equal(statusOf(ev, 'renovate.json'), 'vary');
  assert.equal(statusOf(ev, '.github/CODEOWNERS'), 'missing');
  assert.ok(ev.missing.includes('.github/CODEOWNERS'));
  // python repos get the python codeql/renovate sources, not the node ones
  assert.equal(ev.items.find(i => i.item.dest === 'renovate.json').item.src, join(PYTPL, 'renovate.json'));
  assert.ok(!ev.items.some(i => i.item.types.includes('node') && !i.item.types.includes('all')));
});

test('evaluate: drift vs blessed via .consistency-ignore', () => {
  const drifted = fixtureRepo({ 'pyproject.toml': '', '.github/workflows/codeql.yml': CODEQL + '# local tweak\n' });
  assert.equal(statusOf(evaluate(drifted.name), '.github/workflows/codeql.yml'), 'drift');
  assert.ok(evaluate(drifted.name).drift.includes('.github/workflows/codeql.yml'));

  const blessed = fixtureRepo({
    'pyproject.toml': '',
    '.github/workflows/codeql.yml': CODEQL + '# local tweak\n',
    'renovate.json': '{}',
    '.consistency-ignore': '.github/workflows/codeql.yml\n.github/CODEOWNERS\nrenovate.json\n',
  });
  const ev = evaluate(blessed.name);
  assert.equal(statusOf(ev, '.github/workflows/codeql.yml'), 'blessed'); // differs + ignored
  assert.equal(statusOf(ev, '.github/CODEOWNERS'), 'blessed');           // absent + ignored
  assert.equal(statusOf(ev, 'renovate.json'), 'blessed');                // vary + ignored
  assert.ok(!ev.missing.includes('.github/CODEOWNERS'));
  assert.deepEqual(ev.drift, []);
});

test('evaluate: identical CODEOWNERS is ok; absent template source is miss-src', () => {
  const r = fixtureRepo({ '.github/CODEOWNERS': CODEOWNERS, 'pyproject.toml': '' });
  const ev = evaluate(r.name);
  assert.equal(statusOf(ev, '.github/CODEOWNERS'), 'ok');
  for (const { item, status } of ev.items) if (!existsSync(item.src)) assert.equal(status, 'miss-src', item.dest);
  const applicable = MANIFEST.filter(m => m.types.includes('all') || m.types.includes('python'));
  assert.equal(ev.items.length, applicable.length);
});
