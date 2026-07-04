#!/usr/bin/env node
// new-repo.mjs — bootstrap a new sibling repo that starts consistent with the
// ai-template-repo baseline, so future repos never need backfilling.
//
//   node tools/new-repo.mjs <name> [--type=node|python] [--apply]
//
// Dry-run by default (prints the plan). Pass --apply to create the folder,
// copy baseline files, and `git init`. Node is the default type.

import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TPL = join(ROOT, 'ai-template-repo');
const PYTPL = join(ROOT, 'tools', 'templates', 'python');
const GHTPL = join(ROOT, '.github', 'workflow-templates');

const args = process.argv.slice(2);
const name = args.find(a => !a.startsWith('--'));
const type = (args.find(a => a.startsWith('--type=')) || '--type=node').split('=')[1];
const APPLY = args.includes('--apply');

if (!name) { console.error('usage: node tools/new-repo.mjs <name> [--type=node|python] [--apply]'); process.exit(2); }
if (!['node', 'python'].includes(type)) { console.error(`unknown --type=${type} (use node|python)`); process.exit(2); }

const dest = join(ROOT, name);
if (existsSync(dest)) { console.error(`refusing: ${name}/ already exists`); process.exit(1); }

// Files every new repo gets, by type.
const COMMON = [
  { to: '.editorconfig',  from: join(TPL, '.editorconfig') },
  { to: '.gitignore',     from: join(TPL, '.gitignore') },
  { to: 'SECURITY.md',    from: join(TPL, 'SECURITY.md') },
  { to: 'LICENSE',        from: join(TPL, 'LICENSE') },
  { to: 'AGENTS.md',      from: join(TPL, 'AGENTS.md') },
  { to: 'CLAUDE.md',      from: join(TPL, 'CLAUDE.md') },
];
const NODE = [
  { to: '.nvmrc',                from: join(TPL, '.nvmrc') },
  { to: 'commitlint.config.mjs', from: join(TPL, 'commitlint.config.mjs') },
  { to: '.lintstagedrc.json',    from: join(TPL, '.lintstagedrc.json') },
  { to: '.husky/commit-msg',     from: join(TPL, '.husky/commit-msg'), exec: true },
  { to: 'renovate.json',         from: join(TPL, 'renovate.json') },
];
const PY = [
  { to: 'renovate.json',           from: join(PYTPL, 'renovate.json') },
  { to: '.pre-commit-config.yaml', from: join(PYTPL, '.pre-commit-config.yaml') },
];

// Every new repo gets CI + the PR-time consistency guard from day one — the
// same coverage `make sync-apply` now backfills onto existing repos. The
// $default-branch token in the shared CI templates is a GitHub "create from
// template" substitution that doesn't apply to a plain file copy, so it's
// rewritten to `main` here.
const CI = [
  { to: '.github/workflows/ci.yml', from: join(GHTPL, type === 'node' ? 'node-ci.yml' : 'python-ci.yml'), rewrite: s => s.replace(/\$default-branch/g, 'main') },
  { to: '.github/workflows/consistency.yml', from: join(GHTPL, 'consistency.yml') },
  { to: '.github/workflows/gitleaks.yml', from: join(GHTPL, 'gitleaks.yml') },
  { to: '.github/workflows/stale.yml', from: join(GHTPL, 'stale.yml') },
  { to: '.github/workflows/actionlint.yml', from: join(GHTPL, 'actionlint.yml') },
];

const files = [...COMMON, ...(type === 'node' ? NODE : PY), ...CI];
const starter = type === 'node'
  ? { to: 'package.json', content: JSON.stringify({ name, version: '0.0.0', private: true, type: 'module', engines: { node: '>=24' }, scripts: { lint: 'echo "TODO: lint"', build: 'echo "TODO: build"', test: 'echo "TODO: test"', prepare: 'husky' } }, null, 2) + '\n' }
  : { to: 'pyproject.toml', content: `[project]\nname = "${name}"\nversion = "0.0.0"\nrequires-python = ">=3.10"\n\n[tool.ruff]\nline-length = 100\n` };

console.log(`${APPLY ? 'Creating' : 'Plan for'} new ${type} repo: ${name}/`);
files.forEach(f => console.log(`  + ${f.to}`));
console.log(`  + ${starter.to} (starter)`);
console.log(APPLY ? '' : '\ndry-run — pass --apply to create');

if (!APPLY) process.exit(0);

mkdirSync(dest, { recursive: true });
for (const f of files) {
  const target = join(dest, f.to);
  mkdirSync(dirname(target), { recursive: true });
  const content = f.rewrite ? f.rewrite(readFileSync(f.from, 'utf8')) : readFileSync(f.from);
  writeFileSync(target, content);
  if (f.exec) chmodSync(target, 0o755);
}
writeFileSync(join(dest, starter.to), starter.content);
const gi = spawnSync('git', ['-C', dest, 'init', '-q'], { encoding: 'utf8' });
console.log(gi.status === 0 ? 'git initialized.' : 'note: git init skipped (git unavailable).');
console.log(`\nDone. Next:`);
console.log(`  cd ${name} && ${type === 'node' ? 'npm install' : 'pip install pre-commit && pre-commit install --hook-type commit-msg'}`);
console.log(`  edit AGENTS.md / CLAUDE.md for this repo, then run  make dashboard  to confirm it lands green.`);
