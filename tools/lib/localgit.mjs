// Local clone state: which branch is checked out, whether the default branch has
// commits not on origin, and uncommitted changes. Read-only git calls.

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { ROOT } from './manifest.mjs';

const git = (repoPath, args) => {
  const r = spawnSync('git', ['-C', repoPath, ...args], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
};

export function localState(repo) {
  const repoPath = join(ROOT, repo);
  const defaultRef = git(repoPath, ['rev-parse', '--abbrev-ref', 'origin/HEAD']); // "origin/main"
  const defaultBranch = defaultRef?.replace(/^origin\//, '') ?? 'main';
  const branch = git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const count = (range) => { const n = git(repoPath, ['rev-list', '--count', range]); return n === null ? null : Number(n); };
  const status = git(repoPath, ['status', '--porcelain']);
  return {
    branch,
    onDefault: branch === defaultBranch,
    unpushed: defaultRef ? count(`${defaultRef}..${defaultBranch}`) : null, // local default branch ahead of origin
    dirty: status === null ? null : status.split('\n').filter(Boolean).length,
  };
}
