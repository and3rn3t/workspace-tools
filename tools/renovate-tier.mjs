#!/usr/bin/env node
// renovate-tier.mjs — point each repo's renovate.json at the shared preset that
// matches its activity tier (tools/lib/activity.mjs):
//   active  → github>and3rn3t/.github//renovate-config          (weekly, normal limits)
//   dormant → github>and3rn3t/.github//renovate-config-dormant  (monthly window, 2 open PRs)
//
//   node tools/renovate-tier.mjs              # dry-run: show what would change
//   node tools/renovate-tier.mjs --apply      # rewrite the `extends` entry
//   node tools/renovate-tier.mjs --repo=guess
//
// Only the and3rn3t preset entry in `extends` is swapped; local overrides
// (guess's packageRules, etc.) are kept. Repos with `"enabled": false` or no
// and3rn3t preset are never changed — an *active* repo with Renovate disabled
// is flagged so you can decide whether to turn it on.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, listRepos } from './lib/manifest.mjs';
import { tierFor } from './lib/activity.mjs';
import { loadMeta } from './lib/presentation.mjs';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const onlyRepo = (args.find(a => a.startsWith('--repo=')) || '').split('=')[1];

const C = { reset: '\x1b[0m', dim: '\x1b[2m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m' };
const PRESET = { active: 'github>and3rn3t/.github//renovate-config', dormant: 'github>and3rn3t/.github//renovate-config-dormant' };
const IS_PRESET = /^github>and3rn3t\/\.github\/\/renovate-config(-dormant)?$/;

const archived = new Set(Object.entries(loadMeta()?.repos ?? {}).filter(([, m]) => m.archived).map(([name]) => name));

let changed = 0, flagged = 0;
for (const repo of listRepos(onlyRepo)) {
  const file = join(ROOT, repo, 'renovate.json');
  if (!existsSync(file) || archived.has(repo)) continue;
  const raw = readFileSync(file, 'utf8');
  let config;
  try { config = JSON.parse(raw); } catch { console.log(`${C.yellow}${repo}: renovate.json is not valid JSON — skipped${C.reset}`); continue; }
  const tier = tierFor(repo);

  if (config.enabled === false) {
    if (tier === 'active') { flagged++; console.log(`${C.yellow}FLAG${C.reset}    ${repo}: active but Renovate is disabled ("enabled": false) — enable by hand if wanted`); }
    continue;
  }
  const extendsList = config.extends ?? [];
  const i = extendsList.findIndex(e => IS_PRESET.test(e));
  if (i === -1) { console.log(`${C.dim}skip    ${repo}: no and3rn3t preset in extends${C.reset}`); continue; }
  if (extendsList[i] === PRESET[tier]) continue;

  changed++;
  console.log(`${C.cyan}${APPLY ? 'SET' : 'WOULD SET'}${C.reset} ${repo} (${tier}): ${extendsList[i]} → ${PRESET[tier]}`);
  if (APPLY) writeFileSync(file, raw.replace(extendsList[i], PRESET[tier]));
}

console.log(`\n${APPLY ? 'changed' : 'would change'}: ${changed} repo(s)${flagged ? ` · ${flagged} active repo(s) with Renovate disabled` : ''}`);
if (!APPLY && changed) console.log(`${C.dim}run with --apply to rewrite them (the dormant preset must be on and3rn3t/.github's default branch first)${C.reset}`);
