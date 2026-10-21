#!/usr/bin/env node
// export.mjs — write the hosted workspace dashboard's datasets as JSON row files.
//
//   node tools/export.mjs      # → .dashboard-data/*.json (gitignored) + history files (tracked)
//
// Datasets (arrays of row objects, one file each):
//   summary       one row of headline figures
//   repos         one row per repo: workspace.json settings + consistency, presentation,
//                 CI, security, backlog, local git state, stack
//   checks        what each repo is missing: baseline files, drift, failed presentation checks
//   security      open alerts per repo and source (dependabot / code-scanning / secret-scanning)
//   plan          pending `make plan` changes
//   ci            failing workflows on each default branch
//   ci_history    daily CI pass rate per repo, last 30 days (tools/ci-history.mjs)
//   versions      key package majors per repo
//   history       one row per day for the workspace (workspace-history.json, tracked)
//   repo_history  one row per repo per day (workspace-history-repos.json, tracked)
// Also writes manifest.json (dataset → file, sha256) so a refresh uploads only what changed.
//
// Uses the GitHub cache (.github-meta.json) — `make export` refreshes it first.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT, listRepos, typeLabel } from './lib/manifest.mjs';
import { scoreRepo } from './lib/scores.mjs';
import { tierFor, lastProjectCommit } from './lib/activity.mjs';
import { evaluatePresentation, loadMeta } from './lib/presentation.mjs';
import { repoVersions, workspaceLatest, behindOf, KEY_PACKAGES } from './lib/versions.mjs';
import { computePlan } from './lib/plan.mjs';
import { loadWorkspace, repoSettings } from './lib/workspace.mjs';
import { localState } from './lib/localgit.mjs';

const OUT = join(ROOT, '.dashboard-data');
const HISTORY = join(ROOT, 'workspace-history.json');
const REPO_HISTORY = join(ROOT, 'workspace-history-repos.json');
mkdirSync(OUT, { recursive: true });

// Network-bound helpers run in parallel; each is optional (no token → skipped).
const runJson = (script, args = []) => new Promise(resolve => {
  const p = spawn('node', [join(ROOT, 'tools', script), ...args], { cwd: ROOT });
  let out = '';
  p.stdout.on('data', d => { out += d; });
  p.on('close', code => { try { resolve(code === 0 ? JSON.parse(out) : null); } catch { resolve(null); } });
});
const runScript = (script) => new Promise(resolve => spawn('node', [join(ROOT, 'tools', script)], { cwd: ROOT, stdio: 'ignore' }).on('close', code => resolve(code === 0)));
const [renovate, secretsAudit, ciOk] = await Promise.all([
  runJson('renovate-status.mjs', ['--json']),
  runJson('audit-secrets.mjs', ['--json']),
  runScript('ci-history.mjs'),
]);
const renovatePending = Object.fromEntries((renovate ?? []).map(r => [r.repo, r.pending]));
const unsetSecrets = Object.fromEntries((secretsAudit ?? []).map(r => [r.repo, r.missing.length]));

const ws = loadWorkspace();
const meta = loadMeta();
const names = listRepos();
const versions = Object.fromEntries(names.map(r => [r, repoVersions(r)]));
const latest = workspaceLatest(versions);
const plan = computePlan(ws, meta);
const today = new Date().toISOString().slice(0, 10);
const daysSince = (date) => (date ? Math.floor((Date.now() - new Date(date).getTime()) / 86400000) : null);
const sev = (s, k) => (s ? (s[k] ?? 0) : null);

const checks = [];
const security = [];
const repos = names.map(name => {
  const { ev, have, total, score } = scoreRepo(name);
  const s = repoSettings(name, ws) ?? {};
  const m = meta?.repos?.[name] && !meta.repos[name].error ? meta.repos[name] : null;
  const tier = tierFor(name);
  const pres = evaluatePresentation(name, meta);
  const behind = Object.keys(versions[name]).length ? behindOf(versions[name], latest) : [];
  const local = localState(name);
  const lastHuman = lastProjectCommit(name);

  ev.missing.forEach(item => checks.push({ repo: name, tier, kind: 'missing file', item }));
  ev.drift.forEach(item => checks.push({ repo: name, tier, kind: 'drifted file', item }));
  if (tier === 'active') pres.checks.filter(c => c.status === 'fail').forEach(c => checks.push({ repo: name, tier, kind: 'presentation', item: c.label }));

  const sources = [['dependabot', m?.dependabot], ['code-scanning', m?.codeScanning]];
  for (const [source, counts] of sources) if (counts?.total) security.push({ repo: name, tier, source, critical: counts.critical ?? 0, high: counts.high ?? 0, medium: counts.medium ?? 0, low: counts.low ?? 0, total: counts.total });
  if (m?.secretScanning) security.push({ repo: name, tier, source: 'secret-scanning', critical: m.secretScanning, high: 0, medium: 0, low: 0, total: m.secretScanning });
  const critHigh = m ? [m.dependabot, m.codeScanning].reduce((a, c) => a + (sev(c, 'critical') ?? 0) + (sev(c, 'high') ?? 0), 0) + (m.secretScanning ?? 0) : null;

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
    security_critical_high: critHigh,
    security_total: m ? (m.dependabot?.total ?? 0) + (m.codeScanning?.total ?? 0) + (m.secretScanning ?? 0) : null,
    unset_secrets: unsetSecrets[name] ?? 0,
    open_prs_human: m?.openPrs?.human ?? null,
    open_prs_bot: m?.openPrs?.bot ?? null,
    open_issues: m?.openIssues ?? null,
    renovate_pending: renovatePending[name] ?? 0,
    latest_release: m?.latestRelease ?? null,
    days_since_release: daysSince(m?.latestReleaseAt),
    last_human_commit: lastHuman,
    days_since_human_commit: daysSince(lastHuman),
    branch: local.branch,
    on_default_branch: local.onDefault,
    unpushed: local.unpushed,
    uncommitted: local.dirty,
    protected: m ? m.protected : null,
    renovate: s.renovate ?? null,
    packages_behind: behind.length,
    pending_changes: plan.filter(c => c.repo === name).length,
    description: m?.description ?? '',
    homepage: m?.homepage ?? '',
    topics: (m?.topics ?? []).join(' '),
  };
});

const ci = names.flatMap(name => (meta?.repos?.[name]?.failing ?? []).map(f => ({
  repo: name, tier: repos.find(r => r.repo === name).tier, workflow: f.workflow, conclusion: f.conclusion, url: f.url,
})));

const versionRows = names.flatMap(name => KEY_PACKAGES.filter(p => versions[name][p] !== undefined).map(p => ({
  repo: name, tier: repos.find(r => r.repo === name).tier, package: p, major: versions[name][p], newest: latest[p], behind: versions[name][p] < latest[p],
})));

const planRows = plan.map(c => ({ category: c.category, repo: c.repo, field: c.field, actual: String(c.actual ?? ''), desired: String(c.desired ?? '') }));

let ciHistory = [];
try { ciHistory = JSON.parse(readFileSync(join(OUT, 'ci_history.json'), 'utf8')); } catch {}

const active = repos.filter(r => r.tier === 'active' && !r.archived);
const pct = (rs, have, total) => { const t = rs.reduce((a, r) => a + (total(r) ?? 0), 0); return t ? Math.round(rs.reduce((a, r) => a + (have(r) ?? 0), 0) / t * 100) : null; };
const presTotals = active.map(r => evaluatePresentation(r.repo, meta));
const activeNames = new Set(active.map(r => r.repo));
const week = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
const ciWeek = ciHistory.filter(h => activeNames.has(h.repo) && h.date >= week);
const sum = (rs, k) => rs.reduce((a, r) => a + (Number(r[k]) || 0), 0);
const summary = {
  generated_at: new Date().toISOString(),
  github_data_at: meta?.generatedAt ?? null,
  repos: repos.length,
  active: active.length,
  consistency: pct(repos, r => r.checks_passed, r => r.checks_total),
  active_consistency: pct(active, r => r.checks_passed, r => r.checks_total),
  active_presentation: pct(presTotals, p => p.have, p => p.total),
  failing_workflows_active: ci.filter(c => activeNames.has(c.repo)).length,
  failing_workflows_all: ci.length,
  ci_pass_rate_7d_active: pct(ciWeek, h => h.passed, h => h.passed + h.failed),
  security_critical_high_active: sum(active, 'security_critical_high'),
  security_total_all: sum(repos, 'security_total'),
  waiting_on_you: sum(active, 'open_prs_human') + sum(active, 'open_issues') + sum(active, 'unpushed') + active.filter(r => r.on_default_branch === false).length,
  open_prs_bot: sum(repos, 'open_prs_bot'),
  renovate_pending: sum(repos, 'renovate_pending'),
  pending_changes: plan.length,
  missing_files: sum(repos, 'missing'),
  drift_files: sum(repos, 'drift'),
  unprotected: repos.filter(r => r.protected === false && !r.archived).length,
};

// Tracked history: one workspace row and one row per repo per day (re-running today replaces today's rows).
// workspace-tools is a public repo, so security alert counts are deliberately NOT
// written to these tracked files — they go only to the private dashboard's datasets.
const upsert = (file, rows, keyOf) => {
  let all = [];
  try { all = JSON.parse(readFileSync(file, 'utf8')); } catch {}
  const keys = new Set(rows.map(keyOf));
  all = [...all.filter(r => !keys.has(keyOf(r))), ...rows].sort((a, b) => a.date.localeCompare(b.date) || (a.repo ?? '').localeCompare(b.repo ?? ''));
  writeFileSync(file, JSON.stringify(all, null, 2) + '\n');
  return all;
};
const history = upsert(HISTORY, [{ date: today, consistency: summary.consistency, active_consistency: summary.active_consistency, active_presentation: summary.active_presentation, failing_workflows_active: summary.failing_workflows_active, ci_pass_rate_7d_active: summary.ci_pass_rate_7d_active, pending_changes: summary.pending_changes, active: summary.active }], r => r.date);
const repoHistory = upsert(REPO_HISTORY, repos.filter(r => !r.archived).map(r => ({ date: today, repo: r.repo, tier: r.tier, consistency: r.consistency, presentation: r.presentation, failing_workflows: r.failing_workflows, open_prs_human: r.open_prs_human })), r => `${r.date}|${r.repo}`);

const files = { summary: [summary], repos, checks, security, plan: planRows, ci, ci_history: ciHistory, versions: versionRows, history, repo_history: repoHistory };
const manifest = {};
for (const [id, rows] of Object.entries(files)) {
  const text = JSON.stringify(rows);
  writeFileSync(join(OUT, `${id}.json`), text);
  manifest[id] = { file: `${id}.json`, rows: rows.length, sha256: createHash('sha256').update(text).digest('hex') };
}
writeFileSync(join(OUT, 'manifest.json'), JSON.stringify({ generatedAt: summary.generated_at, datasets: manifest }, null, 2) + '\n');

console.log(`exported ${Object.keys(files).length} datasets → ${OUT} (${repos.length} repos, ${checks.length} open checks, ${security.length} security rows, ${ciHistory.length} CI history rows)`);
const skipped = [!renovate && 'Renovate backlog', !secretsAudit && 'secrets audit', !ciOk && 'CI history'].filter(Boolean);
if (skipped.length) console.log(`skipped (no token or API error): ${skipped.join(', ')}`);
if (!existsSync(join(ROOT, '.github-meta.json'))) console.log('note: no GitHub cache — run make meta for CI/protection/security columns');
