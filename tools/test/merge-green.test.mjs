import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, checkState } from '../merge-green.mjs';

const pr = (title, { body = '', headRefName = 'dependabot/npm_and_yarn/x' } = {}) => ({ title, body, headRefName });

test('classify: grouped Dependabot title hiding a major (vitest 3 → 5) is major', () => {
  assert.equal(classify(pr('chore(deps-dev): bump tinypool, @vitest/coverage-v8, @vitest/ui',
    { body: 'Updates `vitest` from 3.2.7 to 5.0.5\n- [Release notes](https://github.com/vitest-dev/vitest/releases)' })), 'major');
});

test('classify: Renovate major branch / title / table', () => {
  assert.equal(classify(pr('chore(deps): update react monorepo', { headRefName: 'renovate/major-react-monorepo' })), 'major');
  assert.equal(classify(pr('chore(deps): update dependency vite to v7 (major)', { headRefName: 'renovate/vite-7.x' })), 'major');
  assert.equal(classify(pr('chore(deps): update react', { headRefName: 'renovate/react',
    body: '| Package | Change |\n|---|---|\n| react | `^18.3.1` -> `^19.0.0` |' })), 'major');
  assert.equal(classify(pr('chore(deps): update dependency eslint to v10', { headRefName: 'renovate/eslint-10.x' })), 'major');
});

test('classify: lockfile maintenance and in-major bumps are minor/patch', () => {
  assert.equal(classify(pr('chore(deps): lock file maintenance', { headRefName: 'renovate/lock-file-maintenance',
    body: '🔧 This Pull Request updates lock files to use the latest dependency versions.' })), 'minor/patch');
  assert.equal(classify(pr('chore(deps): bump vite from 6.0.1 to 6.0.3', { body: 'Bumps vite from 6.0.1 to 6.0.3.' })), 'minor/patch');
  assert.equal(classify(pr('chore(deps): update dependency eslint to v9.1.0', { headRefName: 'renovate/eslint-9.x' })), 'minor/patch');
  assert.equal(classify(pr('chore(deps): update react', { headRefName: 'renovate/react',
    body: '| react | `18.3.0` → `18.3.1` |' })), 'minor/patch');
  assert.equal(classify(pr('chore(deps): bump x from 5.0.0 to 4.9.0')), 'minor/patch'); // downgrade isn't a major
});

test('classify: groups are held for review unless they announce a major', () => {
  assert.equal(classify(pr('chore(deps): bump the dev-dependencies group with 3 updates',
    { body: 'Updates `a` from 1.2.0 to 1.3.0\nUpdates `b` from 2.0.0 to 2.0.1' })), 'group');
  assert.equal(classify(pr('chore(deps): bump the dev-dependencies group with 2 updates',
    { body: 'Updates `a` from 1.2.0 to 1.3.0\nUpdates `typescript` from 5.9.3 to 6.0.2' })), 'major');
});

const run = (name, conclusion, status = 'COMPLETED') => ({ __typename: 'CheckRun', name, status, conclusion });
const ctx = (context, state) => ({ __typename: 'StatusContext', context, state });

test('checkState: no checks', () => {
  assert.deepEqual(checkState({ statusCheckRollup: [] }), { state: 'no checks', failing: [] });
  assert.deepEqual(checkState({}), { state: 'no checks', failing: [] });
});

test('checkState: green when every check is SUCCESS/NEUTRAL/SKIPPED', () => {
  assert.deepEqual(checkState({ statusCheckRollup: [run('lint', 'SUCCESS'), run('e2e', 'SKIPPED'), run('codeql', 'NEUTRAL'), ctx('ci/x', 'SUCCESS')] }),
    { state: 'green', failing: [] });
});

test('checkState: pending wins over failing', () => {
  assert.equal(checkState({ statusCheckRollup: [run('lint', 'FAILURE'), run('build', '', 'IN_PROGRESS')] }).state, 'pending');
  assert.equal(checkState({ statusCheckRollup: [run('lint', 'SUCCESS'), ctx('ci/x', 'PENDING')] }).state, 'pending');
  assert.equal(checkState({ statusCheckRollup: [run('lint', null, 'QUEUED')] }).state, 'pending');
});

test('checkState: failing lists each failing check once', () => {
  assert.deepEqual(checkState({ statusCheckRollup: [run('lint', 'FAILURE'), run('lint', 'FAILURE'), run('build', 'SUCCESS'), run('e2e', 'TIMED_OUT'), ctx('ci/x', 'ERROR')] }),
    { state: 'failing', failing: ['lint', 'e2e', 'ci/x'] });
});
