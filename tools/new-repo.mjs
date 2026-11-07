#!/usr/bin/env node
// new-repo.mjs — bootstrap a new sibling repo that starts consistent with the
// ai-template-repo baseline, so future repos never need backfilling.
//
//   node tools/new-repo.mjs <name> [--type=node|python] [--apply]
//
// Dry-run by default (prints the plan). Pass --apply to create the folder,
// copy baseline files, and `git init`. Node is the default type.
//
// Sources: every MANIFEST entry that applies to the type (so `make sync` reports
// nothing missing afterwards), the AI instruction files, and the stack profile
// (ai-template-repo/profiles/web for node, profiles/python for python).

import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { ROOT, TPL, PYTPL, MANIFEST, applies } from './lib/manifest.mjs';

const WEBTPL = join(TPL, 'profiles', 'web');
const PLACEHOLDER = 'replace-project-name';

const args = process.argv.slice(2);
const name = args.find(a => !a.startsWith('--'));
const type = (args.find(a => a.startsWith('--type=')) || '--type=node').split('=')[1];
const APPLY = args.includes('--apply');

if (!name) { console.error('usage: node tools/new-repo.mjs <name> [--type=node|python] [--apply]'); process.exit(2); }
if (!['node', 'python'].includes(type)) { console.error(`unknown --type=${type} (use node|python)`); process.exit(2); }
if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) { console.error(`refusing: "${name}" — use lowercase letters, digits and dashes (npm + wrangler naming)`); process.exit(2); }

const dest = join(ROOT, name);
if (existsSync(dest)) { console.error(`refusing: ${name}/ already exists`); process.exit(1); }

// Only git-tracked template files — never node_modules/, dist/ or other output
// left behind by validating a profile in place.
const trackedFiles = dir => execFileSync('git', ['-C', TPL, 'ls-files', '-z', '--', relative(TPL, dir)], { encoding: 'utf8' })
  .split('\0').filter(Boolean).map(p => join(TPL, p));
const fromDir = (dir, { exclude = [] } = {}) => trackedFiles(dir)
  .map(full => ({ to: relative(dir, full), from: full }))
  .filter(f => !exclude.includes(f.to));
const fill = s => s.replaceAll(PLACEHOLDER, name);

// 1. Baseline: exactly what the consistency manifest expects for this type.
const baseline = MANIFEST
  .filter(m => applies(m.types, new Set([type])))
  .map(m => ({ to: m.dest, from: m.src, exec: m.exec }));

// 2. AI instructions + editor files every repo gets (repo-specific after creation, so not in the manifest).
const shared = [
  'AGENTS.md', 'CLAUDE.md', '.github/copilot-instructions.md', '.cursor/rules/project.mdc',
  '.gitattributes', '.vscode/extensions.json', '.vscode/settings.json',
].map(p => ({ to: p, from: join(TPL, p) }))
  .concat(fromDir(join(TPL, '.claude', 'skills')).map(f => ({ ...f, to: join('.claude', 'skills', f.to) })));

// 3. Stack profile + its CI.
const NODE = [
  ...fromDir(WEBTPL, { exclude: ['README.md'] }).map(f => ({ ...f, rewrite: fill })),
  ...['.husky/pre-commit', '.husky/pre-push'].map(p => ({ to: p, from: join(TPL, p), exec: true })),
  ...['Makefile', '.env.example', '.dev.vars.example', '.devcontainer/devcontainer.json'].map(p => ({ to: p, from: join(TPL, p) })),
  { to: '.github/workflows/ci.yml', from: join(TPL, '.github/workflows/ci.yml') },
];
const PY = [
  { to: '.github/workflows/ci.yml', from: join(PYTPL, 'ci.yml') },
];

const generated = [
  { to: 'CHANGELOG.md', content: '# Changelog\n\nAll notable changes to this project will be documented in this file.\n\nThe format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),\nand this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).\n\n## [Unreleased]\n\n### Added\n\n- Initial project scaffold from ai-template-repo\n' },
  { to: 'README.md', content: `# ${name}\n\n**One sentence: what it is and who it's for.**\n\n## Getting started\n\n\`\`\`bash\n${type === 'node' ? 'pnpm install\npnpm dev' : 'pip install -e ".[dev]"\npytest'}\n\`\`\`\n\n## License\n\nMIT — see [LICENSE](LICENSE).\n` },
  ...(type === 'python'
    ? [{ to: 'pyproject.toml', content: `[project]\nname = "${name}"\nversion = "0.0.0"\nrequires-python = ">=3.10"\n\n[project.optional-dependencies]\ndev = ["pytest", "ruff", "pre-commit"]\n\n[tool.ruff]\nline-length = 100\n` }]
    : []),
];

// Later entries win on the same path (e.g. profile files over shared ones).
const byPath = new Map();
for (const f of [...baseline, ...shared, ...(type === 'node' ? NODE : PY), ...generated]) byPath.set(f.to, f);
const files = [...byPath.values()].sort((a, b) => a.to.localeCompare(b.to));

const missingSources = files.filter(f => f.from && !existsSync(f.from));
if (missingSources.length) {
  console.error('refusing: template sources not found (is ai-template-repo cloned next to tools/?):');
  missingSources.forEach(f => console.error(`  ${relative(ROOT, f.from)}`));
  process.exit(1);
}

console.log(`${APPLY ? 'Creating' : 'Plan for'} new ${type} repo: ${name}/  (${files.length} files)`);
files.forEach(f => console.log(`  + ${f.to}${f.content ? ' (generated)' : ''}`));
if (!APPLY) { console.log('\ndry-run — pass --apply to create'); process.exit(0); }

mkdirSync(dest, { recursive: true });
for (const f of files) {
  const target = join(dest, f.to);
  mkdirSync(dirname(target), { recursive: true });
  const content = f.content ?? (f.rewrite ? f.rewrite(readFileSync(f.from, 'utf8')) : readFileSync(f.from));
  writeFileSync(target, content);
  if (f.exec) chmodSync(target, 0o755);
}
const gi = spawnSync('git', ['-C', dest, 'init', '-q', '-b', 'main'], { encoding: 'utf8' });
console.log(gi.status === 0 ? 'git initialized (main).' : 'note: git init skipped (git unavailable).');
console.log('\nDone. Next:');
console.log(`  cd ${name} && ${type === 'node' ? 'pnpm install && pnpm validate' : 'pip install -e ".[dev]" && pre-commit install --hook-type commit-msg'}`);
console.log('  fill in the Project Overview in AGENTS.md, then  make sync REPO=' + name + '  should report nothing missing.');
