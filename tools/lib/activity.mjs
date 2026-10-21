// Activity tiers: which repos are "active" (held to the full presentation
// standard) vs "dormant" (baseline consistency only).
//
// Active = at least one human commit on the upstream branch in the last
// ACTIVE_DAYS days that touches real project files. Bot commits (Renovate,
// Dependabot, Actions) and workspace-wide sweeps that only touch managed
// baseline files (e.g. a release-drafter fix rolled out to every repo) or
// agent docs / bot config (AGENTS.md, CLAUDE.md, dependabot.yml) don't count;
// repo-specific workflow changes do. Uses @{u} so work pushed from elsewhere
// counts even when the local clone is behind; falls back to HEAD.

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { ROOT, MANIFEST } from './manifest.mjs';
import { loadWorkspace } from './workspace.mjs';

export const ACTIVE_DAYS = 90;
const BOT = /renovate|dependabot|github-actions|\[bot\]/i;
const MANAGED = new Set(MANIFEST.map(m => m.dest));
const HOUSEKEEPING = new Set(['.consistency-ignore', 'AGENTS.md', 'CLAUDE.md', '.github/dependabot.yml']);
const isHousekeeping = f => MANAGED.has(f) || HOUSEKEEPING.has(f);

// Force a tier regardless of commit history with `"tier": "active"` (or
// "dormant") on the repo's workspace.json entry; "auto" (default) uses commits.
const tierOverride = repo => {
  const tier = loadWorkspace()?.repos?.[repo]?.tier;
  return tier && tier !== 'auto' ? tier : null;
};

// Commit dates (YYYY-MM-DD, newest first) of qualifying human project commits.
function projectCommitDates(repo, days) {
  const repoPath = join(ROOT, repo);
  const log = (ref) => spawnSync('git', ['-C', repoPath, 'log', ref, `--since=${days}.days`, '--format=%x00%cs %an <%ae>', '--name-only'], { encoding: 'utf8' });
  // The default branch on origin, not the checked-out branch's upstream: a repo
  // left on a PR branch must not count unmerged PR work as activity.
  let r = log('origin/HEAD');
  if (r.status !== 0) r = log('@{u}');
  if (r.status !== 0) r = log('HEAD');
  if (r.status !== 0) return [];
  return r.stdout.split('\0').slice(1).flatMap(entry => {
    const [header, ...files] = entry.split('\n').filter(Boolean);
    const date = header.slice(0, 10), author = header.slice(11);
    return !BOT.test(author) && files.some(f => !isHousekeeping(f)) ? [date] : [];
  });
}

export const projectCommits = (repo, days = ACTIVE_DAYS) => projectCommitDates(repo, days).length;

// Date of the most recent human project commit on the default branch, or null.
export const lastProjectCommit = repo => projectCommitDates(repo, 3650)[0] ?? null;

export function tierFor(repo) {
  const forced = tierOverride(repo);
  if (forced) return forced;
  return projectCommits(repo) > 0 ? 'active' : 'dormant';
}
