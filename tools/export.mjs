#!/usr/bin/env node
// export.mjs — write the hosted workspace dashboard's datasets as JSON row files.
//
//   node tools/export.mjs      # → .dashboard-data/*.json (gitignored) + workspace-history.json
//
// Datasets (arrays of row objects, one file each):
//   summary   one row of headline figures
//   repos     one row per repo: settings from workspace.json + consistency, presentation, CI, stack
//   plan      pending `make plan` changes
//   ci        failing workflows on each default branch
//   versions  key package majors per repo
//   history   one row per day, from workspace-history.json (tracked, so the trend survives)
//
// Uses the GitHub cache (.github-meta.json) — run `make meta` first, or `make publish-data`.
// The upload to the hosted page is done by Claude (Artifact asset upload); see tools/README.md.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, listRepos, typeLabel } from './lib/manifest.mjs';
import { scoreRepo } from './lib/scores.mjs';
import { tierFor } from './lib/activity.mjs';
import { evaluatePresentation, loadMeta } from './lib/presentation.mjs';
import { repoVersions, workspaceLatest, behindOf, KEY_PACKAGES } from './lib/versions.mjs';
import { computePlan } from './lib/plan.mjs';
import { loadWorkspace, repoSettings } from './lib/workspace.mjs';

const OUT = join(ROOT, '.dashboard-data');
const HISTORY = join(ROOT, 'workspace-history.json');
mkdirSync(OUT, { recursive: true });

const ws = loadWorkspace();
const meta = loadMeta();
const names = listRepos();
const versions = Object.fromEntries(names.map(r => [r, repoVersions(r)]));
const latest = workspaceLatest(versions);
const plan = computePlan(ws, meta);
const lastCommit = p => { const r = spawnSync('git', ['-C', p, 'log', '-1', 'origin/HEAD', '--format=%cs'], { encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : null; };

const repos = names.map(name => {
  const { ev, have, total, score } = scoreRepo(name);
  const s = repoSettings(name, ws) ?? {};
  const m = meta?.repos?.[name];
  const tier = tierFor(name);
  const pres = evaluatePresentation(name, meta);
  const behind = Object.keys(versions[name]).length ? behindOf(versions[name], latest) : [];
  return {
    repo: name,
    tier,
    group: s.group ?? null,
    summary: s.summary ?? '',
    stack: typeLabel(ev.repoPath, ev.types),
    featured: !!s.featured,
    archived: !!(s.archived || m?.archived),
    consistency: score,
    checks_passed: have,
    checks_total: total,
    missing: ev.missing.length,
    drift: ev.drift.length,
    presentation: tier === 'active' ? pres.score : null,
    presentation_todo: tier === 'active' ? pres.checks.filter(c => c.status === 'fail').map(c => c.label).join(', ') : '',
    failing_workflows: m?.failing?.length ?? null,
    protected: m && !m.error ? m.protected : null,
    renovate: s.renovate ?? null,
    packages_behind: behind.length,
    pending_changes: plan.filter(c => c.repo === name).length,
    last_commit: lastCommit(ev.repoPath),
    description: m?.description ?? '',
    homepage: m?.homepage ?? '',
    topics: (m?.topics ?? []).join(' '),
  };
});

const ci = names.flatMap(name => (meta?.repos?.[name]?.failing ?? []).map(f => ({
  repo: name, tier: tierFor(name), workflow: f.workflow, conclusion: f.conclusion, url: f.url,
})));

const versionRows = names.flatMap(name => KEY_PACKAGES.filter(p => versions[name][p] !== undefined).map(p => ({
  repo: name, tier: repos.find(r => r.repo === name).tier, package: p, major: versions[name][p], newest: latest[p], behind: versions[name][p] < latest[p],
})));

const planRows = plan.map(c => ({ category: c.category, repo: c.repo, field: c.field, actual: String(c.actual ?? ''), desired: String(c.desired ?? '') }));

const active = repos.filter(r => r.tier === 'active');
const pct = (rs, have, total) => { const t = rs.reduce((a, r) => a + (total(r) ?? 0), 0); return t ? Math.round(rs.reduce((a, r) => a + (have(r) ?? 0), 0) / t * 100) : null; };
const presTotals = active.map(r => evaluatePresentation(r.repo, meta));
const today = new Date().toISOString().slice(0, 10);
const summary = {
  generated_at: new Date().toISOString(),
  github_data_at: meta?.generatedAt ?? null,
  repos: repos.length,
  active: active.length,
  consistency: pct(repos, r => r.checks_passed, r => r.checks_total),
  active_consistency: pct(active, r => r.checks_passed, r => r.checks_total),
  active_presentation: pct(presTotals, p => p.have, p => p.total),
  failing_workflows_active: ci.filter(c => c.tier === 'active').length,
  failing_workflows_all: ci.length,
  pending_changes: plan.length,
  missing_files: repos.reduce((a, r) => a + r.missing, 0),
  drift_files: repos.reduce((a, r) => a + r.drift, 0),
  unprotected: repos.filter(r => r.protected === false && !r.archived).length,
};

// One history row per day: re-running today replaces today's row.
let history = [];
try { history = JSON.parse(readFileSync(HISTORY, 'utf8')); } catch {}
const todayRow = { date: today, consistency: summary.consistency, active_consistency: summary.active_consistency, active_presentation: summary.active_presentation, failing_workflows_active: summary.failing_workflows_active, pending_changes: summary.pending_changes, active: summary.active };
history = [...history.filter(h => h.date !== today), todayRow].sort((a, b) => a.date.localeCompare(b.date));
writeFileSync(HISTORY, JSON.stringify(history, null, 2) + '\n');

const files = { summary: [summary], repos, plan: planRows, ci, versions: versionRows, history };
for (const [id, rows] of Object.entries(files)) writeFileSync(join(OUT, `${id}.json`), JSON.stringify(rows));
console.log(`exported ${Object.keys(files).length} datasets → ${OUT} (${repos.length} repos, ${planRows.length} plan changes, ${ci.length} failing workflows, ${history.length} history day(s))`);
if (!existsSync(join(ROOT, '.github-meta.json'))) console.log('note: no GitHub cache — run make meta for CI/protection/topics columns');
