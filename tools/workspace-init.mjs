#!/usr/bin/env node
// workspace-init.mjs — add workspace.json entries for repos that aren't declared
// yet, seeded from current reality so a fresh entry produces no `make plan`
// changes until you edit it:
//   group/summary  ← the root CLAUDE.md project index (section + "What it is")
//   github.*       ← .github-meta.json (run `make meta` first)
//   protection     ← 'standard' if the default branch is protected, else 'none'
//   renovate       ← 'disabled' / 'dependabot' when renovate.json has enabled:false
//   featured       ← true for repos currently in the active tier
// Never modifies an existing entry. Creates workspace.json (with defaults and
// policies) if it doesn't exist.
//
//   node tools/workspace-init.mjs           # dry-run: list entries it would add
//   node tools/workspace-init.mjs --apply   # write them

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, listRepos } from './lib/manifest.mjs';
import { tierFor } from './lib/activity.mjs';
import { loadMeta } from './lib/presentation.mjs';
import { WORKSPACE_FILE, GROUPS, loadWorkspace } from './lib/workspace.mjs';

const APPLY = process.argv.includes('--apply');

// CLAUDE.md index: "## <section heading>" followed by "| `repo` ✓ | summary |" rows.
const SECTION_TO_GROUP = Object.fromEntries(Object.entries(GROUPS).map(([k, v]) => [v, k]));
function readIndex() {
  const out = {};
  let group = null;
  for (const line of readFileSync(join(ROOT, 'CLAUDE.md'), 'utf8').split('\n')) {
    const h = line.match(/^## (.+?)\s*$/);
    if (h) { group = SECTION_TO_GROUP[h[1]] ?? null; continue; }
    const row = line.match(/^\| `([^`]+)`[^|]*\| (.+?) \|\s*$/);
    if (row && group) out[row[1]] = { group, summary: row[2] };
  }
  return out;
}

const STANDARD_PROTECTION = {
  required_status_checks: null,
  enforce_admins: false,
  required_pull_request_reviews: { required_approving_review_count: 0, dismiss_stale_reviews: false, require_code_owner_reviews: false },
  restrictions: null,
  allow_force_pushes: false,
  allow_deletions: false,
  required_conversation_resolution: true,
};

const ws = loadWorkspace() ?? {
  $comment: 'Source of truth for workspace settings. Edit, then `make plan` to see what would change and `make apply` to converge. See tools/README.md.',
  owner: 'and3rn3t',
  defaults: { protection: 'standard', renovate: 'tier' },
  policies: {
    protection: { standard: STANDARD_PROTECTION },
    renovate: { active: 'github>and3rn3t/.github//renovate-config', dormant: 'github>and3rn3t/.github//renovate-config-dormant' },
  },
  repos: {},
};

const index = readIndex();
const meta = loadMeta()?.repos ?? {};
const added = [];
for (const repo of listRepos()) {
  if (ws.repos[repo]) continue;
  const m = meta[repo] && !meta[repo].error ? meta[repo] : {};
  let renovate;
  try {
    if (JSON.parse(readFileSync(join(ROOT, repo, 'renovate.json'), 'utf8')).enabled === false) {
      renovate = existsSync(join(ROOT, repo, '.github', 'dependabot.yml')) ? 'dependabot' : 'disabled';
    }
  } catch {}
  ws.repos[repo] = {
    group: index[repo]?.group ?? 'meta',
    summary: index[repo]?.summary ?? '',
    ...(m.archived ? { archived: true } : {}),
    featured: !m.archived && !m.fork && tierFor(repo) === 'active' && repo !== 'and3rn3t',
    github: { description: m.description ?? '', homepage: m.homepage ?? '', topics: m.topics ?? [] },
    protection: m.protected === false ? 'none' : 'standard',
    ...(renovate ? { renovate } : {}),
  };
  added.push(repo);
}

// Keep entries sorted so diffs stay readable.
ws.repos = Object.fromEntries(Object.entries(ws.repos).sort(([a], [b]) => a.localeCompare(b)));
console.log(added.length ? `${APPLY ? 'added' : 'would add'} ${added.length} repo(s): ${added.join(', ')}` : 'every local repo is already declared');
const unindexed = added.filter(r => !index[r]);
if (unindexed.length) console.log(`not in the CLAUDE.md index (group defaulted to "meta", empty summary): ${unindexed.join(', ')}`);
if (APPLY && added.length) { writeFileSync(WORKSPACE_FILE, JSON.stringify(ws, null, 2) + '\n'); console.log(`written → ${WORKSPACE_FILE}`); }
