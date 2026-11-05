#!/usr/bin/env node
// versions.mjs — stack matrix: declared major version of key packages (react,
// vite, vitest, typescript, tailwindcss, eslint, wrangler, playwright) per repo,
// active repos first, then which repos use the shared @and3rn3t/eslint-config
// (eslint / prettier / tsconfig) and which pnpm/npm version they pin. A major behind the newest one used anywhere in the
// workspace is highlighted — those are the upgrade candidates (handled per repo
// through Renovate's approval-gated major PRs, not bulk-applied).
//
//   node tools/versions.mjs             # table
//   node tools/versions.mjs --json      # machine-readable
//   node tools/versions.mjs --repo=guess

import { listRepos } from './lib/manifest.mjs';
import { tierFor } from './lib/activity.mjs';
import { KEY_PACKAGES, repoVersions, workspaceLatest, behindOf, sharedConfigs } from './lib/versions.mjs';

const args = process.argv.slice(2);
const onlyRepo = (args.find(a => a.startsWith('--repo=')) || '').split('=')[1];
const C = { reset: '\x1b[0m', dim: '\x1b[2m', yellow: '\x1b[33m', green: '\x1b[32m', bold: '\x1b[1m' };

const all = Object.fromEntries(listRepos().map(r => [r, repoVersions(r)]).filter(([, v]) => Object.keys(v).length));
const latest = workspaceLatest(all);
const rows = Object.entries(all)
  .filter(([repo]) => !onlyRepo || repo === onlyRepo)
  .map(([repo, majors]) => ({ repo, tier: tierFor(repo), majors, behind: behindOf(majors, latest), shared: sharedConfigs(repo) }))
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

const shared = rows.filter(r => r.shared);
const mark = on => (on ? `${C.green}${'✓'.padStart(10)}${C.reset}` : `${C.dim}${'·'.padStart(10)}${C.reset}`);
console.log(`\n${C.bold}${'shared config'.padEnd(w)}${'tier'.padEnd(9)}${['eslint', 'prettier', 'tsconfig'].map(c => c.padStart(10)).join('')}  packageManager${C.reset}`);
for (const r of shared) {
  const s = r.shared;
  console.log(`${r.repo.padEnd(w)}${(r.tier === 'active' ? 'active' : 'dormant').padEnd(9)}${mark(s.eslint)}${mark(s.prettier)}${mark(s.tsconfig)}  ${C.dim}${s.packageManager ?? '–'}${C.reset}`);
}
const pnpmVersions = new Set(shared.map(r => r.shared.packageManager).filter(pm => pm?.startsWith('pnpm@')));
const activeNotOnEslint = shared.filter(r => r.tier === 'active' && !r.shared.eslint).map(r => r.repo);
console.log(`\n${activeNotOnEslint.length} active repo(s) not on the shared eslint config${activeNotOnEslint.length ? ': ' + activeNotOnEslint.join(', ') : ''}; ${pnpmVersions.size} distinct pnpm version(s) pinned`);
