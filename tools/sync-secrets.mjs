#!/usr/bin/env node
// sync-secrets.mjs — push shared GitHub Actions secrets to many repos at
// once, instead of re-entering the same value in the GitHub UI per repo.
//
// Define secrets ONCE in a local, gitignored `.secrets.local.json` at the
// workspace root (copy `.secrets.local.example.json` to start):
//
//   {
//     "CLOUDFLARE_ACCOUNT_ID": { "value": "...", "repos": ["guess", "health"] },
//     "CLOUDFLARE_API_TOKEN":  { "value": "...", "repos": ["guess", "health"] }
//   }
//
//   node tools/sync-secrets.mjs                # dry-run: show what would be set
//   node tools/sync-secrets.mjs --apply        # actually push via `gh secret set`
//   node tools/sync-secrets.mjs --repo=guess   # limit to one repo
//   node tools/sync-secrets.mjs --secret=CLOUDFLARE_API_TOKEN  # limit to one secret
//
// Requires the GitHub CLI (`gh`), authenticated (`gh auth login`). This
// script shells out to `gh secret set` for the actual encryption+upload —
// it never implements crypto itself and never logs a secret value.

import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OWNER = 'and3rn3t';
const SECRETS_FILE = join(ROOT, '.secrets.local.json');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const onlyRepo = (args.find(a => a.startsWith('--repo=')) || '').split('=')[1];
const onlySecret = (args.find(a => a.startsWith('--secret=')) || '').split('=')[1];

const C = { reset: '\x1b[0m', dim: '\x1b[2m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m' };

// Safety: refuse to run if gh isn't installed/authenticated, or if the
// secrets file looks like it might not actually be gitignored.
const ghCheck = spawnSync('gh', ['auth', 'status'], { encoding: 'utf8' });
if (ghCheck.status !== 0) {
  console.error('GitHub CLI not found or not authenticated. Install `gh` and run `gh auth login` first.');
  process.exit(2);
}

if (!existsSync(SECRETS_FILE)) {
  console.error(`No ${SECRETS_FILE} found.`);
  console.error('Copy .secrets.local.example.json to .secrets.local.json and fill in real values.');
  process.exit(2);
}

const gitignore = existsSync(join(ROOT, '.gitignore')) ? readFileSync(join(ROOT, '.gitignore'), 'utf8') : '';
if (!gitignore.includes('.secrets.local.json')) {
  console.error(`${C.red}Refusing to run:${C.reset} .secrets.local.json is not listed in .gitignore.`);
  console.error('Add it before running this script — it holds real secret values.');
  process.exit(2);
}

let defs;
try {
  defs = JSON.parse(readFileSync(SECRETS_FILE, 'utf8'));
} catch (e) {
  console.error(`Could not parse ${SECRETS_FILE}: ${e.message}`);
  process.exit(2);
}

let planned = 0, applied = 0, failed = 0;

for (const [name, def] of Object.entries(defs)) {
  if (onlySecret && name !== onlySecret) continue;
  if (!def?.value || !Array.isArray(def?.repos)) {
    console.error(`${C.yellow}skip${C.reset} ${name}: needs a "value" string and a "repos" array`);
    continue;
  }
  for (const repo of def.repos) {
    if (onlyRepo && repo !== onlyRepo) continue;
    planned++;
    if (!APPLY) {
      console.log(`  ${C.dim}would set${C.reset} ${name} ${C.dim}->${C.reset} ${OWNER}/${repo}`);
      continue;
    }
    const r = spawnSync('gh', ['secret', 'set', name, '--repo', `${OWNER}/${repo}`, '--body', def.value], { encoding: 'utf8' });
    if (r.status === 0) {
      applied++;
      console.log(`  ${C.green}set${C.reset} ${name} ${C.dim}->${C.reset} ${OWNER}/${repo}`);
    } else {
      failed++;
      console.log(`  ${C.red}FAILED${C.reset} ${name} ${C.dim}->${C.reset} ${OWNER}/${repo} ${C.dim}(${(r.stderr || '').trim().split('\n')[0]})${C.reset}`);
    }
  }
}

console.log(`\n${C.dim}────────────────────────────────────────${C.reset}`);
if (!APPLY) {
  console.log(`would set ${planned} secret(s) across repos — run with --apply to push them`);
} else {
  console.log(`${applied} set, ${failed} failed, ${planned} planned`);
}
