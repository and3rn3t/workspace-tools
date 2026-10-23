import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePresentation, CHECKS } from '../lib/presentation.mjs';
import { fixtureRepo, cleanupFixtures } from './fixtures/repo.mjs';

after(cleanupFixtures);

const statuses = r => Object.fromEntries(r.checks.map(c => [c.key, c.status]));
const REMOTE = CHECKS.filter(c => c.remote).map(c => c.key);

const FULL_README = `# My Project

[![CI](https://github.com/and3rn3t/x/actions/workflows/ci.yml/badge.svg)](https://github.com/and3rn3t/x/actions)
![License](https://img.shields.io/badge/license-MIT-blue)

![Screenshot](docs/screenshot.png)

## Getting Started

npm install

## License

MIT
`;

test('README heuristics all pass on a complete README', () => {
  const r = fixtureRepo({ 'README.md': FULL_README, 'AGENTS.md': '', 'CLAUDE.md': '', 'CHANGELOG.md': '' });
  const s = statuses(evaluatePresentation(r.name, null));
  for (const k of ['readme', 'title', 'badges', 'screenshot', 'quickstart', 'license-sec', 'agents', 'claude', 'changelog']) assert.equal(s[k], 'ok', k);
});

test('no README fails every README check', () => {
  const s = statuses(evaluatePresentation(fixtureRepo({}).name, null));
  for (const k of ['readme', 'title', 'badges', 'screenshot', 'quickstart', 'license-sec']) assert.equal(s[k], 'fail', k);
});

test('badge images are not screenshots; headings must be headings', () => {
  const md = '# T\n\n![ci](https://img.shields.io/badge/ci-passing-green)\n\nInstall it with npm. Licensed MIT.\n';
  const s = statuses(evaluatePresentation(fixtureRepo({ 'readme.md': md }).name, null));
  assert.equal(s.badges, 'ok');
  assert.equal(s.screenshot, 'fail');
  assert.equal(s.quickstart, 'fail');     // "Install" only in prose
  assert.equal(s['license-sec'], 'fail');
});

test('HTML <h1>/<img> and alternate heading words are recognised', () => {
  const md = '<h1 align="center">T</h1>\n<img src="shot.gif" width="600">\n\n### Quick start\n\n#### Licence\n';
  const s = statuses(evaluatePresentation(fixtureRepo({ 'README.md': md }).name, null));
  assert.equal(s.title, 'ok');
  assert.equal(s.screenshot, 'ok');
  assert.equal(s.quickstart, 'ok');
  assert.equal(s['license-sec'], 'ok');
  assert.equal(s.badges, 'fail');
});

test('remote checks are unknown without meta (or with an error entry), and not scored', () => {
  const r = fixtureRepo({ 'README.md': FULL_README });
  for (const meta of [null, { repos: {} }, { repos: { [r.name]: { error: 'not found' } } }]) {
    const res = evaluatePresentation(r.name, meta);
    const s = statuses(res);
    for (const k of REMOTE) assert.equal(s[k], 'unknown', k);
    assert.ok(REMOTE.every(k => !res.checked.includes(k)));
    assert.equal(res.total, CHECKS.length - REMOTE.length);
  }
});

test('remote checks read the meta cache', () => {
  const r = fixtureRepo({ 'README.md': FULL_README });
  const meta = { repos: { [r.name]: {
    description: 'A thing', topics: ['a', 'b', 'c'], homepage: '', protected: true,
    workflows: 2, failing: [], latestRelease: null,
  } } };
  const s = statuses(evaluatePresentation(r.name, meta));
  assert.equal(s.description, 'ok');
  assert.equal(s.topics, 'ok');
  assert.equal(s.homepage, 'na');   // no wrangler config → no live site expected
  assert.equal(s.protected, 'ok');
  assert.equal(s['ci-green'], 'ok');
  assert.equal(s.release, 'fail');
  assert.equal(s.security, 'na');   // older cache without security data

  const site = fixtureRepo({ 'README.md': FULL_README, 'apps/web/wrangler.jsonc': '{}' });
  const m2 = { repos: { [site.name]: { ...meta.repos[r.name], topics: ['a'], failing: ['CI'], dependabot: { critical: 0, high: 1 } } } };
  const s2 = statuses(evaluatePresentation(site.name, m2));
  assert.equal(s2.homepage, 'fail');
  assert.equal(s2.topics, 'fail');
  assert.equal(s2['ci-green'], 'fail');
  assert.equal(s2.security, 'fail');
});

test('presentation:<key> blesses a failing check and counts it as have', () => {
  const md = '# CLI\n\n## Usage\n';
  const plain = evaluatePresentation(fixtureRepo({ 'README.md': md }).name, null);
  const r = fixtureRepo({ 'README.md': md, '.consistency-ignore': 'presentation:screenshot\n' });
  const res = evaluatePresentation(r.name, null);
  assert.equal(statuses(plain).screenshot, 'fail');
  assert.equal(statuses(res).screenshot, 'blessed');
  assert.ok(!res.fail.includes('screenshot'));
  assert.equal(res.have, plain.have + 1);
  assert.equal(res.total, plain.total);
  assert.equal(res.score, Math.round((res.have / res.total) * 100));
});
