#!/usr/bin/env node
// versions.mjs — stack matrix: declared major version of key packages (react,
// vite, vitest, typescript, tailwindcss, eslint, wrangler, playwright) per repo,
// active repos first. A major behind the newest one used anywhere in the
// workspace is highlighted — those are the upgrade candidates (handled per repo
// through Renovate's approval-gated major PRs, not bulk-applied).
//
//   node tools/versions.mjs             # table
//   node tools/versions.mjs --json      # machine-readable
//   node tools/versions.mjs --repo=guess

import { listRepos } from './lib/manifest.mjs';
import { tierFor } from './lib/activity.mjs';
import { KEY_PACKAGES, repoVersions, workspaceLatest, behindOf } from './lib/versions.mjs';

const args = process.argv.slice(2);
const onlyRepo = (args.find(a => a.startsWith('--repo=')) || '').split('=')[1];
const C = { reset: '\x1b[0m', dim: '\x1b[2m', yellow: '\x1b[33m', green: '\x1b[32m', bold: '\x1b[1m' };

const all = Object.fromEntries(listRepos().map(r => [r, repoVersions(r)]).filter(([, v]) => Object.keys(v).length));
const latest = workspaceLatest(all);
const rows = Object.entries(all)
  .filter(([repo]) => !onlyRepo || repo === onlyRepo)
  .map(([repo, majors]) => ({ repo, tier: tierFor(repo), majors, behind: behindOf(majors, latest) }))
  .sort((a, b) => (a.tier === b.tier ? a.repo.localeCompare(b.repo) : a.tier === 'active' ? -1 : 1));

if (args.includes('--json')) {
  console.log(JSON.stringify({ latest, repos: rows }, null, 2));
  process.exit(0);
}

const short = { '@playwright/test': 'playwright', tailwindcss: 'tailwind', typescript: 'ts' };
const cols = KEY_PACKAGES.map(p => short[p] || p);
const w = Math.max(...rows.map(r => r.repo.length), 4) + 2;
console.log(`${C.bold}${'repo'.padEnd(w)}${'tier'.padEnd(9)}${cols.map(c => c.padStart(11)).join('')}${C.reset}`);
console.log(`${C.dim}${'newest in use'.padEnd(w + 9)}${KEY_PACKAGES.map(p => String(latest[p] ?? '–').padStart(11)).join('')}${C.reset}`);
for (const r of rows) {
  const cells = KEY_PACKAGES.map(p => {
    const v = r.majors[p];
    if (v === undefined) return `${C.dim}${'·'.padStart(11)}${C.reset}`;
    return r.behind.includes(p) ? `${C.yellow}${String(v).padStart(11)}${C.reset}` : `${C.green}${String(v).padStart(11)}${C.reset}`;
  });
  console.log(`${r.repo.padEnd(w)}${(r.tier === 'active' ? 'active' : 'dormant').padEnd(9)}${cells.join('')}`);
}
const activeBehind = rows.filter(r => r.tier === 'active' && r.behind.length);
console.log(`\n${activeBehind.length} active repo(s) behind the newest major on at least one key package${activeBehind.length ? ': ' + activeBehind.map(r => `${r.repo} (${r.behind.map(p => short[p] || p).join(', ')})`).join('; ') : ''}`);
