#!/usr/bin/env node
// apply.mjs — converge reality to workspace.json, one category at a time.
// Shows the same changes as `make plan` and asks before each category.
//
//   node tools/apply.mjs                         # interactive: y/N per category
//   node tools/apply.mjs --yes=github,index      # non-interactive: only these categories
//   node tools/apply.mjs --repo=guess            # limit to one repo
//
// What each category does:
//   github      gh repo edit (description, homepage, add/remove topics)
//   protection  PUT the named protection policy; `none` DELETEs protection
//   renovate    swaps the and3rn3t preset in renovate.json (left uncommitted)
//   archive     gh repo archive / unarchive
//   index       rewrites the project-index block of the root CLAUDE.md (left uncommitted)
// GitHub-side changes refresh .github-meta.json for the touched repos afterwards.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { ROOT } from './lib/manifest.mjs';
import { computePlan, CATEGORIES, renderIndex, currentIndex } from './lib/plan.mjs';
import { loadWorkspace, validateWorkspace } from './lib/workspace.mjs';

const args = process.argv.slice(2);
const onlyRepo = (args.find(a => a.startsWith('--repo=')) || '').split('=')[1];
const yesArg = args.find(a => a.startsWith('--yes='));
const preApproved = yesArg ? new Set(yesArg.split('=')[1].split(',')) : null;
const C = { reset: '\x1b[0m', dim: '\x1b[2m', yellow: '\x1b[33m', green: '\x1b[32m', red: '\x1b[31m', bold: '\x1b[1m' };

const ws = loadWorkspace();
const problems = validateWorkspace(ws);
if (problems.length) {
  console.log(`${C.red}workspace.json has problems — fix them first (make plan lists them)${C.reset}`);
  process.exit(1);
}
const OWNER = ws.owner;
const changes = computePlan(ws).filter(c => !onlyRepo || c.repo === onlyRepo);
if (!changes.length) { console.log(`${C.green}nothing to apply — reality matches workspace.json${C.reset}`); process.exit(0); }

const run = (cmd, argv, input) => {
  const r = spawnSync(cmd, argv, { encoding: 'utf8', input });
  return r.status === 0 ? { ok: true } : { ok: false, err: (r.stderr || r.stdout).trim().split('\n').pop() };
};

const APPLY = {
  github(c) {
    if (c.field === 'topics') {
      const argv = ['repo', 'edit', `${OWNER}/${c.repo}`];
      c.apply.add.forEach(t => argv.push('--add-topic', t));
      c.apply.remove.forEach(t => argv.push('--remove-topic', t));
      return run('gh', argv);
    }
    return run('gh', ['repo', 'edit', `${OWNER}/${c.repo}`, `--${c.field}`, c.desired]);
  },
  protection(c) {
    const path = `repos/${OWNER}/${c.repo}/branches/main/protection`;
    if (c.desired === 'none') return run('gh', ['api', '-X', 'DELETE', path]);
    return run('gh', ['api', '-X', 'PUT', path, '--input', '-'], JSON.stringify(ws.policies.protection[c.desired]));
  },
  renovate(c) {
    if (!c.actual.startsWith('github>') || !c.desired.startsWith('github>')) return { ok: false, err: `switching ${c.actual} → ${c.desired} is a manual change (enable/disable Renovate or Dependabot by hand)` };
    const file = join(ROOT, c.repo, 'renovate.json');
    writeFileSync(file, readFileSync(file, 'utf8').replace(c.actual, c.desired));
    return { ok: true, local: `${c.repo}/renovate.json` };
  },
  archive(c) {
    return run('gh', ['repo', c.desired ? 'archive' : 'unarchive', `${OWNER}/${c.repo}`, '--yes']);
  },
  index() {
    const idx = currentIndex();
    writeFileSync(join(ROOT, 'CLAUDE.md'), idx.text.slice(0, idx.start) + renderIndex(ws) + idx.text.slice(idx.end));
    return { ok: true, local: 'CLAUDE.md' };
  },
};

const rl = preApproved ? null : createInterface({ input: process.stdin, output: process.stdout });
const touchedRemote = new Set(), touchedLocal = [];
let failed = 0;
for (const cat of CATEGORIES) {
  const rows = changes.filter(c => c.category === cat);
  if (!rows.length) continue;
  console.log(`\n${C.bold}${cat}${C.reset} ${C.dim}(${rows.length})${C.reset}`);
  rows.forEach(c => console.log(`  ~ ${c.repo}: ${c.field} ${C.dim}${c.actual || '(empty)'}${C.reset} → ${c.desired || '(empty)'}`));
  const risky = cat === 'archive' || rows.some(c => cat === 'protection' && c.desired === 'none');
  let go;
  if (preApproved) go = preApproved.has(cat);
  else go = /^y(es)?$/i.test(await rl.question(`apply ${rows.length} ${cat} change(s)${risky ? ` ${C.red}(archives/unprotects repos)${C.reset}` : ''}? [y/N] `));
  if (!go) { console.log(`  ${C.dim}skipped${C.reset}`); continue; }
  for (const c of rows) {
    const res = APPLY[cat](c);
    if (res.ok) {
      console.log(`  ${C.green}✓${C.reset} ${c.repo}`);
      if (res.local) touchedLocal.push(res.local); else touchedRemote.add(c.repo);
    } else { failed++; console.log(`  ${C.red}✗${C.reset} ${c.repo}: ${res.err}`); }
  }
}
rl?.close();

for (const repo of touchedRemote) spawnSync('node', [join(ROOT, 'tools', 'github-meta.mjs'), `--repo=${repo}`], { encoding: 'utf8' });
console.log(`\n${failed ? `${C.red}${failed} failed${C.reset} · ` : ''}${touchedRemote.size} repo(s) updated on GitHub${touchedLocal.length ? ` · local files changed (commit them): ${touchedLocal.join(', ')}` : ''}`);
