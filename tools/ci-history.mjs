#!/usr/bin/env node
// ci-history.mjs — daily CI pass rate per repo over the last N days, from GitHub
// Actions run history on each default branch (active workflows only). GitHub
// keeps the history, so every run recomputes the full window — nothing to
// backfill or store.
//
//   node tools/ci-history.mjs              # → .dashboard-data/ci_history.json (30 days)
//   node tools/ci-history.mjs --days=14
//   node tools/ci-history.mjs --repo=guess --print
//
// Pass rate = successes / (successes + failures), where failures include
// timed_out and startup_failure; cancelled and skipped runs are ignored.
//
// Also flags flaky workflows → .dashboard-data/flaky.json: a workflow is flaky
// when one commit both passed and failed (scheduled runs and re-triggers hit the
// same SHA — no code changed, the result did), or when it flipped pass↔fail at
// least FLIP_LIMIT times in the last FLIP_DAYS days. Only default-branch runs are
// read, so a test that flakes only on PR branches isn't caught here.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, listRepos } from './lib/manifest.mjs';
import { resolveToken, apiClient, repoSlug } from './lib/github.mjs';
import { loadMeta } from './lib/presentation.mjs';
import { tierFor } from './lib/activity.mjs';

const args = process.argv.slice(2);
const DAYS = Number((args.find(a => a.startsWith('--days=')) || '--days=30').split('=')[1]);
const onlyRepo = (args.find(a => a.startsWith('--repo=')) || '').split('=')[1];
const OUT = join(ROOT, '.dashboard-data', 'ci_history.json');
const FLAKY_OUT = join(ROOT, '.dashboard-data', 'flaky.json');
const FLIP_DAYS = 14, FLIP_LIMIT = 3;
// Workflows whose outcome follows settings rather than code (bot updaters,
// publishing, releases) aren't test flakiness — a fixed token re-run on the same
// commit is a fix, not a flake.
const NOT_TESTS = /dependabot updates|publish|release|deploy|stale|label|drafter/i;
const FAIL = new Set(['failure', 'timed_out', 'startup_failure']);

const token = resolveToken();
if (!token) { console.error('no GitHub token found'); process.exit(1); }
const api = apiClient(token);
const meta = loadMeta();
const since = new Date(Date.now() - DAYS * 86400000).toISOString().slice(0, 10);

async function repoHistory(dir) {
  const m = meta?.repos?.[dir];
  if (m?.archived || m?.error) return [];
  const slug = repoSlug(join(ROOT, dir), dir);
  const branch = m?.defaultBranch ?? 'main';
  const workflows = await api(`/repos/${slug}/actions/workflows?per_page=100`);
  const activeWf = new Map((workflows.data?.workflows ?? []).filter(w => w.state === 'active').map(w => [w.id, w.name]));
  const byDay = new Map();
  const byWorkflow = new Map(); // workflow_id → [{sha, ok, at, url}]
  for (let page = 1; page <= 10; page++) {
    const res = await api(`/repos/${slug}/actions/runs?branch=${branch}&status=completed&created=>=${since}&per_page=100&page=${page}`);
    const runs = res.data?.workflow_runs ?? [];
    for (const run of runs) {
      if (!activeWf.has(run.workflow_id)) continue;
      const day = run.created_at.slice(0, 10);
      const d = byDay.get(day) ?? { passed: 0, failed: 0 };
      const ok = run.conclusion === 'success' ? true : FAIL.has(run.conclusion) ? false : null;
      if (ok === true) d.passed++; else if (ok === false) d.failed++;
      byDay.set(day, d);
      if (ok !== null) (byWorkflow.get(run.workflow_id) ?? byWorkflow.set(run.workflow_id, []).get(run.workflow_id)).push({ sha: run.head_sha, ok, at: run.created_at, url: run.html_url });
    }
    if (runs.length < 100) break;
  }
  const tier = tierFor(dir);
  const flipSince = new Date(Date.now() - FLIP_DAYS * 86400000).toISOString();
  for (const [id, runs] of byWorkflow) {
    runs.sort((a, b) => a.at.localeCompare(b.at));
    const bySha = new Map();
    for (const r of runs) (bySha.get(r.sha) ?? bySha.set(r.sha, new Set()).get(r.sha)).add(r.ok);
    const mixedShas = [...bySha.values()].filter(s => s.size === 2).length;
    const recent = runs.filter(r => r.at >= flipSince);
    const flips = recent.slice(1).filter((r, i) => r.ok !== recent[i].ok).length;
    if (NOT_TESTS.test(activeWf.get(id))) continue;
    if (mixedShas || flips >= FLIP_LIMIT) {
      const lastFail = [...runs].reverse().find(r => !r.ok);
      flaky.push({ repo: dir, tier, workflow: activeWf.get(id), mixed_commits: mixedShas, flips_14d: flips, runs: runs.length, pass_rate: Math.round(runs.filter(r => r.ok).length / runs.length * 100), last_failure: lastFail?.at?.slice(0, 10) ?? null, last_failure_url: lastFail?.url ?? null });
    }
  }
  return [...byDay.entries()].filter(([, d]) => d.passed + d.failed > 0).map(([date, d]) => ({
    date, repo: dir, tier, passed: d.passed, failed: d.failed, pass_rate: Math.round((d.passed / (d.passed + d.failed)) * 100),
  }));
}

const dirs = listRepos(onlyRepo);
const rows = [];
const flaky = [];
for (let i = 0; i < dirs.length; i += 6) {
  const batch = await Promise.all(dirs.slice(i, i + 6).map(d => repoHistory(d).catch(() => [])));
  batch.forEach(r => rows.push(...r));
}
rows.sort((a, b) => a.repo.localeCompare(b.repo) || a.date.localeCompare(b.date));

flaky.sort((a, b) => (a.tier === b.tier ? b.mixed_commits - a.mixed_commits || b.flips_14d - a.flips_14d : a.tier === 'active' ? -1 : 1));

if (args.includes('--print')) { console.table(rows); console.table(flaky); process.exit(0); }
mkdirSync(join(ROOT, '.dashboard-data'), { recursive: true });
writeFileSync(OUT, JSON.stringify(rows));
// The dashboard refuses an empty file; an all-blank row stands for "none flagged".
writeFileSync(FLAKY_OUT, JSON.stringify(flaky.length ? flaky : [{ repo: '', tier: '', workflow: '', mixed_commits: 0, flips_14d: 0, runs: 0, pass_rate: null, last_failure: null, last_failure_url: null }]));
console.log(`ci history → ${OUT} (${rows.length} repo-day rows since ${since} across ${new Set(rows.map(r => r.repo)).size} repos)`);
console.log(`flaky → ${FLAKY_OUT} (${flaky.length} workflow(s) flagged${flaky.length ? `: ${flaky.slice(0, 6).map(f => `${f.repo}/${f.workflow}`).join(', ')}` : ''})`);
