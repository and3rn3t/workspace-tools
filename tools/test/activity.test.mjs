import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { projectCommits, lastProjectCommit } from '../lib/activity.mjs';
import { fixtureRepo, cleanupFixtures } from './fixtures/repo.mjs';

after(cleanupFixtures);

const HUMAN = { name: 'Test Human', email: 'human@example.com' };
const BOT = { name: 'renovate[bot]', email: '29139614+renovate[bot]@users.noreply.github.com' };

function git(path, args, who = HUMAN) {
  const env = { ...process.env, GIT_AUTHOR_NAME: who.name, GIT_AUTHOR_EMAIL: who.email, GIT_COMMITTER_NAME: who.name, GIT_COMMITTER_EMAIL: who.email, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const r = spawnSync('git', ['-C', path, '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
}

function commit(path, files, who) {
  for (const [f, content] of Object.entries(files)) {
    mkdirSync(dirname(join(path, f)), { recursive: true });
    writeFileSync(join(path, f), content);
  }
  git(path, ['add', '-A'], who);
  git(path, ['commit', '-q', '-m', 'change'], who);
}

function repo() {
  const r = fixtureRepo();
  git(r.path, ['init', '-q', '-b', 'main']);
  return r;
}

test('housekeeping-only commits (manifest files, AGENTS.md, CLAUDE.md, dependabot.yml) do not count', () => {
  const r = repo();
  commit(r.path, { '.editorconfig': 'root = true\n', 'SECURITY.md': '# s\n' });
  commit(r.path, { 'AGENTS.md': '# a\n', 'CLAUDE.md': '# c\n' });
  commit(r.path, { '.github/dependabot.yml': 'version: 2\n', '.consistency-ignore': 'LICENSE\n' });
  commit(r.path, { '.github/workflows/release-drafter.yml': 'on: push\n' });
  assert.equal(projectCommits(r.name), 0);
  assert.equal(lastProjectCommit(r.name), null);
});

test('a commit touching a real project file counts, even alongside housekeeping', () => {
  const r = repo();
  commit(r.path, { 'AGENTS.md': '# a\n' });
  commit(r.path, { 'AGENTS.md': '# a2\n', 'src/index.js': 'export {};\n' });
  commit(r.path, { '.github/workflows/ci.yml': 'on: push\n' }); // repo-specific workflow = real work
  assert.equal(projectCommits(r.name), 2);
  assert.match(lastProjectCommit(r.name), /^\d{4}-\d{2}-\d{2}$/);
});

test('bot commits never count', () => {
  const r = repo();
  commit(r.path, { 'package.json': '{"v":1}\n' }, BOT);
  commit(r.path, { 'package.json': '{"v":2}\n' }, { name: 'dependabot[bot]', email: 'x@users.noreply.github.com' });
  assert.equal(projectCommits(r.name), 0);
});

test('a folder that is not a git repo has no activity', () => {
  assert.equal(projectCommits(fixtureRepo({ 'README.md': '' }).name), 0);
});
