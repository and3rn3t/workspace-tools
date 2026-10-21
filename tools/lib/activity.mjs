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

export const ACTIVE_DAYS = 90;
const BOT = /renovate|dependabot|github-actions|\[bot\]/i;
const MANAGED = new Set(MANIFEST.map(m => m.dest));
const HOUSEKEEPING = new Set(['.consistency-ignore', 'AGENTS.md', 'CLAUDE.md', '.github/dependabot.yml']);
const isHousekeeping = f => MANAGED.has(f) || HOUSEKEEPING.has(f);

// Force a tier regardless of commit history, e.g. a seasonal project that
// should stay polished: { 'weather-app': 'active' }.
export const TIER_OVERRIDES = {};

export function projectCommits(repo, days = ACTIVE_DAYS) {
  const repoPath = join(ROOT, repo);
  const log = (ref) => spawnSync('git', ['-C', repoPath, 'log', ref, `--since=${days}.days`, '--format=%x00%an <%ae>', '--name-only'], { encoding: 'utf8' });
  // The default branch on origin, not the checked-out branch's upstream: a repo
  // left on a PR branch must not count unmerged PR work as activity.
  let r = log('origin/HEAD');
  if (r.status !== 0) r = log('@{u}');
  if (r.status !== 0) r = log('HEAD');
  if (r.status !== 0) return 0;
  return r.stdout.split('\0').slice(1).filter(entry => {
    const [author, ...files] = entry.split('\n').filter(Boolean);
    return !BOT.test(author) && files.some(f => !isHousekeeping(f));
  }).length;
}

export function tierFor(repo) {
  if (TIER_OVERRIDES[repo]) return TIER_OVERRIDES[repo];
  return projectCommits(repo) > 0 ? 'active' : 'dormant';
}
