// Desired (workspace.json) vs actual (GitHub meta cache + local files).
// computePlan() returns a flat list of changes; tools/plan.mjs prints them and
// `make apply` (tools/apply.mjs) executes them. Pure reads — nothing here writes.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './manifest.mjs';
import { tierFor } from './activity.mjs';
import { loadMeta } from './presentation.mjs';
import { GROUPS, loadWorkspace, repoSettings } from './workspace.mjs';

export const FEATURED_TOPIC = 'featured';
export const CATEGORIES = ['github', 'protection', 'security', 'renovate', 'archive', 'index'];

const sameSet = (a, b) => a.length === b.length && a.every(x => b.includes(x));

// Topics the repo should carry: its declared topics, plus `featured` when flagged
// (the profile README's featured block selects on that topic).
export function desiredTopics(s) {
  const topics = s.github.topics.filter(t => t !== FEATURED_TOPIC);
  return s.featured ? [...topics, FEATURED_TOPIC].sort() : [...topics].sort();
}

function renovateActual(repo) {
  try {
    const cfg = JSON.parse(readFileSync(join(ROOT, repo, 'renovate.json'), 'utf8'));
    if (cfg.enabled === false) return existsSync(join(ROOT, repo, '.github', 'dependabot.yml')) ? 'dependabot' : 'disabled';
    return (cfg.extends ?? []).find(e => /^github>and3rn3t\/\.github\/\/renovate-config/.test(e)) ?? 'custom';
  } catch { return 'none'; }
}

function renovateDesired(repo, s, ws) {
  if (s.renovate !== 'tier') return s.renovate;
  return ws.policies.renovate[tierFor(repo)];
}

// ── CLAUDE.md project index ────────────────────────────────────────────────
const INDEX_START = `## ${GROUPS.web}`;
const INDEX_END = '## Notes for Claude';

export function renderIndex(ws = loadWorkspace()) {
  return Object.entries(GROUPS).map(([key, heading]) => {
    const rows = Object.entries(ws.repos)
      .filter(([, r]) => r.group === key)
      .map(([name, r]) => `| \`${name}\`${existsSync(join(ROOT, name, 'CLAUDE.md')) ? ' ✓' : ''} | ${r.summary}${r.archived ? ' _(archived)_' : ''} |`);
    return `## ${heading}\n\n| Repo | What it is |\n|---|---|\n${rows.join('\n')}\n`;
  }).join('\n') + '\n';
}

export function currentIndex() {
  const text = readFileSync(join(ROOT, 'CLAUDE.md'), 'utf8');
  const start = text.indexOf(INDEX_START), end = text.indexOf(INDEX_END);
  return start === -1 || end === -1 ? null : { text, start, end, block: text.slice(start, end) };
}

// ── plan ───────────────────────────────────────────────────────────────────
// Change: { category, repo, field, actual, desired, apply? } — `apply` holds
// what tools/apply.mjs needs. Repos without cached meta skip GitHub checks.
export function computePlan(ws = loadWorkspace(), meta = loadMeta()) {
  const changes = [];
  const push = (category, repo, field, actual, desired, apply = {}) => changes.push({ category, repo, field, actual, desired, apply });

  for (const repo of Object.keys(ws.repos)) {
    const s = repoSettings(repo, ws);
    const m = meta?.repos?.[repo];
    const hasMeta = m && !m.error;

    if (hasMeta && s.archived !== m.archived) push('archive', repo, 'archived', m.archived, s.archived);
    if (s.archived || (hasMeta && m.archived)) continue; // archived repos are read-only on GitHub

    if (hasMeta) {
      if (s.github.description !== m.description) push('github', repo, 'description', m.description, s.github.description);
      if (s.github.homepage !== m.homepage) push('github', repo, 'homepage', m.homepage, s.github.homepage);
      const want = desiredTopics(s), have = [...m.topics].sort();
      if (!sameSet(want, have)) push('github', repo, 'topics', have.join(' '), want.join(' '), { add: want.filter(t => !have.includes(t)), remove: have.filter(t => !want.includes(t)) });
      const wantProtected = s.protection !== 'none';
      if (wantProtected !== m.protected) push('protection', repo, 'protection', m.protected ? 'protected' : 'none', s.protection);
      // Security updates need alerts on, so alerts come first in the list (and in apply).
      for (const field of ['alerts', 'updates']) {
        const have = m.security?.[field];
        if (have !== null && have !== undefined && have !== s.security[field]) push('security', repo, field, have ? 'on' : 'off', s.security[field] ? 'on' : 'off');
      }
    }

    if (existsSync(join(ROOT, repo, 'renovate.json'))) {
      const have = renovateActual(repo), want = renovateDesired(repo, s, ws);
      if (have !== 'custom' && have !== want) push('renovate', repo, 'renovate', have, want);
    }
  }

  const idx = currentIndex();
  if (idx && idx.block !== renderIndex(ws)) push('index', 'CLAUDE.md', 'project index', 'out of date', 'regenerate from workspace.json');
  return changes;
}
