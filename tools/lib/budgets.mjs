// Per-repo health budgets: limits declared in workspace.json (`defaults.budgets`,
// overridable per repo with `"budgets": {…}`; `null` turns one off) and checked
// against the export's repo rows. Budgets apply to active repos only — dormant
// repos keep the baseline but aren't held to these targets.

import { loadWorkspace } from './workspace.mjs';

export const DEFAULT_BUDGETS = {
  presentation_min: 90,       // % presentation checks passing
  consistency_min: 90,        // % baseline files/guards present
  ci_pass_rate_30d_min: 90,   // % default-branch runs passing over 30 days
  critical_alert_max_days: 7, // oldest open critical security alert
  high_alert_max_days: 30,    // oldest open high security alert
};

const CHECKS = [
  { key: 'presentation_min', label: 'Presentation', field: 'presentation', min: true, unit: '%' },
  { key: 'consistency_min', label: 'Consistency', field: 'consistency', min: true, unit: '%' },
  { key: 'ci_pass_rate_30d_min', label: 'CI pass rate · 30d', field: 'ci_pass_rate_30d', min: true, unit: '%' },
  { key: 'critical_alert_max_days', label: 'Oldest critical alert', field: 'oldest_critical_alert_days', min: false, unit: ' days' },
  { key: 'high_alert_max_days', label: 'Oldest high alert', field: 'oldest_high_alert_days', min: false, unit: ' days' },
];

export function budgetsFor(repo, ws = loadWorkspace()) {
  return { ...DEFAULT_BUDGETS, ...(ws?.defaults?.budgets ?? {}), ...(ws?.repos?.[repo]?.budgets ?? {}) };
}

// row: an export repos row. Returns breaches: [{repo, budget, label, limit, actual, over}]
export function evaluateBudgets(row, ws = loadWorkspace()) {
  if (row.tier !== 'active' || row.archived) return [];
  const limits = budgetsFor(row.repo, ws);
  const breaches = [];
  for (const c of CHECKS) {
    const limit = limits[c.key];
    const actual = row[c.field];
    if (limit === null || limit === undefined || actual === null || actual === undefined) continue;
    const breached = c.min ? actual < limit : actual > limit;
    if (breached) breaches.push({ repo: row.repo, budget: c.key, label: c.label, limit, actual, over: Math.abs(actual - limit), unit: c.unit.trim() });
  }
  return breaches;
}
