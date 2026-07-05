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

import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = new Set(['ai-template-repo', '.github', '.git', 'tools', 'node_modules']);
const OWNER = 'and3rn3t';
const QUICK = process.argv.includes('--quick');

const C = { reset: '\x1b[0m', dim: '\x1b[2m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m', bold: '\x1b[1m' };
const section = (title) => console.log(`\n${C.bold}── ${title} ──${C.reset}`);

function resolveToken() {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  const r = spawnSync('gh', ['auth', 'token'], { encoding: 'utf8' });
  if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  return null;
}

function lastLine(output) {
  const lines = output.trim().split('\n').filter(Boolean);
  return lines[lines.length - 1] || '';
}

function runNode(script, argv = []) {
  return spawnSync('node', [join(ROOT, 'tools', script), ...argv], { cwd: ROOT, encoding: 'utf8' });
}

// ── 1. Dashboard (consistency score) ────────────────────────────────────
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

// ── 6. Live CI health (latest run per repo) ─────────────────────────────
if (!QUICK) {
  section('CI health (latest run per repo)');
  if (!TOKEN) {
    console.log(`${C.dim}skipped — no GitHub token found${C.reset}`);
  } else {
    async function gh(path) {
      const res = await fetch(`https://api.github.com${path}`, {
        headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      });
      if (!res.ok) return null;
      return res.json();
    }
    const repos = readdirSync(ROOT, { withFileTypes: true })
      .filter(e => e.isDirectory() && !SKIP.has(e.name) && !e.name.startsWith('.'))
      .map(e => e.name).sort();

    const problems = [];
    let checked = 0;
    for (const repo of repos) {
      const runs = await gh(`/repos/${OWNER}/${repo}/actions/runs?per_page=1`);
      const run = runs?.workflow_runs?.[0];
      if (!run) continue;
      checked++;
      if (run.conclusion === 'startup_failure' || run.conclusion === 'failure') {
        problems.push({ repo, name: run.name, conclusion: run.conclusion, url: run.html_url });
      }
    }
    if (problems.length === 0) {
      console.log(`${C.green}${checked} repo(s) checked, all latest runs green${C.reset}`);
    } else {
      console.log(`${checked} repo(s) checked, ${C.red}${problems.length} with a failing latest run${C.reset}`);
      for (const p of problems) {
        const tag = p.conclusion === 'startup_failure' ? `${C.red}startup_failure${C.reset} ${C.dim}(workflow-level bug, not a flaky test)${C.reset}` : `${C.red}failure${C.reset}`;
        console.log(`  ${p.repo.padEnd(20)} ${p.name.padEnd(20)} ${tag}`);
      }
    }
  }
}

console.log(`\n${C.dim}────────────────────────────────────────${C.reset}`);
console.log(QUICK ? 'Quick report done (local checks only).' : 'Full report done.');
