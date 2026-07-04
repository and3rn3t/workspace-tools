#!/usr/bin/env node
// repo-run.mjs — fan a command out across every repo, auto-detecting the
// package manager (pnpm / npm) or Python toolchain. Skips repos that don't
// support the requested command instead of failing the whole run.
//
//   node tools/repo-run.mjs lint        # run lint everywhere it exists
//   node tools/repo-run.mjs build
//   node tools/repo-run.mjs test
//   node tools/repo-run.mjs typecheck
//   node tools/repo-run.mjs format
//   node tools/repo-run.mjs audit       # pnpm/npm audit, or pip-audit
//   node tools/repo-run.mjs doctor      # print each repo's type + available scripts
//   node tools/repo-run.mjs status      # git dirty/ahead-behind snapshot per repo
//   node tools/repo-run.mjs <cmd> --repo=guess   # limit to one repo
//
// Node commands map to package.json scripts (aliases below cover naming drift
// like type-check vs typecheck). Python commands map to ruff/pytest.

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = new Set(['ai-template-repo', '.github', '.git', 'tools', 'node_modules']);

const args = process.argv.slice(2);
const cmd = args[0];
const onlyRepo = (args.find(a => a.startsWith('--repo=')) || '').split('=')[1];

if (!cmd || cmd.startsWith('--')) {
  console.error('usage: node tools/repo-run.mjs <lint|build|test|typecheck|format|audit|outdated|doctor|status> [--repo=name]');
  process.exit(2);
}

// Accept several script names for one logical command (repos name things differently).
const NODE_SCRIPT_ALIASES = {
  lint: ['lint'],
  build: ['build'],
  test: ['test', 'test:unit'],
  typecheck: ['type-check', 'typecheck', 'tsc'],
  format: ['format:check', 'format'],
};

const C = { reset: '\x1b[0m', dim: '\x1b[2m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m', red: '\x1b[31m', bold: '\x1b[1m' };

function detect(repoPath) {
  const isNode = existsSync(join(repoPath, 'package.json'));
  const isPnpm = existsSync(join(repoPath, 'pnpm-lock.yaml'));
  const hasNpmLock = existsSync(join(repoPath, 'package-lock.json'));
  const isPython = existsSync(join(repoPath, 'pyproject.toml'));
  let scripts = {};
  if (isNode) { try { scripts = JSON.parse(readFileSync(join(repoPath, 'package.json'), 'utf8')).scripts || {}; } catch {} }
  // Lockfile drift: both a pnpm-lock.yaml and a package-lock.json present means
  // two package managers have touched this repo — pick one and remove the other.
  const lockfileDrift = isPnpm && hasNpmLock;
  return { isNode, isPnpm, hasNpmLock, isPython, lockfileDrift, pm: isPnpm ? 'pnpm' : 'npm', scripts };
}

function repos() {
  return readdirSync(ROOT, { withFileTypes: true })
    .filter(e => e.isDirectory() && !SKIP.has(e.name) && !e.name.startsWith('.'))
    .map(e => e.name).filter(n => !onlyRepo || n === onlyRepo).sort();
}

function run(cwd, file, argv) {
  const r = spawnSync(file, argv, { cwd, stdio: 'inherit', shell: false });
  return r.status === 0;
}

if (cmd === 'doctor') {
  let driftCount = 0, licenseCount = 0;
  for (const repo of repos()) {
    const repoPath = join(ROOT, repo);
    const d = detect(repoPath);
    const type = [d.isNode && (d.isPnpm ? 'node(pnpm)' : 'node(npm)'), d.isPython && 'python'].filter(Boolean).join('+') || 'other';
    const scriptList = Object.keys(d.scripts).sort().join(', ') || (d.isPython ? 'ruff/pytest' : '—');
    let warn = d.lockfileDrift ? ` ${C.red}⚠ pnpm-lock.yaml + package-lock.json both present — remove one${C.reset}` : '';
    if (d.lockfileDrift) driftCount++;
    // Catch unedited scaffold boilerplate: GitHub Spark's default LICENSE names
    // "GitHub, Inc." as the copyright holder if never customized after generation.
    const licensePath = join(repoPath, 'LICENSE');
    if (existsSync(licensePath) && /Copyright GitHub, Inc\.\s*$/m.test(readFileSync(licensePath, 'utf8'))) {
      warn += ` ${C.red}⚠ LICENSE still says "Copyright GitHub, Inc." — unedited scaffold boilerplate${C.reset}`;
      licenseCount++;
    }
    console.log(`${C.cyan}${repo}${C.reset} ${C.dim}[${type}]${C.reset}${warn}\n  ${C.dim}${scriptList}${C.reset}`);
  }
  if (driftCount) console.log(`\n${C.yellow}${driftCount} repo(s) with lockfile drift.${C.reset}`);
  if (licenseCount) console.log(`${C.red}${licenseCount} repo(s) with unedited "GitHub, Inc." LICENSE boilerplate.${C.reset}`);
  process.exit(0);
}

if (cmd === 'status') {
  // Git dirty/ahead-behind snapshot per repo — surfaces uncommitted work and
  // unpushed commits sitting across the workspace at a glance.
  let dirtyCount = 0, aheadCount = 0;
  for (const repo of repos()) {
    const cwd = join(ROOT, repo);
    if (!existsSync(join(cwd, '.git'))) continue;
    const branchRes = spawnSync('git', ['branch', '--show-current'], { cwd, encoding: 'utf8' });
    const branch = branchRes.stdout.trim() || '(detached)';
    const dirtyRes = spawnSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' });
    const dirty = dirtyRes.stdout ? dirtyRes.stdout.trim().split('\n').filter(Boolean).length : 0;
    const aheadRes = spawnSync('git', ['rev-list', '--count', '@{u}..HEAD'], { cwd, encoding: 'utf8' });
    const behindRes = spawnSync('git', ['rev-list', '--count', 'HEAD..@{u}'], { cwd, encoding: 'utf8' });
    const ahead = aheadRes.status === 0 ? parseInt(aheadRes.stdout.trim(), 10) || 0 : null;
    const behind = behindRes.status === 0 ? parseInt(behindRes.stdout.trim(), 10) || 0 : null;
    if (dirty > 0) dirtyCount++;
    if (ahead) aheadCount++;
    const parts = [];
    if (dirty > 0) parts.push(`${C.yellow}${dirty} uncommitted${C.reset}`);
    if (ahead) parts.push(`${C.cyan}${ahead} ahead${C.reset}`);
    if (behind) parts.push(`${C.red}${behind} behind${C.reset}`);
    if (ahead === null) parts.push(`${C.dim}no upstream${C.reset}`);
    const summary = parts.length ? parts.join(', ') : `${C.green}clean${C.reset}`;
    console.log(`${C.cyan}${repo.padEnd(20)}${C.reset} ${C.dim}[${branch}]${C.reset} ${summary}`);
  }
  console.log(`${C.dim}────────────────────────────────────────${C.reset}`);
  console.log(`${dirtyCount} repo(s) with uncommitted changes, ${aheadCount} repo(s) with unpushed commits.`);
  process.exit(0);
}

if (cmd === 'outdated') {
  // Snapshot of outdated npm/pnpm deps per repo. Needs installed deps + registry
  // access, so it runs on your machine (not CI). Defensive: never throws.
  const major = (v) => { const m = String(v || '').replace(/[^\d.]/g, '').split('.')[0]; return parseInt(m, 10); };
  let grandTotal = 0, grandMajor = 0;
  for (const repo of repos()) {
    const cwd = join(ROOT, repo);
    const d = detect(cwd);
    if (!d.isNode) continue;
    const res = spawnSync(d.pm, d.isPnpm ? ['outdated', '--format', 'json'] : ['outdated', '--json'], { cwd, encoding: 'utf8' });
    let parsed = null;
    try { parsed = JSON.parse(res.stdout || '{}'); } catch { parsed = null; }
    if (parsed === null) { console.log(`${C.cyan}${repo.padEnd(20)}${C.reset} ${C.dim}— run manually (no deps installed or non-JSON output)${C.reset}`); continue; }
    const pkgs = Object.entries(parsed);
    if (!pkgs.length) { console.log(`${C.cyan}${repo.padEnd(20)}${C.reset} ${C.green}up to date${C.reset}`); continue; }
    const majors = pkgs.filter(([, info]) => { const c = major(info.current), l = major(info.latest); return Number.isFinite(c) && Number.isFinite(l) && l > c; });
    grandTotal += pkgs.length; grandMajor += majors.length;
    const sample = majors.slice(0, 5).map(([n, i]) => `${n} ${i.current}→${i.latest}`).join(', ');
    console.log(`${C.cyan}${repo.padEnd(20)}${C.reset} ${C.yellow}${pkgs.length} outdated${C.reset} ${C.dim}(${C.red}${majors.length} major${C.dim})${C.reset}${sample ? `\n  ${C.dim}majors: ${sample}${majors.length > 5 ? ' …' : ''}${C.reset}` : ''}`);
  }
  console.log(`${C.dim}────────────────────────────────────────${C.reset}`);
  console.log(`${grandTotal} outdated dependencies across repos, ${C.red}${grandMajor}${C.reset} major bumps to review.`);
  console.log(`${C.dim}Renovate opens PRs for these; this is a manual snapshot. Python deps not included.${C.reset}`);
  process.exit(0);
}

const results = [];
for (const repo of repos()) {
  const cwd = join(ROOT, repo);
  const d = detect(cwd);
  let ran = null, ok = false;

  if (d.isNode) {
    if (cmd === 'audit') { ran = `${d.pm} audit`; ok = run(cwd, d.pm, ['audit', '--audit-level=high']); }
    else {
      const script = (NODE_SCRIPT_ALIASES[cmd] || [cmd]).find(s => d.scripts[s]);
      if (script) { ran = `${d.pm} run ${script}`; ok = run(cwd, d.pm, ['run', script]); }
    }
  } else if (d.isPython) {
    const PY = {
      lint: ['ruff', ['check', '.']],
      format: ['ruff', ['format', '--check', '.']],
      test: ['pytest', ['-q']],
      audit: ['pip-audit', []],
    }[cmd];
    if (PY && spawnSync('command', ['-v', PY[0]], { shell: true }).status === 0) { ran = PY.join(' '); ok = run(cwd, PY[0], PY[1]); }
    else if (PY) { ran = `${PY[0]} (not installed)`; ok = null; }
  }

  if (ran === null) results.push({ repo, status: 'skip', ran: `no ${cmd}` });
  else if (ok === null) results.push({ repo, status: 'skip', ran });
  else results.push({ repo, status: ok ? 'pass' : 'fail', ran });
}

console.log(`\n${C.bold}── ${cmd} summary ──${C.reset}`);
for (const r of results) {
  const tag = r.status === 'pass' ? `${C.green}PASS${C.reset}` : r.status === 'fail' ? `${C.red}FAIL${C.reset}` : `${C.dim}skip${C.reset}`;
  console.log(`  ${tag}  ${r.repo.padEnd(20)} ${C.dim}${r.ran}${C.reset}`);
}
const failed = results.filter(r => r.status === 'fail');
console.log(`${C.dim}────────────────────────────────────────${C.reset}`);
console.log(`${results.filter(r => r.status === 'pass').length} passed, ${failed.length} failed, ${results.filter(r => r.status === 'skip').length} skipped`);
process.exit(failed.length ? 1 : 0);
