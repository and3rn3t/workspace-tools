#!/usr/bin/env node
// git-doctor.mjs — find and (optionally) fix stray duplicate files inside
// .git directories across the workspace. These show up as "index 2",
// "HEAD 2", "MERGE_HEAD 2", broken ref files/dirs with a " N" suffix, etc. —
// almost certainly macOS/iCloud Drive conflict-duplication racing with git's
// own writes to .git/, since this folder lives under a synced Documents path.
//
// This is not cosmetic: a stray " N"-suffixed file under .git/refs/ can
// break `git fetch`/`git status` outright (it did, twice, this session —
// catastrophe and homehub both had fetches fail with "did not send all
// necessary objects" / bad object errors until the stray ref was removed).
//
// It also flags stale lock files (`*.lock` older than a day, e.g. index.lock
// left behind by a killed git process). These block every commit/pull with
// "Unable to create '.git/index.lock': File exists" — 16 repos carried empty
// July-7 locks until 2026-10-20. --fix removes only *empty* stale locks; a
// non-empty one is reported for a manual look.
//
//   node tools/git-doctor.mjs            # report only
//   node tools/git-doctor.mjs --fix      # delete stray files/dirs found
//   node tools/git-doctor.mjs --repo=guess

import { readdirSync, statSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = new Set(['tools', 'node_modules']);

const args = process.argv.slice(2);
const FIX = args.includes('--fix');
const onlyRepo = (args.find(a => a.startsWith('--repo=')) || '').split('=')[1];

const C = { reset: '\x1b[0m', dim: '\x1b[2m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m' };

// Matches "name 2", "name 10", "name 28", etc. — the macOS conflict-duplicate
// naming pattern. Deliberately broad: anything inside .git/ with this suffix
// is git-internal state, never tracked working-tree content, so it's always
// safe to delete regardless of which exact filename it duplicates.
const STRAY_RE = / \d+$/;
const LOCK_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// Every sibling repo plus the two dot-named ones that other tools skip:
// `.github` (the org repo — it carried July-7 locks that blocked moving the v1
// tag) and `.` (this workspace-tools root repo itself).
function repos() {
  const siblings = readdirSync(ROOT, { withFileTypes: true })
    .filter(e => e.isDirectory() && !SKIP.has(e.name) && (!e.name.startsWith('.') || e.name === '.github'))
    .map(e => e.name);
  return ['.', ...siblings]
    .filter(name => !onlyRepo || name === onlyRepo)
    .sort();
}

// Each finding: { path, kind: 'stray' | 'lock', fixable }.
function findStray(dir, out) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (STRAY_RE.test(e.name)) {
      out.push({ path: full, kind: 'stray', fixable: true });
      continue; // don't recurse into a stray dir looking for more strays — the whole thing goes
    }
    if (e.isFile() && e.name.endsWith('.lock')) {
      const st = statSync(full);
      if (Date.now() - st.mtimeMs > LOCK_MAX_AGE_MS) out.push({ path: full, kind: 'lock', fixable: st.size === 0 });
      continue;
    }
    if (e.isDirectory()) findStray(full, out);
  }
}

let totalFound = 0, totalFixed = 0, reposAffected = 0;

for (const repo of repos()) {
  const gitDir = join(ROOT, repo, '.git');
  try { statSync(gitDir); } catch { continue; } // not a git repo (or a submodule gitlink file)

  const found = [];
  findStray(gitDir, found);
  if (found.length === 0) continue;

  reposAffected++;
  totalFound += found.length;
  console.log(`${C.cyan}${repo}${C.reset} ${C.yellow}${found.length} finding(s)${C.reset}`);
  for (const { path: f, kind, fixable } of found) {
    const rel = f.slice(ROOT.length + 1) + (kind === 'lock' ? ` ${C.yellow}(stale lock${fixable ? '' : ', not empty — check manually'})${C.reset}` : '');
    if (FIX && fixable) {
      try {
        rmSync(f, { recursive: true, force: true });
        totalFixed++;
        console.log(`  ${C.green}removed${C.reset} ${C.dim}${rel}${C.reset}`);
      } catch (e) {
        console.log(`  ${C.red}failed${C.reset} ${C.dim}${rel} (${e.message})${C.reset}`);
      }
    } else {
      console.log(`  ${C.dim}${rel}${C.reset}`);
    }
  }
}

console.log(`\n${C.dim}────────────────────────────────────────${C.reset}`);
if (totalFound === 0) {
  console.log(`${C.green}clean — no stray .git internal files or stale locks found${C.reset}`);
} else if (FIX) {
  console.log(`${totalFixed}/${totalFound} stray file(s)/stale lock(s) removed across ${reposAffected} repo(s)`);
} else {
  console.log(`${totalFound} stray file(s)/stale lock(s) found across ${reposAffected} repo(s) — re-run with --fix to remove`);
  console.log(`${C.dim}These never touch tracked content, so deleting them is always safe (non-empty locks are left for a manual check).${C.reset}`);
  console.log(`${C.dim}Root cause is likely iCloud Drive syncing this folder while git writes to .git/ —`);
  console.log(`consider excluding the GitHub folder from iCloud sync to stop this recurring.${C.reset}`);
}
process.exit(0);
