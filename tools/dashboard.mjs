#!/usr/bin/env node
// dashboard.mjs — scan every repo and emit a self-contained dashboard.html
// showing type, tooling coverage, drift, and a consistency score per repo.
//
//   node tools/dashboard.mjs            # writes ./dashboard.html
//   node tools/dashboard.mjs --open     # also print the path to open
//
// No dependencies, no network. Regenerate any time (or via the weekly task).

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TPL = join(ROOT, 'ai-template-repo');
const SKIP = new Set(['ai-template-repo', '.github', '.git', 'tools', 'node_modules']);

function detectTypes(p) {
  const t = new Set();
  if (existsSync(join(p, 'package.json'))) t.add(existsSync(join(p, 'pnpm-lock.yaml')) ? 'pnpm' : 'npm');
  if (existsSync(join(p, 'pyproject.toml'))) t.add('python');
  const hasXcode = (dir, d) => {
    if (d < 0) return false;
    let es; try { es = readdirSync(dir, { withFileTypes: true }); } catch { return false; }
    return es.some(e => e.name.endsWith('.xcodeproj') || (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules' && hasXcode(join(dir, e.name), d - 1)));
  };
  if (hasXcode(p, 1)) t.add('xcode');
  return t;
}

const has = (p, f) => existsSync(join(p, f));
const hasCI = p => { const d = join(p, '.github', 'workflows'); try { return readdirSync(d).some(f => /\.ya?ml$/.test(f)); } catch { return false; } };
const drifts = (p, f) => { const s = join(TPL, f), d = join(p, f); return existsSync(s) && existsSync(d) && !readFileSync(d).equals(readFileSync(s)); };
const ignoredFor = (p) => { const f = join(p, '.consistency-ignore'); if (!existsSync(f)) return new Set(); return new Set(readFileSync(f, 'utf8').split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('#'))); };
function gitInfo(p) {
  const r = spawnSync('git', ['-C', p, 'log', '-1', '--format=%cd', '--date=short'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : '';
}

const repos = readdirSync(ROOT, { withFileTypes: true })
  .filter(e => e.isDirectory() && !SKIP.has(e.name) && !e.name.startsWith('.'))
  .map(e => e.name).sort();

// Column definition: which checks apply to which repo types.
const COLS = [
  { key: 'ci',         label: 'CI',         test: (p) => hasCI(p),                       types: ['pnpm','npm','python'] },
  { key: 'renovate',   label: 'Renovate',   test: (p) => has(p, 'renovate.json'),        types: ['pnpm','npm','python'] },
  { key: 'editorcfg',  label: 'EditorCfg',  test: (p) => has(p, '.editorconfig'),        types: 'all' },
  { key: 'security',   label: 'Security',   test: (p) => has(p, 'SECURITY.md'),          types: 'all' },
  { key: 'agents',     label: 'AGENTS',     test: (p) => has(p, 'AGENTS.md'),            types: ['pnpm','npm','python'] },
  { key: 'nvmrc',      label: '.nvmrc',     test: (p) => has(p, '.nvmrc'),               types: ['pnpm','npm'] },
  { key: 'husky',      label: 'Husky',      test: (p) => has(p, '.husky/commit-msg'),    types: ['pnpm','npm'] },
  { key: 'commitlint', label: 'Commitlint', test: (p) => has(p, 'commitlint.config.mjs'),types: ['pnpm','npm'] },
  { key: 'precommit',  label: 'pre-commit', test: (p) => has(p, '.pre-commit-config.yaml'), types: ['python'] },
];
const applies = (col, types) => col.types === 'all' || col.types.some(t => types.has(t));

const rows = repos.map(name => {
  const p = join(ROOT, name);
  const types = detectTypes(p);
  const typeLabel = [...types].map(t => t === 'pnpm' ? 'node·pnpm' : t === 'npm' ? 'node·npm' : t).join(' + ') || 'other';
  const cells = COLS.map(col => applies(col, types) ? (col.test(p) ? 'yes' : 'no') : 'na');
  const applicable = cells.filter(c => c !== 'na').length;
  const passed = cells.filter(c => c === 'yes').length;
  const score = applicable ? Math.round((passed / applicable) * 100) : null;
  const ignored = ignoredFor(p);
  const allDrift = ['.editorconfig', '.husky/commit-msg'].filter(f => drifts(p, f));
  const driftList = allDrift.filter(f => !ignored.has(f));       // unblessed — a real signal
  const blessed = allDrift.filter(f => ignored.has(f));          // declared intentional
  return { name, typeLabel, cells, score, drift: driftList, blessed, git: gitInfo(p) };
});

const totalPass = rows.reduce((a, r) => a + r.cells.filter(c => c === 'yes').length, 0);
const totalApplicable = rows.reduce((a, r) => a + r.cells.filter(c => c !== 'na').length, 0);
const overall = Math.round((totalPass / totalApplicable) * 100);
const driftTotal = rows.reduce((a, r) => a + r.drift.length, 0);
const blessedTotal = rows.reduce((a, r) => a + r.blessed.length, 0);
const fullyConsistent = rows.filter(r => r.score === 100 && r.drift.length === 0).length;

const badge = (c) => c === 'yes' ? '<td class="c yes">✓</td>' : c === 'no' ? '<td class="c no">✗</td>' : '<td class="c na">–</td>';
const scoreClass = (s) => s === null ? 'na' : s === 100 ? 'ok' : s >= 60 ? 'warn' : 'bad';

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
  table{border-collapse:collapse;width:100%;background:var(--panel);border:1px solid var(--border);border-radius:10px;overflow:hidden}
  th,td{padding:9px 10px;text-align:center;border-bottom:1px solid var(--border);white-space:nowrap}
  th{background:#1c2129;color:var(--dim);font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.03em;position:sticky;top:0}
  td.repo,th.repo{text-align:left}
  td.repo{font-weight:600}
  .type{color:var(--dim);font-weight:400;font-size:12px}
  .c{font-weight:700}
  .c.yes{color:var(--ok)} .c.no{color:var(--bad)} .c.na{color:#484f58}
  .sc{font-weight:700;border-radius:20px;padding:2px 9px;font-size:12px;display:inline-block}
  .sc.ok{background:rgba(46,160,67,.18);color:#3fb950}
  .sc.warn{background:rgba(210,153,34,.18);color:#e3b341}
  .sc.bad{background:rgba(248,81,73,.18);color:#ff7b72}
  .sc.na{color:#484f58}
  .drift{color:var(--warn);font-size:12px}
  .blessed{color:var(--dim);font-size:12px}
  .git{color:var(--dim);font-size:12px}
  .legend{color:var(--dim);font-size:12px;margin-top:16px}
  tr:hover td{background:#1b222c}
</style></head><body>
<h1>Repo consistency dashboard</h1>
<div class="sub">${repos.length} repos · generated ${new Date().toISOString().replace('T',' ').slice(0,16)} · regenerate with <code>make dashboard</code></div>
<div class="cards">
  <div class="card"><div class="l">Overall coverage</div><div class="n">${overall}%</div><div class="ring"><i style="width:${overall}%"></i></div></div>
  <div class="card"><div class="l">Fully consistent</div><div class="n">${fullyConsistent}/${repos.length}</div></div>
  <div class="card"><div class="l">Drift items</div><div class="n" style="color:${driftTotal?'var(--warn)':'var(--ok)'}">${driftTotal}</div><div class="l" style="margin-top:6px">${blessedTotal} blessed</div></div>
  <div class="card"><div class="l">Checks passing</div><div class="n">${totalPass}/${totalApplicable}</div></div>
</div>
<table>
<thead><tr><th class="repo">Repo</th>${COLS.map(c => `<th>${c.label}</th>`).join('')}<th>Score</th><th>Drift</th><th>Last commit</th></tr></thead>
<tbody>
${rows.map(r => `<tr><td class="repo">${r.name}<div class="type">${r.typeLabel}</div></td>${r.cells.map(badge).join('')}<td>${r.score===null?'<span class="sc na">–</span>':`<span class="sc ${scoreClass(r.score)}">${r.score}%</span>`}</td><td class="drift">${r.drift.length?r.drift.map(d=>d.replace('.husky/','')).join('<br>'):(r.blessed.length?`<span class="blessed">${r.blessed.map(d=>d.replace('.husky/','')).join('<br>')} ✓</span>`:'<span style="color:var(--ok)">—</span>')}</td><td class="git">${r.git||'—'}</td></tr>`).join('\n')}
</tbody></table>
<div class="legend">✓ present · ✗ missing · – not applicable for this repo type. Drift = file exists but differs from <code>ai-template-repo</code> (intentional richer variants are expected; review only if reconciling). AGENTS/CLAUDE/eslint/tsconfig/prettier are hand-owned and not scored.</div>
</body></html>`;

const out = join(ROOT, 'dashboard.html');
writeFileSync(out, html);
console.log(`dashboard written → ${out}`);
console.log(`overall ${overall}% · ${fullyConsistent}/${repos.length} fully consistent · ${driftTotal} drift`);
if (process.argv.includes('--open')) console.log(`open: file://${out}`);
