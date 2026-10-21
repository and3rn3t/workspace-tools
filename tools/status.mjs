#!/usr/bin/env node
// status.mjs — one-command "morning report" for the whole workspace. Ties
// together the other tools/*.mjs scripts plus a live GitHub Actions health
// check into a single consolidated summary.
//
//   node tools/status.mjs             # full report
//   node tools/status.mjs --quick     # skip GitHub API calls (dashboard + git-doctor + local git status only)
//
// Auth resolution for the GitHub-API sections (CI health, renovate-status):
// $GH_TOKEN / $GITHUB_TOKEN env var, then `gh auth token`. Sections that need
// a token are skipped (not failed) if none is found.

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { resolveToken } from './lib/github.mjs';
import { loadMeta } from './lib/presentation.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const QUICK = process.argv.includes('--quick');

const C = { reset: '\x1b[0m', dim: '\x1b[2m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m', bold: '\x1b[1m' };
const section = (title) => console.log(`\n${C.bold}── ${title} ──${C.reset}`);

function lastLine(output) {
  const lines = output.trim().split('\n').filter(Boolean);
  return lines[lines.length - 1] || '';
}

function runNode(script, argv = []) {
  return spawnSync('node', [join(ROOT, 'tools', script), ...argv], { cwd: ROOT, encoding: 'utf8' });
}

// ── 1. Dashboard (consistency + presentation) ──────────────────────────
// Full mode refreshes the GitHub metadata cache first so the presentation
// score reflects live descriptions/topics/protection/CI.
if (!QUICK) {
  const metaRun = runNode('github-meta.mjs');
  if (metaRun.status !== 0) console.log(`${C.dim}github-meta skipped: ${lastLine(metaRun.stderr || metaRun.stdout)}${C.reset}`);
}
section('Consistency dashboard');
const dash = runNode('dashboard.mjs');
console.log(dash.status === 0 ? lastLine(dash.stdout) : `${C.red}dashboard.mjs failed${C.reset}`);

// ── 2. git-doctor (stray .git files / broken refs) ──────────────────────
section('Git health (stray files, broken refs)');
const doctor = runNode('git-doctor.mjs');
console.log(doctor.status === 0 || doctor.status === 1 ? lastLine(doctor.stdout) : `${C.red}git-doctor.mjs failed${C.reset}`);

// ── 3. Local git status (dirty / unpushed) ──────────────────────────────
section('Local working trees');
const gstat = runNode('repo-run.mjs', ['status']);
console.log(lastLine(gstat.stdout));

const TOKEN = QUICK ? null : resolveToken();

// ── 4. Secrets audit ─────────────────────────────────────────────────────
if (!QUICK) {
  section('Secrets audit');
  if (!TOKEN) {
    console.log(`${C.dim}skipped — no GitHub token found (set $GH_TOKEN or run \`gh auth login\`)${C.reset}`);
  } else {
    const secrets = runNode('audit-secrets.mjs', ['--json']);
    try {
      const report = JSON.parse(secrets.stdout || '[]');
      const totalMissing = report.reduce((a, r) => a + r.missing.length, 0);
      if (totalMissing === 0) console.log(`${C.green}all referenced secrets are configured${C.reset}`);
      else {
        console.log(`${C.red}${totalMissing} missing secret(s)${C.reset}`);
        for (const r of report) if (r.missing.length) console.log(`  ${r.repo}: ${r.missing.join(', ')}`);
      }
    } catch {
      console.log(`${C.red}audit-secrets.mjs failed or returned non-JSON output${C.reset}`);
    }
  }
}

// ── 5. Renovate Dependency Dashboard backlog ────────────────────────────
if (!QUICK) {
  section('Renovate backlog');
  if (!TOKEN) {
    console.log(`${C.dim}skipped — no GitHub token found${C.reset}`);
  } else {
    const renovate = runNode('renovate-status.mjs', ['--json']);
    try {
      const report = JSON.parse(renovate.stdout || '[]');
      const total = report.reduce((a, r) => a + r.pending, 0);
      const top = report.filter(r => r.pending > 0).slice(0, 5);
      console.log(`${total} pending update(s) across ${report.filter(r => r.pending > 0).length} repo(s)`);
      for (const r of top) console.log(`  ${r.repo.padEnd(20)} ${r.pending}`);
    } catch {
      console.log(`${C.red}renovate-status.mjs failed or returned non-JSON output${C.reset}`);
    }
  }
}

// ── 6. Live CI health (latest run per active workflow, from make meta) ──
if (!QUICK) {
  section('CI health (latest run per workflow on default branch)');
  const meta = loadMeta();
  if (!TOKEN || !meta) {
    console.log(`${C.dim}skipped — no GitHub token / metadata found${C.reset}`);
  } else {
    const entries = Object.entries(meta.repos).filter(([, m]) => !m.error && !m.archived && m.workflows);
    const problems = entries.flatMap(([repo, m]) => m.failing.map(f => ({ repo, ...f })));
    if (problems.length === 0) {
      console.log(`${C.green}${entries.length} repo(s) checked, all workflows green${C.reset}`);
    } else {
      const repoCount = new Set(problems.map(p => p.repo)).size;
      console.log(`${entries.length} repo(s) checked, ${C.red}${problems.length} failing workflow(s) in ${repoCount} repo(s)${C.reset}`);
      for (const p of problems) {
        const tag = p.conclusion === 'startup_failure' ? `${C.red}startup_failure${C.reset} ${C.dim}(workflow-level bug, not a flaky test)${C.reset}` : `${C.red}${p.conclusion}${C.reset}`;
        console.log(`  ${p.repo.padEnd(20)} ${p.workflow.padEnd(32)} ${tag}`);
      }
    }
  }
}

console.log(`\n${C.dim}────────────────────────────────────────${C.reset}`);
console.log(QUICK ? 'Quick report done (local checks only).' : 'Full report done.');
