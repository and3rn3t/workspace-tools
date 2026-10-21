#!/usr/bin/env node
// sync-configs.mjs — keep repos consistent with ai-template-repo, safely.
//
// Philosophy: NON-DESTRUCTIVE. This tool only ever *creates missing* files.
// It never overwrites a file a repo already has — several repos (health, guess,
// apple-photos-cleaner) legitimately carry richer/stricter variants and those
// must not be clobbered. To surface divergence, use the drift report, which
// only *reports* — you decide what to reconcile by hand.
//
//   node tools/sync-configs.mjs               # dry-run: show files that WOULD be created
//   node tools/sync-configs.mjs --apply       # create the missing files
//   node tools/sync-configs.mjs --drift       # report files that exist but differ from template
//   node tools/sync-configs.mjs --since-last  # what changed since the last snapshot, then re-snapshot
//   node tools/sync-configs.mjs --json        # machine-readable state of every repo
//   node tools/sync-configs.mjs --repo=guess  # limit to one repo
//   node tools/sync-configs.mjs --verbose     # also show in-sync files
//
// The manifest (which files, which repo types, drift or not) lives in
// tools/lib/manifest.mjs and is shared with dashboard.mjs. AGENTS.md,
// CLAUDE.md, eslint, tsconfig, prettier are intentionally NOT managed —
// their content is inherently repo-specific.

import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { evaluate, listRepos, typeLabel, SNAPSHOT } from './lib/manifest.mjs';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const DRIFT = args.includes('--drift');
const VERBOSE = args.includes('--verbose');
const JSON_OUT = args.includes('--json');
const SINCE = args.includes('--since-last');
const onlyRepo = (args.find(a => a.startsWith('--repo=')) || '').split('=')[1];

const C = { reset: '\x1b[0m', dim: '\x1b[2m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m', red: '\x1b[31m', bold: '\x1b[1m' };

const results = listRepos(onlyRepo).map(evaluate);

const snapshotOf = (rs) => ({
  generatedAt: new Date().toISOString(),
  repos: Object.fromEntries(rs.map(r => [r.repo, { types: [...r.types], missing: r.missing, drift: r.drift, blessed: r.blessed }])),
});
const loadSnapshot = () => { try { return JSON.parse(readFileSync(SNAPSHOT, 'utf8')); } catch { return null; } };
const totals = (rs) => rs.reduce((a, r) => {
  for (const i of r.items) a[i.status] = (a[i.status] || 0) + 1;
  return a;
}, {});

// ── --json ────────────────────────────────────────────────────────────────
if (JSON_OUT) {
  const snap = snapshotOf(results);
  console.log(JSON.stringify({ ...snap, totals: totals(results) }, null, 2));
  process.exit(0);
}

// ── --since-last ──────────────────────────────────────────────────────────
if (SINCE) {
  const prev = loadSnapshot();
  const next = snapshotOf(results);
  if (!prev) {
    console.log(`${C.dim}no previous snapshot — baseline recorded at ${SNAPSHOT}${C.reset}`);
  } else {
    const when = prev.generatedAt.replace('T', ' ').slice(0, 16) + ' UTC';
    const lines = [];
    const diff = (a = [], b = []) => [b.filter(x => !a.includes(x)), a.filter(x => !b.includes(x))];
    for (const [name, cur] of Object.entries(next.repos)) {
      const old = prev.repos[name];
      if (!old) { lines.push(`  ${C.cyan}NEW REPO${C.reset}  ${name} ${C.dim}(${cur.missing.length} missing, ${cur.drift.length} drift — run make sync-apply REPO=${name})${C.reset}`); continue; }
      const [newMiss, fixedMiss] = diff(old.missing, cur.missing);
      const [newDrift, fixedDrift] = diff(old.drift, cur.drift);
      newMiss.forEach(f => lines.push(`  ${C.red}+ missing${C.reset} ${name}: ${f}`));
      newDrift.forEach(f => lines.push(`  ${C.yellow}+ drift${C.reset}   ${name}: ${f}`));
      fixedMiss.forEach(f => lines.push(`  ${C.green}- missing${C.reset} ${name}: ${f} ${C.dim}(now present)${C.reset}`));
      fixedDrift.forEach(f => lines.push(`  ${C.green}- drift${C.reset}   ${name}: ${f} ${C.dim}(resolved or blessed)${C.reset}`));
    }
    if (!onlyRepo) for (const name of Object.keys(prev.repos)) if (!next.repos[name]) lines.push(`  ${C.dim}GONE      ${name} (no longer in workspace)${C.reset}`);
    const count = (s, k) => Object.values(s.repos).reduce((a, r) => a + r[k].length, 0);
    const delta = (k) => { const d = count(next, k) - count(prev, k); return d ? ` (${d > 0 ? '+' : ''}${d})` : ''; };
    console.log(`${C.bold}Changes since ${when}${C.reset}`);
    console.log(lines.length ? lines.join('\n') : `  ${C.dim}no changes${C.reset}`);
    console.log(`\nnow: ${count(next, 'missing')} missing${delta('missing')} · ${count(next, 'drift')} drift${delta('drift')} · ${lines.length} change(s)`);
  }
  if (onlyRepo) console.log(`${C.dim}(--repo given: snapshot not updated)${C.reset}`);
  else writeFileSync(SNAPSHOT, JSON.stringify(next, null, 2) + '\n');
  process.exit(0);
}

// ── default / --apply / --drift ──────────────────────────────────────────
const prev = loadSnapshot();
let created = 0, driftCount = 0, inSync = 0;
for (const r of results) {
  const lines = [];
  for (const { item, status } of r.items) {
    if (status === 'miss-src') { lines.push(`  ${C.red}MISS-SRC${C.reset} ${item.dest} (template missing)`); continue; }
    if (status === 'missing') {
      created++;
      if (!DRIFT) lines.push(`  ${C.green}CREATE${C.reset} ${item.dest}`);
      if (APPLY) { const d = join(r.repoPath, item.dest); mkdirSync(dirname(d), { recursive: true }); writeFileSync(d, readFileSync(item.src)); if (item.exec) chmodSync(d, 0o755); }
      continue;
    }
    if (status === 'drift') { driftCount++; if (DRIFT || VERBOSE) lines.push(`  ${C.yellow}DRIFT ${C.reset} ${item.dest} ${C.dim}(differs from template — review manually)${C.reset}`); continue; }
    if (status !== 'vary') inSync++;   // vary = expected per-repo divergence, not counted either way
    if (!VERBOSE) continue;
    if (status === 'ok') lines.push(`  ${C.dim}ok     ${item.dest}${C.reset}`);
    else if (status === 'blessed') lines.push(`  ${C.dim}bless  ${item.dest} (declared in .consistency-ignore)${C.reset}`);
    else if (status === 'vary') lines.push(`  ${C.dim}vary   ${item.dest} (per-repo, expected)${C.reset}`);
  }
  const isNew = prev && !prev.repos[r.repo];
  if (lines.length || isNew) {
    console.log(`${C.cyan}${r.repo}${C.reset} ${C.dim}[${typeLabel(r.repoPath, r.types)}]${C.reset}${isNew ? ` ${C.bold}NEW${C.reset} ${C.dim}(not in last snapshot)${C.reset}` : ''}`);
    lines.forEach(l => console.log(l));
  }
}

console.log(`\n${C.dim}────────────────────────────────────────${C.reset}`);
console.log(`${APPLY ? 'created' : 'would create'}: ${C.green}${created}${C.reset} missing file(s)   ${C.yellow}${driftCount}${C.reset} drift   ${inSync} in sync`);
if (!APPLY && created > 0) console.log(`${C.dim}run with --apply to create the missing files${C.reset}`);
if (driftCount > 0 && !DRIFT) console.log(`${C.dim}run with --drift to list the ${driftCount} file(s) that differ from the template${C.reset}`);
