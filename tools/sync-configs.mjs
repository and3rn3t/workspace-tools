#!/usr/bin/env node
// sync-configs.mjs — keep repos consistent with ai-template-repo, safely.
//
// Philosophy: NON-DESTRUCTIVE. This tool only ever *creates missing* files.
// It never overwrites a file a repo already has — several repos (health, guess,
// apple-photos-cleaner) legitimately carry richer/stricter variants and those
// must not be clobbered. To surface divergence, use the drift report, which
// only *reports* — you decide what to reconcile by hand.
//
//   node tools/sync-configs.mjs               # dry-run: show files that WOULD be created
//   node tools/sync-configs.mjs --apply       # create the missing files
//   node tools/sync-configs.mjs --drift       # report files that exist but differ from template
//   node tools/sync-configs.mjs --repo=guess  # limit to one repo
//   node tools/sync-configs.mjs --verbose     # also show in-sync files
//
// Managed files are type-aware (node / python / xcode / all). AGENTS.md,
// CLAUDE.md, eslint, tsconfig, prettier are intentionally NOT managed here —
// their content is inherently repo-specific.

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TPL = join(ROOT, 'ai-template-repo');
const PYTPL = join(ROOT, 'tools', 'templates', 'python');
const GHTPL = join(ROOT, '.github', 'workflow-templates');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const DRIFT = args.includes('--drift');
const VERBOSE = args.includes('--verbose');
const onlyRepo = (args.find(a => a.startsWith('--repo=')) || '').split('=')[1];

// Managed files. All created if-missing; `drift:true` means "worth flagging when
// it exists but differs" (files that are meant to converge). Files expected to
// diverge per-repo (renovate, LICENSE, .gitignore) have drift:false.
const MANIFEST = [
  { dest: '.editorconfig',           src: join(TPL, '.editorconfig'),             types: ['all'],    drift: true  },
  { dest: 'SECURITY.md',             src: join(TPL, 'SECURITY.md'),               types: ['all'],    drift: false },
  { dest: 'LICENSE',                 src: join(TPL, 'LICENSE'),                   types: ['all'],    drift: false },
  { dest: '.gitignore',              src: join(TPL, '.gitignore'),                types: ['all'],    drift: false },
  { dest: '.nvmrc',                  src: join(TPL, '.nvmrc'),                     types: ['node'],   drift: true  },
  { dest: 'commitlint.config.mjs',   src: join(TPL, 'commitlint.config.mjs'),     types: ['node'],   drift: false },
  { dest: '.lintstagedrc.json',      src: join(TPL, '.lintstagedrc.json'),        types: ['node'],   drift: true  },
  { dest: '.husky/commit-msg',       src: join(TPL, '.husky/commit-msg'),         types: ['node'],   drift: true,  exec: true },
  { dest: 'renovate.json',           src: join(TPL, 'renovate.json'),             types: ['node'],   drift: false },
  { dest: 'renovate.json',           src: join(PYTPL, 'renovate.json'),           types: ['python'], drift: false },
  { dest: '.pre-commit-config.yaml', src: join(PYTPL, '.pre-commit-config.yaml'), types: ['python'], drift: true  },
  // Language-agnostic: every repo (including Xcode-only) should carry the PR-time
  // consistency guard so drift on the files above gets caught automatically.
  { dest: '.github/workflows/consistency.yml', src: join(GHTPL, 'consistency.yml'), types: ['all'], drift: true },
  // Same logic for secret scanning — every repo, regardless of language.
  { dest: '.github/workflows/gitleaks.yml', src: join(GHTPL, 'gitleaks.yml'), types: ['all'], drift: true },
  // Stale-issue/PR closer. drift:false — repos are free to hand-tune their own
  // thresholds/messages once created (see weather-app's richer version, which
  // predates this and is intentionally left alone rather than overwritten).
  { dest: '.github/workflows/stale.yml', src: join(GHTPL, 'stale.yml'), types: ['all'], drift: false },
  // Validates every other workflow file's YAML against the real Actions
  // schema — caught a real bug in reusable-cloudflare-pages-deploy.yml's
  // first draft, so it earns its place as a universal baseline file too.
  { dest: '.github/workflows/actionlint.yml', src: join(GHTPL, 'actionlint.yml'), types: ['all'], drift: true },
];

// Never treated as a sync target.
const SKIP = new Set(['ai-template-repo', '.github', '.git', 'tools', 'node_modules']);

function detectTypes(repoPath) {
  const t = new Set();
  if (existsSync(join(repoPath, 'package.json'))) t.add('node');
  if (existsSync(join(repoPath, 'pyproject.toml'))) t.add('python');
  const hasXcode = (dir, depth) => {
    if (depth < 0) return false;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return false; }
    for (const e of entries) {
      if (e.name.endsWith('.xcodeproj')) return true;
      if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules'
          && hasXcode(join(dir, e.name), depth - 1)) return true;
    }
    return false;
  };
  if (hasXcode(repoPath, 1)) t.add('xcode');
  return t;
}

const applies = (fileTypes, repoTypes) => fileTypes.includes('all') || fileTypes.some(t => repoTypes.has(t));

// A repo can declare intentional drift in .consistency-ignore (one path per line).
const ignoredFor = (repoPath) => {
  const f = join(repoPath, '.consistency-ignore');
  if (!existsSync(f)) return new Set();
  return new Set(readFileSync(f, 'utf8').split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('#')));
};

const listRepos = () => readdirSync(ROOT, { withFileTypes: true })
  .filter(e => e.isDirectory() && !SKIP.has(e.name) && !e.name.startsWith('.'))
  .map(e => e.name)
  .filter(name => !onlyRepo || name === onlyRepo)
  .sort();

const C = { reset: '\x1b[0m', dim: '\x1b[2m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m', red: '\x1b[31m' };
let created = 0, driftCount = 0, inSync = 0;
const driftDetail = [];

for (const repo of listRepos()) {
  const repoPath = join(ROOT, repo);
  const types = detectTypes(repoPath);
  const typeLabel = [...types].join('+') || 'other';
  const ignored = ignoredFor(repoPath);
  const lines = [];

  for (const item of MANIFEST) {
    if (!applies(item.types, types)) continue;
    if (!existsSync(item.src)) { lines.push(`  ${C.red}MISS-SRC${C.reset} ${item.dest} (template missing)`); continue; }

    const destPath = join(repoPath, item.dest);
    const srcContent = readFileSync(item.src);

    if (!existsSync(destPath)) {
      lines.push(`  ${C.green}CREATE${C.reset} ${item.dest}`);
      created++;
      if (APPLY) { mkdirSync(dirname(destPath), { recursive: true }); writeFileSync(destPath, srcContent); if (item.exec) chmodSync(destPath, 0o755); }
      continue;
    }

    // exists — check drift only for convergent files
    const same = readFileSync(destPath).equals(srcContent);
    if (same) { inSync++; if (VERBOSE) lines.push(`  ${C.dim}ok     ${item.dest}${C.reset}`); continue; }
    if (ignored.has(item.dest)) { inSync++; if (VERBOSE) lines.push(`  ${C.dim}bless  ${item.dest} (declared in .consistency-ignore)${C.reset}`); continue; }
    if (item.drift) {
      driftCount++;
      driftDetail.push(`${repo}: ${item.dest}`);
      if (DRIFT || VERBOSE) lines.push(`  ${C.yellow}DRIFT ${C.reset} ${item.dest} ${C.dim}(differs from template — review manually)${C.reset}`);
    } else if (VERBOSE) {
      lines.push(`  ${C.dim}vary   ${item.dest} (per-repo, expected)${C.reset}`);
    }
  }

  if (lines.length) { console.log(`${C.cyan}${repo}${C.reset} ${C.dim}[${typeLabel}]${C.reset}`); lines.forEach(l => console.log(l)); }
}

console.log(`\n${C.dim}────────────────────────────────────────${C.reset}`);
console.log(`${APPLY ? 'created' : 'would create'}: ${C.green}${created}${C.reset} missing file(s)   ${C.yellow}${driftCount}${C.reset} drift   ${inSync} in sync`);
if (!APPLY && created > 0) console.log(`${C.dim}run with --apply to create the missing files${C.reset}`);
if (driftCount > 0 && !DRIFT) console.log(`${C.dim}run with --drift to list the ${driftCount} file(s) that differ from the template${C.reset}`);
