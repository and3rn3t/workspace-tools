#!/usr/bin/env node
// dashboard.mjs — scan every repo and emit a self-contained dashboard.html
// showing type, baseline coverage, drift, and a consistency score per repo.
//
//   node tools/dashboard.mjs            # writes ./dashboard.html
//   node tools/dashboard.mjs --open     # also print the path to open
//
// Scores come from the SAME manifest as `make sync` / `make drift`
// (tools/lib/manifest.mjs), so the dashboard and the drift report always agree.
// No dependencies, no network. Regenerate any time (or via the weekly task).

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, SNAPSHOT, evaluate, listRepos, typeLabel } from './lib/manifest.mjs';

// Manifest files grouped into display columns (first matching rule wins).
const GROUPS = [
  { key: 'baseline',  label: 'Baseline',   match: d => ['.editorconfig', 'SECURITY.md', 'LICENSE', '.gitignore', '.nvmrc', 'renovate.json'].includes(d) },
  { key: 'hooks',     label: 'Hooks',      match: d => ['commitlint.config.mjs', '.lintstagedrc.json', '.husky/commit-msg', '.pre-commit-config.yaml'].includes(d) },
  { key: 'community', label: 'Community',  match: d => /^(CODE_OF_CONDUCT|CONTRIBUTING)\.md$|ISSUE_TEMPLATE|pull_request_template/.test(d) },
  { key: 'guards',    label: 'Guards',     match: d => /workflows\/(codeql|gitleaks|consistency|actionlint|dependency-review)\.yml$/.test(d) },
  { key: 'automation',label: 'Automation', match: () => true },
];
const groupOf = d => GROUPS.find(g => g.match(d)).key;

// Checks outside the manifest that still count toward the score.
const hasCI = p => { try { return readdirSync(join(p, '.github', 'workflows')).some(f => /\.ya?ml$/.test(f)); } catch { return false; } };
const EXTRA = [
  { key: 'ci',     label: 'CI',     test: p => hasCI(p) },
  { key: 'agents', label: 'AGENTS', test: p => existsSync(join(p, 'AGENTS.md')) },
];

const gitInfo = p => { const r = spawnSync('git', ['-C', p, 'log', '-1', '--format=%cd', '--date=short'], { encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : ''; };
let snapshot = null; try { snapshot = JSON.parse(readFileSync(SNAPSHOT, 'utf8')); } catch {}

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const PRESENT = new Set(['ok', 'drift', 'vary', 'blessed']);

const rows = listRepos().map(name => {
  const ev = evaluate(name);
  const groups = Object.fromEntries(GROUPS.map(g => [g.key, { have: 0, total: 0, missing: [] }]));
  for (const { item, status } of ev.items) {
    if (status === 'miss-src') continue;
    const g = groups[groupOf(item.dest)];
    g.total++;
    if (PRESENT.has(status)) g.have++; else g.missing.push(item.dest);
  }
  const extras = EXTRA.map(x => x.test(ev.repoPath));
  const have = Object.values(groups).reduce((a, g) => a + g.have, 0) + extras.filter(Boolean).length;
  const total = Object.values(groups).reduce((a, g) => a + g.total, 0) + extras.length;
  return {
    name, typeLabel: typeLabel(ev.repoPath, ev.types), groups, extras, have, total,
    score: total ? Math.round((have / total) * 100) : null,
    missing: ev.missing, drift: ev.drift, blessed: ev.blessed,
    isNew: !!snapshot && !snapshot.repos[name], git: gitInfo(ev.repoPath),
  };
});

const totalPass = rows.reduce((a, r) => a + r.have, 0);
const totalApplicable = rows.reduce((a, r) => a + r.total, 0);
const overall = Math.round((totalPass / totalApplicable) * 100);
const driftTotal = rows.reduce((a, r) => a + r.drift.length, 0);
const missingTotal = rows.reduce((a, r) => a + r.missing.length, 0);
const blessedTotal = rows.reduce((a, r) => a + r.blessed.length, 0);
const noCI = rows.filter(r => !r.extras[0]).map(r => r.name);
const fullyConsistent = rows.filter(r => r.score === 100 && r.drift.length === 0).length;

const groupCell = g => {
  if (!g.total) return '<td class="c na">–</td>';
  const cls = g.have === g.total ? 'yes' : g.have === 0 ? 'no' : 'part';
  const tip = g.missing.length ? ` title="missing: ${esc(g.missing.join(', '))}"` : '';
  return `<td class="c ${cls}"${tip}>${g.have}/${g.total}</td>`;
};
const yn = v => v ? '<td class="c yes">✓</td>' : '<td class="c no">✗</td>';
const scoreClass = s => s === null ? 'na' : s === 100 ? 'ok' : s >= 80 ? 'warn' : 'bad';
const driftCell = r => {
  if (r.drift.length) return `<td class="drift"><details><summary>${r.drift.length} file${r.drift.length > 1 ? 's' : ''}</summary>${r.drift.map(esc).join('<br>')}</details></td>`;
  if (r.blessed.length) return `<td class="blessed" title="${esc(r.blessed.join(', '))}">${r.blessed.length} blessed ✓</td>`;
  return '<td style="color:var(--ok)">—</td>';
};

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>and3rn3t · repo consistency</title>
<style>
  :root{--bg:#0d1117;--panel:#161b22;--border:#30363d;--txt:#e6edf3;--dim:#8b949e;--ok:#2ea043;--warn:#d29922;--bad:#f85149;--accent:#58a6ff}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--txt);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;padding:28px}
  h1{font-size:20px;margin:0 0 4px}
  .sub{color:var(--dim);font-size:13px;margin-bottom:22px}
  .cards{display:flex;gap:14px;flex-wrap:wrap;margin-bottom:24px}
  .card{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:16px 20px;min-width:150px}
  .card .n{font-size:28px;font-weight:600}
  .card .l{color:var(--dim);font-size:12px;text-transform:uppercase;letter-spacing:.04em}
  .ring{height:6px;border-radius:3px;background:#21262d;overflow:hidden;margin-top:10px}
  .ring>i{display:block;height:100%;background:linear-gradient(90deg,var(--warn),var(--ok))}
  .wrap{overflow-x:auto;border:1px solid var(--border);border-radius:10px}
  table{border-collapse:collapse;width:100%;background:var(--panel)}
  th,td{padding:9px 10px;text-align:center;border-bottom:1px solid var(--border);white-space:nowrap;vertical-align:top}
  th{background:#1c2129;color:var(--dim);font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.03em;position:sticky;top:0}
  td.repo,th.repo{text-align:left}
  td.repo{font-weight:600}
  .type{color:var(--dim);font-weight:400;font-size:12px}
  .new{background:rgba(88,166,255,.18);color:var(--accent);font-size:10px;border-radius:4px;padding:1px 5px;margin-left:6px;vertical-align:middle}
  .c{font-weight:700;font-variant-numeric:tabular-nums}
  .c.yes{color:var(--ok)} .c.no{color:var(--bad)} .c.part{color:var(--warn);cursor:help} .c.na{color:#484f58}
  .sc{font-weight:700;border-radius:20px;padding:2px 9px;font-size:12px;display:inline-block}
  .sc.ok{background:rgba(46,160,67,.18);color:#3fb950}
  .sc.warn{background:rgba(210,153,34,.18);color:#e3b341}
  .sc.bad{background:rgba(248,81,73,.18);color:#ff7b72}
  .sc.na{color:#484f58}
  .drift{color:var(--warn);font-size:12px;text-align:left}
  .drift summary{cursor:pointer}
  .blessed{color:var(--dim);font-size:12px}
  .git{color:var(--dim);font-size:12px}
  .legend{color:var(--dim);font-size:12px;margin-top:16px;max-width:900px}
  tr:hover td{background:#1b222c}
</style></head><body>
<h1>Repo consistency dashboard</h1>
<div class="sub">${rows.length} repos · generated ${new Date().toISOString().replace('T',' ').slice(0,16)} UTC · regenerate with <code>make dashboard</code></div>
<div class="cards">
  <div class="card"><div class="l">Overall coverage</div><div class="n">${overall}%</div><div class="ring"><i style="width:${overall}%"></i></div></div>
  <div class="card"><div class="l">Fully consistent</div><div class="n">${fullyConsistent}/${rows.length}</div></div>
  <div class="card"><div class="l">Missing files</div><div class="n" style="color:${missingTotal?'var(--bad)':'var(--ok)'}">${missingTotal}</div><div class="l" style="margin-top:6px">fix: make sync-apply</div></div>
  <div class="card"><div class="l">Drift items</div><div class="n" style="color:${driftTotal?'var(--warn)':'var(--ok)'}">${driftTotal}</div><div class="l" style="margin-top:6px">${blessedTotal} blessed</div></div>
  <div class="card"><div class="l">No CI</div><div class="n" style="color:${noCI.length?'var(--bad)':'var(--ok)'}">${noCI.length}</div>${noCI.length?`<div class="l" style="margin-top:6px">${esc(noCI.join(', '))}</div>`:''}</div>
</div>
<div class="wrap"><table>
<thead><tr><th class="repo">Repo</th>${GROUPS.map(g => `<th>${g.label}</th>`).join('')}${EXTRA.map(x => `<th>${x.label}</th>`).join('')}<th>Score</th><th>Drift</th><th>Last commit</th></tr></thead>
<tbody>
${rows.map(r => `<tr><td class="repo">${esc(r.name)}${r.isNew?'<span class="new">NEW</span>':''}<div class="type">${esc(r.typeLabel)}</div></td>${GROUPS.map(g => groupCell(r.groups[g.key])).join('')}${r.extras.map(yn).join('')}<td>${r.score===null?'<span class="sc na">–</span>':`<span class="sc ${scoreClass(r.score)}">${r.score}%</span>`}</td>${driftCell(r)}<td class="git">${r.git||'—'}</td></tr>`).join('\n')}
</tbody></table></div>
<div class="legend">Group cells show managed files present / applicable for the repo's type (hover a partial cell to see what's missing). Groups and drift come from <code>tools/lib/manifest.mjs</code>, the same list <code>make sync</code> and <code>make drift</code> use. Drift = a file meant to converge exists but differs from the template; declare intentional variants in the repo's <code>.consistency-ignore</code> to bless them. NEW = not in the last <code>make changes</code> snapshot. AGENTS/CLAUDE/eslint/tsconfig/prettier content is hand-owned and not compared.</div>
</body></html>`;

const out = join(ROOT, 'dashboard.html');
writeFileSync(out, html);
console.log(`dashboard written → ${out}`);
if (process.argv.includes('--open')) console.log(`open: file://${out}`);
console.log(`overall ${overall}% · ${fullyConsistent}/${rows.length} fully consistent · ${missingTotal} missing · ${driftTotal} drift${noCI.length ? ` · no CI: ${noCI.join(', ')}` : ''}`);
