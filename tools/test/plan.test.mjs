import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { desiredTopics, renderIndex, FEATURED_TOPIC } from '../lib/plan.mjs';
import { fixtureRepo, cleanupFixtures } from './fixtures/repo.mjs';

after(cleanupFixtures);

test('desiredTopics: sorted, featured added only when flagged, input untouched', () => {
  const topics = ['react', FEATURED_TOPIC, 'cloudflare'];
  assert.deepEqual(desiredTopics({ github: { topics }, featured: false }), ['cloudflare', 'react']);
  assert.deepEqual(desiredTopics({ github: { topics }, featured: true }), ['cloudflare', 'featured', 'react']);
  assert.deepEqual(desiredTopics({ github: { topics: [] }, featured: true }), ['featured']);
  assert.deepEqual(topics, ['react', FEATURED_TOPIC, 'cloudflare']);
});

test('renderIndex: every group in order, rows by group, ✓ for CLAUDE.md, archived marker', () => {
  const withClaude = fixtureRepo({ 'CLAUDE.md': '# x\n' });
  const ws = { repos: {
    '__no_such_repo_b__': { group: 'web', summary: 'Second web app' },
    [withClaude.name]: { group: 'web', summary: 'Has a CLAUDE.md' },
    '__no_such_repo_py__': { group: 'python', summary: 'Old tool', archived: true },
  } };
  assert.equal(renderIndex(ws), [
    '## Web / Cloudflare Workers (React + TS)\n\n| Repo | What it is |\n|---|---|\n'
      + '| `__no_such_repo_b__` | Second web app |\n'
      + `| \`${withClaude.name}\` ✓ | Has a CLAUDE.md |\n`,
    '## Python (CLI tools & skills)\n\n| Repo | What it is |\n|---|---|\n| `__no_such_repo_py__` | Old tool _(archived)_ |\n',
    '## iOS / macOS (Xcode)\n\n| Repo | What it is |\n|---|---|\n\n',
    '## Game dev\n\n| Repo | What it is |\n|---|---|\n\n',
    '## Templates, experiments & misc\n\n| Repo | What it is |\n|---|---|\n\n',
  ].join('\n') + '\n');
});
