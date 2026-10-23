#!/usr/bin/env node
// watchdog.mjs — daily "only tell me what got worse" check.
//
//   make export && node tools/watchdog.mjs      # (make watchdog does both)
//   node tools/watchdog.mjs --json
//   node tools/watchdog.mjs --dry               # report without saving state
//
// Reads the latest export (.dashboard-data/*.json + .github-meta.json), compares
// it with the previous run's state (.dashboard-data/watchdog-state.json, gitignored)
// and prints only changes worth a notification:
//   site-down        a live site's latest check failed (and again daily while down)
//   new-critical     a repo has more open critical security alerts than last run
//   red-24h          a workflow on an active repo's default branch has been failing 24h+
//   new-flaky        a workflow newly flagged flaky
//   budget-breach    an active repo newly over a workspace.json budget
//   alert-sla        weekly reminder while an active repo's oldest critical/high
//                    alert stays past its SLA (the first breach is a budget-breach)
// plus recoveries (site back up, workflow green again, budget back in line) as
// good news. Nothing new → prints "quiet" and exits 0, so a scheduled task can
// notify only when the output isn't "quiet". Events are also written to
// .dashboard-data/watchdog.json for the dashboard.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './lib/manifest.mjs';
import { loadMeta } from './lib/presentation.mjs';
import { budgetsFor } from './lib/budgets.mjs';

const OUT = join(ROOT, '.dashboard-data');
const STATE = join(OUT, 'watchdog-state.json');
const args = process.argv.slice(2);
const JSON_OUT = args.includes('--json');
const DRY = args.includes('--dry');
const DAY = 86400000;
const SLA_REMINDER_DAYS = 7;
const now = Date.now();

const read = (name, fallback) => { try { return JSON.parse(readFileSync(join(OUT, name), 'utf8')); } catch { return fallback; } };
const repos = read('repos.json', []);
const sites = read('sites.json', []).filter(s => s.repo);
const flaky = read('flaky.json', []).filter(f => f.repo);
const budgets = read('budgets.json', []).filter(b => b.repo);
const meta = loadMeta();
if (!repos.length || !meta) { console.error('no export found — run make export first'); process.exit(1); }

const prev = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : null;
const active = new Set(repos.filter(r => r.tier === 'active' && !r.archived).map(r => r.repo));

const next = {
  at: new Date(now).toISOString(),
  sites: Object.fromEntries(sites.map(s => [s.repo, { up: s.up_now, url: s.url, downSince: s.up_now === false ? (prev?.sites?.[s.repo]?.downSince ?? new Date(now).toISOString()) : null, lastReminder: prev?.sites?.[s.repo]?.lastReminder ?? null }])),
  critical: Object.fromEntries(Object.entries(meta.repos).filter(([, m]) => !m.error).map(([r, m]) => [r, (m.dependabot?.critical ?? 0) + (m.codeScanning?.critical ?? 0)])),
  failing: {},
  flaky: flaky.map(f => `${f.repo}|${f.workflow}`),
  budgets: budgets.map(b => `${b.repo}|${b.budget}`),
  sla: {},
};
// Alerts past their SLA (workspace.json budgets: critical_alert_max_days / high_alert_max_days).
for (const [repo, m] of Object.entries(meta.repos)) {
  if (!active.has(repo) || m.error) continue;
  const limits = budgetsFor(repo);
  const over = [['critical', limits.critical_alert_max_days], ['high', limits.high_alert_max_days]]
    .filter(([sev, max]) => max !== null && max !== undefined && (m.oldestAlertDays?.[sev] ?? 0) > max)
    .map(([sev, max]) => ({ sev, days: m.oldestAlertDays[sev], max }));
  if (over.length) next.sla[repo] = { over, lastReminder: prev?.sla?.[repo]?.lastReminder ?? new Date(now).toISOString() };
}
for (const [repo, m] of Object.entries(meta.repos)) {
  if (!active.has(repo) || m.error) continue;
  for (const f of m.failing ?? []) {
    const key = `${repo}|${f.workflow}`;
    const was = prev?.failing?.[key];
    next.failing[key] = { since: was?.since ?? new Date(now).toISOString(), reported: was?.reported ?? false, url: f.url };
  }
}

const events = [];
const add = (kind, severity, repo, text, url) => events.push({ kind, severity, repo, text, url: url ?? null });

if (prev) {
  for (const [repo, s] of Object.entries(next.sites)) {
    const was = prev.sites?.[repo];
    if (s.up === false && was?.up !== false) add('site-down', 'bad', repo, `${s.url} is down (latest site check failed)`);
    else if (s.up === false && (!s.lastReminder || now - Date.parse(s.lastReminder) >= DAY)) { add('site-down', 'bad', repo, `${s.url} still down since ${s.downSince.slice(0, 10)}`); s.lastReminder = new Date(now).toISOString(); }
    else if (s.up === true && was?.up === false) add('site-up', 'good', repo, `${s.url} is back up`);
  }
  for (const [repo, n] of Object.entries(next.critical)) {
    const was = prev.critical?.[repo] ?? 0;
    if (n > was && active.has(repo)) add('new-critical', 'bad', repo, `${n - was} new critical security alert(s) (now ${n})`, `https://github.com/and3rn3t/${repo}/security`);
  }
  for (const [key, f] of Object.entries(next.failing)) {
    if (!f.reported && now - Date.parse(f.since) >= DAY) { const [repo, wf] = key.split('|'); add('red-24h', 'bad', repo, `${wf} has been failing on the default branch since ${f.since.slice(0, 10)}`, f.url); f.reported = true; }
  }
  for (const key of Object.keys(prev.failing ?? {})) {
    if (!next.failing[key]) { const [repo, wf] = key.split('|'); if (active.has(repo)) add('green-again', 'good', repo, `${wf} is passing again`); }
  }
  for (const key of next.flaky) if (!(prev.flaky ?? []).includes(key)) { const [repo, wf] = key.split('|'); add('new-flaky', 'warn', repo, `${wf} newly flagged flaky`); }
  for (const key of next.budgets) if (!(prev.budgets ?? []).includes(key)) { const b = budgets.find(x => `${x.repo}|${x.budget}` === key); add('budget-breach', 'warn', b.repo, `${b.label} ${b.actual}${b.unit === '%' ? '%' : ` ${b.unit}`} is over budget (limit ${b.limit}${b.unit === '%' ? '%' : ` ${b.unit}`})`); }
  for (const [repo, s] of Object.entries(next.sla)) {
    if (!prev.sla?.[repo] || now - Date.parse(s.lastReminder) < SLA_REMINDER_DAYS * DAY) continue;
    add('alert-sla', 'warn', repo, `security SLA still breached: ${s.over.map(o => `oldest ${o.sev} ${o.days} days (limit ${o.max})`).join(', ')} — make security-fix REPO=${repo}`, `https://github.com/and3rn3t/${repo}/security/dependabot`);
    s.lastReminder = new Date(now).toISOString();
  }
  for (const key of prev.budgets ?? []) if (!next.budgets.includes(key)) { const [repo, budget] = key.split('|'); add('budget-ok', 'good', repo, `back within the ${budget.replace(/_/g, ' ')} budget`); }
}

const bad = events.filter(e => e.severity !== 'good');
if (!DRY) {
  writeFileSync(STATE, JSON.stringify(next, null, 2));
  // The dashboard refuses an empty file; an all-blank row stands for "quiet".
  writeFileSync(join(OUT, 'watchdog.json'), JSON.stringify(events.length ? events.map(e => ({ ...e, at: next.at })) : [{ kind: '', severity: '', repo: '', text: '', url: null, at: next.at }]));
}

if (JSON_OUT) { console.log(JSON.stringify({ baseline: !prev, events }, null, 2)); process.exit(0); }
if (!prev) { console.log('baseline recorded — the watchdog reports changes from the next run on'); process.exit(0); }
if (!events.length) { console.log('quiet'); process.exit(0); }
const icon = { bad: '✗', warn: '!', good: '✓' };
for (const e of [...bad, ...events.filter(x => x.severity === 'good')]) console.log(`${icon[e.severity]} ${e.repo}: ${e.text}${e.url ? ` — ${e.url}` : ''}`);
console.log(`\n${bad.length} to look at · ${events.length - bad.length} recovered`);
