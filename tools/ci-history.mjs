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
  const active = new Set((workflows.data?.workflows ?? []).filter(w => w.state === 'active').map(w => w.id));
  const byDay = new Map();
  for (let page = 1; page <= 10; page++) {
    const res = await api(`/repos/${slug}/actions/runs?branch=${branch}&status=completed&created=>=${since}&per_page=100&page=${page}`);
    const runs = res.data?.workflow_runs ?? [];
    for (const run of runs) {
      if (!active.has(run.workflow_id)) continue;
      const day = run.created_at.slice(0, 10);
      const d = byDay.get(day) ?? { passed: 0, failed: 0 };
      if (run.conclusion === 'success') d.passed++; else if (FAIL.has(run.conclusion)) d.failed++;
      byDay.set(day, d);
    }
    if (runs.length < 100) break;
  }
  const tier = tierFor(dir);
  return [...byDay.entries()].filter(([, d]) => d.passed + d.failed > 0).map(([date, d]) => ({
    date, repo: dir, tier, passed: d.passed, failed: d.failed, pass_rate: Math.round((d.passed / (d.passed + d.failed)) * 100),
  }));
}

const dirs = listRepos(onlyRepo);
const rows = [];
for (let i = 0; i < dirs.length; i += 6) {
  const batch = await Promise.all(dirs.slice(i, i + 6).map(d => repoHistory(d).catch(() => [])));
  batch.forEach(r => rows.push(...r));
}
rows.sort((a, b) => a.repo.localeCompare(b.repo) || a.date.localeCompare(b.date));

if (args.includes('--print')) { console.table(rows); process.exit(0); }
mkdirSync(join(ROOT, '.dashboard-data'), { recursive: true });
writeFileSync(OUT, JSON.stringify(rows));
console.log(`ci history → ${OUT} (${rows.length} repo-day rows since ${since} across ${new Set(rows.map(r => r.repo)).size} repos)`);
