#!/usr/bin/env node
// plan.mjs — what `make apply` would change to make reality match workspace.json.
// Reads the .github-meta.json cache, so run `make meta` first for fresh GitHub data
// (`make plan` does both).
//
//   node tools/plan.mjs                 # grouped, human-readable
//   node tools/plan.mjs --json          # machine-readable (dashboard)
//   node tools/plan.mjs --repo=guess

import { computePlan, CATEGORIES } from './lib/plan.mjs';
import { validateWorkspace } from './lib/workspace.mjs';
import { loadMeta } from './lib/presentation.mjs';

const args = process.argv.slice(2);
const onlyRepo = (args.find(a => a.startsWith('--repo=')) || '').split('=')[1];
const C = { reset: '\x1b[0m', dim: '\x1b[2m', yellow: '\x1b[33m', green: '\x1b[32m', red: '\x1b[31m', cyan: '\x1b[36m', bold: '\x1b[1m' };

const problems = validateWorkspace();
const changes = computePlan().filter(c => !onlyRepo || c.repo === onlyRepo);

if (args.includes('--json')) {
  console.log(JSON.stringify({ problems, changes }, null, 2));
  process.exit(0);
}

if (problems.length) {
  console.log(`${C.red}${C.bold}workspace.json problems${C.reset}`);
  problems.forEach(p => console.log(`  ${C.red}!${C.reset} ${p}`));
  console.log('');
}

const LABEL = { github: 'GitHub metadata', protection: 'Branch protection', renovate: 'Renovate', archive: 'Archive state', index: 'CLAUDE.md index' };
const show = v => (v === '' || v === undefined ? `${C.dim}(empty)${C.reset}` : String(v));
for (const cat of CATEGORIES) {
  const rows = changes.filter(c => c.category === cat);
  if (!rows.length) continue;
  console.log(`${C.bold}${LABEL[cat]}${C.reset} ${C.dim}(${rows.length})${C.reset}`);
  for (const c of rows) {
    if (c.apply.add || c.apply.remove) {
      const parts = [...(c.apply.add ?? []).map(t => `${C.green}+${t}${C.reset}`), ...(c.apply.remove ?? []).map(t => `${C.red}-${t}${C.reset}`)];
      console.log(`  ${C.yellow}~${C.reset} ${c.repo}: topics ${parts.join(' ')}`);
    } else {
      console.log(`  ${C.yellow}~${C.reset} ${c.repo}: ${c.field} ${show(c.actual)} ${C.dim}→${C.reset} ${show(c.desired)}`);
    }
  }
  console.log('');
}

const meta = loadMeta();
const age = meta ? `GitHub data from ${meta.generatedAt.replace('T', ' ').slice(0, 16)} UTC` : 'no GitHub data — run make meta';
console.log(changes.length
  ? `${changes.length} change(s) to converge · ${age}\n${C.dim}review, then: make apply (asks per category)${C.reset}`
  : `${C.green}no changes — reality matches workspace.json${C.reset} · ${age}`);
