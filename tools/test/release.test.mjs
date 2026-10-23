import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baseRelease, classifyCommit, nextVersion, renderNotes, changelogWithRelease, changelogHas } from '../lib/release.mjs';

const c = (subject, extra = {}) => ({ subject, body: '', author: 'Matthew Anderson', ...extra });

test('baseRelease: highest published x.y.z, ignoring drafts, pre-releases and odd tags', () => {
  const releases = [
    { tag_name: 'v0.1.1', draft: true },
    { tag_name: 'prod-rollback-2025-09-12', draft: false },
    { tag_name: 'v0.10.0', draft: false },
    { tag_name: 'v0.9.3', draft: false },
    { tag_name: 'v1.0.0-rc.1', draft: false, prerelease: true },
  ];
  assert.equal(baseRelease(releases).tag_name, 'v0.10.0');
  assert.equal(baseRelease([{ tag_name: 'v1.0.0', draft: true }]), null);
});

test('classifyCommit: worthy = feat/fix/perf/revert/breaking; bot fixes only for deps', () => {
  assert.ok(classifyCommit(c('feat(admin): triage view')).worthy);
  assert.ok(classifyCommit(c('fix: crash on empty list')).worthy);
  assert.ok(!classifyCommit(c('chore(deps): bump vite')).worthy);
  assert.ok(!classifyCommit(c('docs: readme')).worthy);
  assert.ok(classifyCommit(c('fix(deps): refresh lockfile for 3 security alert(s)', { author: 'renovate[bot]' })).worthy);
  assert.ok(!classifyCommit(c('fix(ci): retry', { author: 'dependabot[bot]' })).worthy);
  assert.ok(classifyCommit(c('refactor!: drop v1 API')).breaking);
  assert.ok(classifyCommit(c('refactor: x', { body: 'BREAKING CHANGE: removed y' })).breaking);
  assert.equal(classifyCommit(c('Merge branch main')).type, 'other');
});

test('nextVersion: breaking → major (minor in 0.x), feat → minor, else patch; first release', () => {
  assert.equal(nextVersion('v1.8.0', [c('fix: a'), c('chore: b')]), '1.8.1');
  assert.equal(nextVersion('v1.8.0', [c('fix: a'), c('feat: b')]), '1.9.0');
  assert.equal(nextVersion('v1.8.0', [c('feat!: b')]), '2.0.0');
  assert.equal(nextVersion('v0.3.0', [c('feat!: b')]), '0.4.0');
  assert.equal(nextVersion(null, [], '1.0.0'), '1.0.0');
  assert.equal(nextVersion(null, [], '0.0.0'), '0.1.0');
  assert.equal(nextVersion(null, []), '0.1.0');
});

test('renderNotes: sections for breaking/features/fixes, the rest summarised', () => {
  const notes = renderNotes([c('feat(ui): dark mode'), c('fix: login loop'), c('chore(deps): bump x'), c('ci: cache'), c('feat!: new config format')]);
  assert.equal(notes, [
    '### Breaking changes', '', '- new config format', '',
    '### Features', '', '- **ui:** dark mode', '',
    '### Fixes', '', '- login loop', '',
    'Plus 2 maintenance commit(s) (dependencies, CI, docs, refactors).',
  ].join('\n') + '\n');
});

test('changelogWithRelease: Keep a Changelog moves Unreleased under the new version', () => {
  const text = '# Changelog\n\n## [Unreleased]\n\n### Added\n\n- thing\n\n## [1.8.0] - 2026-05-01\n\n- old\n';
  const out = changelogWithRelease(text, '1.9.0', '2026-10-23', '- generated\n');
  assert.equal(out, '# Changelog\n\n## [Unreleased]\n\n## [1.9.0] - 2026-10-23\n\n### Added\n\n- thing\n\n## [1.8.0] - 2026-05-01\n\n- old\n');
  assert.ok(changelogHas(out, '1.9.0'));
  assert.equal(changelogWithRelease(out, '1.9.0', '2026-10-24', 'x'), out, 'idempotent');
});

test('changelogWithRelease: empty Unreleased gets the notes; plain changelogs get a section on top', () => {
  assert.equal(changelogWithRelease('# Changelog\n\n## [Unreleased]\n\n## [0.1.0] - 2026-01-01\n', '0.1.1', '2026-10-23', '- fix\n'),
    '# Changelog\n\n## [Unreleased]\n\n## [0.1.1] - 2026-10-23\n\n- fix\n\n## [0.1.0] - 2026-01-01\n');
  assert.equal(changelogWithRelease('# Changelog\n\n## v0.2.0\n\n- a\n', '0.3.0', '2026-10-23', '- b\n'),
    '# Changelog\n\n## [0.3.0] - 2026-10-23\n\n- b\n\n## v0.2.0\n\n- a\n');
  assert.equal(changelogWithRelease('# Changelog\n', '0.1.0', '2026-10-23', '- first\n'), '# Changelog\n\n## [0.1.0] - 2026-10-23\n\n- first\n\n');
});
