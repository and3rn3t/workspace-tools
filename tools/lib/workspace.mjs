// workspace.json — the declarative source of truth for workspace settings.
//
// Holds what *should* be true for every repo (group, summary, tier override,
// featured flag, GitHub description/homepage/topics, branch-protection policy,
// Renovate mode, Dependabot alerts + security updates). `make plan` diffs it against reality; `make apply` converges.
// Facts that can be derived (stack, deploy target, CLAUDE.md presence) are not
// stored here — they're read from the repos.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, listRepos } from './manifest.mjs';

export const WORKSPACE_FILE = join(ROOT, 'workspace.json');

export const GROUPS = {
  web: 'Web / Cloudflare Workers (React + TS)',
  python: 'Python (CLI tools & skills)',
  apple: 'iOS / macOS (Xcode)',
  game: 'Game dev',
  meta: 'Templates, experiments & misc',
};
const TIERS = new Set(['auto', 'active', 'dormant']);
const RENOVATE = new Set(['tier', 'disabled', 'dependabot']);
const REPO_KEYS = new Set(['group', 'summary', 'tier', 'featured', 'archived', 'github', 'protection', 'renovate', 'automerge', 'budgets', 'security', 'release']);
const RELEASE = new Set(['auto', 'api', 'tag', 'dispatch', 'self', 'off']);
export const DEFAULT_SECURITY = { alerts: true, updates: true };

let cached;
export function loadWorkspace() {
  if (cached !== undefined) return cached;
  cached = existsSync(WORKSPACE_FILE) ? JSON.parse(readFileSync(WORKSPACE_FILE, 'utf8')) : null;
  return cached;
}

// Settings for one repo with defaults applied; null when the repo isn't declared.
export function repoSettings(repo, ws = loadWorkspace()) {
  const own = ws?.repos?.[repo];
  if (!own) return null;
  const d = ws.defaults ?? {};
  return {
    tier: 'auto', featured: false, archived: false, protection: d.protection ?? 'standard', renovate: d.renovate ?? 'tier',
    ...own,
    github: { description: '', homepage: '', topics: [], ...own.github },
    security: { ...DEFAULT_SECURITY, ...d.security, ...own.security },
  };
}

// Structural problems + coverage gaps, as human-readable strings.
export function validateWorkspace(ws = loadWorkspace()) {
  if (!ws) return [`${WORKSPACE_FILE} not found`];
  const problems = [];
  const local = new Set(listRepos());
  for (const [name, r] of Object.entries(ws.repos ?? {})) {
    for (const k of Object.keys(r)) if (!REPO_KEYS.has(k)) problems.push(`${name}: unknown key "${k}"`);
    if (!GROUPS[r.group]) problems.push(`${name}: group must be one of ${Object.keys(GROUPS).join(', ')}`);
    if (r.tier && !TIERS.has(r.tier)) problems.push(`${name}: tier must be auto, active or dormant`);
    if (r.renovate && !RENOVATE.has(r.renovate)) problems.push(`${name}: renovate must be tier, disabled or dependabot`);
    if (r.protection && !ws.policies?.protection?.[r.protection] && r.protection !== 'none') problems.push(`${name}: unknown protection policy "${r.protection}"`);
    if (r.release && !RELEASE.has(r.release)) problems.push(`${name}: release must be one of ${[...RELEASE].join(', ')}`);
    for (const [k, v] of Object.entries(r.security ?? {})) if (!(k in DEFAULT_SECURITY) || typeof v !== 'boolean') problems.push(`${name}: security.${k} must be one of ${Object.keys(DEFAULT_SECURITY).join(', ')} with a true/false value`);
    if (!local.has(name) && !['.github', 'tools', 'ai-template-repo'].includes(name)) problems.push(`${name}: declared but no local folder`);
  }
  for (const name of local) if (!ws.repos?.[name]) problems.push(`${name}: local repo not declared in workspace.json (add an entry)`);
  return problems;
}
