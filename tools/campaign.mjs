#!/usr/bin/env node
// campaign.mjs — cross-repo major-upgrade campaigns: one human-reviewed PR per
// repo instead of a pile of failing bot PRs.
//
//   node tools/campaign.mjs --pkg=vitest --to=5                        # dry run: which repos need it, bot PRs already trying
//   node tools/campaign.mjs --pkg=vitest --to=5 --apply --repo=net-traffic [--keep]
//   node tools/campaign.mjs --pkg=vitest --to=5 --continue --repo=net-traffic   # after migrating a --keep worktree
//   node tools/campaign.mjs --reap [--repo=<name>]                      # bot PRs a campaign supersedes / failing 30+ days
//   node tools/campaign.mjs --reap --apply                              # … and close them, with a comment
//   node tools/campaign.mjs --reap --only=superseded                    # just one kind (superseded | failing)
//   add --json for machine-readable output
//
// Versions are read from origin/<default branch> (every package.json up to 3
// levels deep, skipping node_modules), not the local checkout, which may be on
// a PR branch. "from" is the highest declared major of the package or any of
// its companions (KNOWN_COMPANIONS below; vitest ↔ @vitest/*).
//
// --apply works in a temporary `git worktree` on branch chore/campaign-<pkg>-<to>
// cut from origin/<default>, so the repo's checked-out branch is never touched.
// It rewrites the declared ranges to the latest <to>.x (lockstep companions to
// their latest <to>.x too, loose companions to their latest), installs with the
// repo's package manager (pnpm if pnpm-lock.yaml, else npm), then runs the
// repo's own lint, type-check and test scripts (test:run if present, with CI=1).
// Only if all pass does it commit, push the branch and open the PR. On failure
// nothing is pushed; the failures are printed, and with --keep the worktree is
// left for migration work — fix the code there, then --continue re-runs the
// checks and ships everything (bump + migration) as one commit.
//
// Status goes to .dashboard-data/campaigns.json (gitignored):
//   needed · pr-open · done (declared major ≥ --to) · failed (last --apply failed)
//
// --reap closes nothing without --apply, and prints exactly what it would close
// first. A bot PR is reaped when it bumps a major of a campaign's package (or its
// lockstep companions) and that campaign's PR is open or merged in that repo, or when its checks fail and it is 30+ days old.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, detectTypes, listRepos } from './lib/manifest.mjs';
import { tierFor } from './lib/activity.mjs';
import { repoSettings } from './lib/workspace.mjs';
import { repoSlug } from './lib/github.mjs';

const args = process.argv.slice(2);
const flag = name => args.includes(`--${name}`);
const opt = name => (args.find(a => a.startsWith(`--${name}=`)) || '').split('=').slice(1).join('=') || null;
const APPLY = flag('apply'), KEEP = flag('keep'), CONTINUE = flag('continue'), REAP = flag('reap'), JSON_OUT = flag('json');
const ONLY = opt('only');
const PKG = opt('pkg'), TO = opt('to') === null ? null : Number(opt('to')), onlyRepo = opt('repo');
const TRAILER = 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>';
const STATUS_FILE = join(ROOT, '.dashboard-data', 'campaigns.json');
const STALE_DAYS = 30;
const C = { reset: '\x1b[0m', dim: '\x1b[2m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m', bold: '\x1b[1m' };

// lockstep: released in lockstep with the package, so bumped to the same <to>.x
// ("@scope/*" matches any declared package in that scope; members with no <to>.x
// release, e.g. @vitest/eslint-plugin, are left alone).
// loose: independently versioned, bumped to their own latest alongside.
const KNOWN_COMPANIONS = {
  vitest: { lockstep: ['@vitest/*'], loose: [] },
  vite: { lockstep: [], loose: ['@vitejs/plugin-react', '@vitejs/plugin-react-swc'] },
  react: { lockstep: ['react-dom'], loose: ['@types/react', '@types/react-dom'] },
  eslint: { lockstep: ['@eslint/js'], loose: [] },
  tailwindcss: { lockstep: ['@tailwindcss/vite', '@tailwindcss/postcss'], loose: [] },
  '@playwright/test': { lockstep: ['playwright'], loose: [] },
  storybook: { lockstep: ['@storybook/*'], loose: [] },
};
const BOT = /renovate|dependabot/i;
const DEP_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies'];
const OK_CHECK = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);

const run = (cmd, argv, opts = {}) => spawnSync(cmd, argv, { encoding: 'utf8', maxBuffer: 256 << 20, ...opts });
const git = (repoPath, argv, opts) => run('git', ['-C', repoPath, ...argv], opts);
const ok = r => (r.status === 0 ? r.stdout : null);
const must = (r, what) => { if (r.status !== 0) throw new Error(`${what} failed: ${(r.stderr || r.stdout || r.error?.message || '').trim()}`); return r.stdout; };
const ghJson = argv => JSON.parse(must(run('gh', argv), `gh ${argv.slice(0, 2).join(' ')}`));
const stripAnsi = s => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
const majorOf = spec => { const m = String(spec).match(/(?:^|[\s^~>=<v])(\d+)(?:\.|$|\s)/); return m ? Number(m[1]) : null; };
const slugOf = pkg => pkg.replace(/^@/, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
const branchFor = (pkg, to) => `chore/campaign-${slugOf(pkg)}-${to}`;

// ── reading a repo at origin/<default> ──────────────────────────────────────
function defaultRef(repoPath) {
  const ref = ok(git(repoPath, ['rev-parse', '--abbrev-ref', 'origin/HEAD']))?.trim() || 'origin/main';
  return { ref, branch: ref.replace(/^origin\//, '') };
}

function packageJsonsAt(repoPath, ref) {
  const files = (ok(git(repoPath, ['ls-tree', '-r', '-z', '--name-only', ref])) ?? '').split('\0');
  return files.filter(f => /(^|\/)package\.json$/.test(f) && f.split('/').length <= 4 && !/(^|\/)(node_modules|dist)\//.test(f))
    .flatMap(f => { try { return [{ file: f, json: JSON.parse(ok(git(repoPath, ['show', `${ref}:${f}`])) ?? '') }]; } catch { return []; } });
}

const matches = (pattern, name) => (pattern.endsWith('/*') ? name.startsWith(pattern.slice(0, -1)) : name === pattern);

// Every declared dependency in the campaign: [{ file, field, name, spec, role }].
function declared(pkgJsons, pkg) {
  const comp = KNOWN_COMPANIONS[pkg] ?? { lockstep: [], loose: [] };
  const out = [];
  for (const { file, json } of pkgJsons) {
    for (const field of DEP_FIELDS) {
      for (const [name, spec] of Object.entries(json[field] ?? {})) {
        const role = name === pkg ? 'main' : comp.lockstep.some(p => matches(p, name)) ? 'lockstep' : comp.loose.some(p => matches(p, name)) ? 'loose' : null;
        if (role) out.push({ file, field, name, spec, role, major: majorOf(spec) });
      }
    }
  }
  return out;
}

// ── GitHub ──────────────────────────────────────────────────────────────────
const PR_FIELDS = 'number,title,body,author,headRefName,createdAt,statusCheckRollup,url,state';
const openPrs = slug => ghJson(['pr', 'list', '-R', slug, '--state', 'open', '--limit', '100', '--json', PR_FIELDS]);
const campaignPrs = slug => ghJson(['pr', 'list', '-R', slug, '--state', 'all', '--limit', '50', '--search', 'head:chore/campaign-', '--json', 'number,headRefName,state,url,title'])
  .filter(p => p.headRefName.startsWith('chore/campaign-'));

function checkState(pr) {
  const rs = pr.statusCheckRollup ?? [];
  if (!rs.length) return { state: 'no checks', failing: [] };
  const st = rs.map(r => r.conclusion || r.state || r.status);
  if (st.some(s => !s || /PENDING|IN_PROGRESS|QUEUED|EXPECTED|WAITING|REQUESTED/.test(s))) return { state: 'pending', failing: [] };
  const failing = [...new Set(rs.filter(r => !OK_CHECK.has(r.conclusion || r.state)).map(r => r.name || r.context))];
  return { state: failing.length ? 'failing' : 'green', failing };
}

// Version changes a bot PR announces: Dependabot "Bumps [x](…) from 3.2.4 to 5.0.5" /
// "Updates `x` from …", Renovate table rows "| [x](…) | [`3.2.4` → `5.0.5`]" and
// titles "update dependency x to v4". Release notes quoted in bodies don't count.
function versionChanges(pr) {
  const text = `${pr.title}\n${pr.body ?? ''}`;
  const out = [];
  for (const [, name, from, to] of text.matchAll(/(?:Bumps \[|Updates `)(@?[\w.-]+(?:\/[\w.-]+)?)(?:\]\([^)]*\)|`) from v?(\d[\w.-]*) to v?(\d[\w.-]*)/g)) out.push({ name, from: majorOf(from), to: majorOf(to) });
  for (const [, name, from, to] of text.matchAll(/^\|\s*\[?(@?[\w.-]+(?:\/[\w.-]+)?)\]?(?:\([^)]*\))?[^|\n]*\|[^|\n]*?`[\^~>=<]*v?(\d[\w.-]*)`\s*(?:->|→)\s*`[\^~>=<]*v?(\d[\w.-]*)`/gm)) out.push({ name, from: majorOf(from), to: majorOf(to) });
  const t = pr.title.match(/update (?:dependency )?(@?[\w.-]+(?:\/[\w.-]+)?) to v(\d+)/i);
  if (t) out.push({ name: t[1], from: null, to: Number(t[2]) });
  return out;
}

// Campaign package patterns: the package itself plus its lockstep companions.
const campaignNames = pkg => [pkg, ...(KNOWN_COMPANIONS[pkg]?.lockstep ?? [])];

// Bot PRs attempting a major bump of any campaign package.
const botPrsFor = (prs, pkg) => prs.filter(p => BOT.test(p.author.login)
  && versionChanges(p).some(c => campaignNames(pkg).some(n => matches(n, c.name)) && (c.from === null || c.to > c.from)))
  .map(p => ({ number: p.number, title: p.title, url: p.url, bot: /renovate/i.test(p.author.login) ? 'renovate' : 'dependabot', createdAt: p.createdAt, ...checkState(p) }));

// ── status file ─────────────────────────────────────────────────────────────
function loadStatus() { try { return JSON.parse(readFileSync(STATUS_FILE, 'utf8')); } catch { return { campaigns: [] }; } }
function saveStatus(entries) {
  const status = loadStatus();
  const key = e => `${e.repo}\0${e.pkg}\0${e.to}`;
  const byKey = new Map(status.campaigns.map(e => [key(e), e]));
  for (const e of entries) byKey.set(key(e), { ...byKey.get(key(e)), ...e, updated: new Date().toISOString() });
  mkdirSync(dirname(STATUS_FILE), { recursive: true });
  writeFileSync(STATUS_FILE, JSON.stringify({ generated: new Date().toISOString(), campaigns: [...byKey.values()] }, null, 2) + '\n');
}

// ── survey (dry run) ────────────────────────────────────────────────────────
function survey(repo, prsCache) {
  const repoPath = join(ROOT, repo);
  if (!detectTypes(repoPath).has('node')) return null;
  git(repoPath, ['fetch', '--quiet', 'origin']);
  const { ref, branch } = defaultRef(repoPath);
  const deps = declared(packageJsonsAt(repoPath, ref), PKG);
  // "from" follows the package itself; lockstep companions only when it isn't declared directly.
  const own = deps.filter(d => d.role === 'main' && d.major !== null);
  const main = own.length ? own : deps.filter(d => d.role === 'lockstep' && d.major !== null);
  if (!main.length) return null;
  const from = Math.min(...main.map(d => d.major));
  const slug = repoSlug(repoPath, repo);
  const row = { repo, slug, tier: tierFor(repo), pkg: PKG, from, to: TO, defaultBranch: branch, deps, branch: branchFor(PKG, TO) };
  try {
    row.botPrs = botPrsFor(prsCache ?? openPrs(slug), PKG);
    const mine = campaignPrs(slug).find(p => p.headRefName === row.branch);
    row.pr = mine?.url ?? null;
    row.prState = mine?.state ?? null;
  } catch (e) { row.error = e.message.split('\n')[0]; row.botPrs = []; }
  const prev = loadStatus().campaigns.find(e => e.repo === repo && e.pkg === PKG && e.to === TO);
  row.state = from >= TO || row.prState === 'MERGED' ? 'done' : row.prState === 'OPEN' ? 'pr-open' : prev?.state === 'failed' ? 'failed' : 'needed';
  return row;
}

function printSurvey(rows) {
  const colour = s => ({ done: C.green, 'pr-open': C.cyan, failed: C.red }[s] ?? C.yellow);
  for (const r of rows) {
    const names = [...new Set(r.deps.filter(d => d.role !== 'loose').map(d => `${d.name}@${d.spec}`))].join(', ');
    console.log(`${colour(r.state)}${r.state.padEnd(8)}${C.reset} ${C.cyan}${r.repo.padEnd(18)}${C.reset} ${r.tier === 'active' ? 'active ' : `${C.dim}dormant${C.reset}`} ${r.from} → ${r.to}  ${C.dim}${names}${C.reset}`);
    if (r.pr) console.log(`         campaign PR ${r.pr} (${r.prState.toLowerCase()})`);
    for (const b of r.botPrs) console.log(`         ${C.dim}bot${C.reset} #${String(b.number).padEnd(4)} ${b.state.padEnd(8)} ${b.title.slice(0, 80)}`);
    if (r.error) console.log(`         ${C.red}${r.error}${C.reset}`);
  }
  const n = s => rows.filter(r => r.state === s).length;
  console.log(`\n${PKG} → ${TO}: ${n('needed')} needed · ${n('pr-open')} PR open · ${n('failed')} failed · ${n('done')} done · ${rows.reduce((a, r) => a + r.botPrs.length, 0)} bot PR(s) attempting it`);
  if (n('needed') || n('failed')) console.log(`${C.dim}apply one repo at a time: --apply --repo=<name> [--keep]${C.reset}`);
}

// ── apply ───────────────────────────────────────────────────────────────────
function npmLatest(name, range) {
  const r = run('npm', ['view', range ? `${name}@${range}` : name, 'version', '--json']);
  if (r.status !== 0 || !r.stdout.trim()) return null;
  const v = JSON.parse(r.stdout);
  return Array.isArray(v) ? v.at(-1) : v;
}

// Rewrites declared ranges in the worktree; returns [{ name, from, to }].
function bumpManifests(wt, deps) {
  const targets = new Map();
  for (const name of new Set(deps.map(d => d.name))) {
    const role = deps.find(d => d.name === name).role;
    const version = role === 'loose' ? npmLatest(name) : npmLatest(name, `^${TO}`);
    if (version) targets.set(name, version);
  }
  const changes = [];
  for (const file of new Set(deps.map(d => d.file))) {
    const path = join(wt, file);
    const json = JSON.parse(readFileSync(path, 'utf8'));
    for (const d of deps.filter(x => x.file === file && targets.has(x.name))) {
      const next = `^${targets.get(d.name)}`;
      if (json[d.field][d.name] === next) continue;
      changes.push({ file, name: d.name, from: json[d.field][d.name], to: next });
      json[d.field][d.name] = next;
    }
    const indent = readFileSync(path, 'utf8').match(/^[ \t]+"/m)?.[0].slice(0, -1) ?? '  ';
    writeFileSync(path, JSON.stringify(json, null, indent) + '\n');
  }
  const skipped = deps.filter(d => !targets.has(d.name)).map(d => d.name);
  return { changes, skipped: [...new Set(skipped)] };
}

const pmFor = wt => (existsSync(join(wt, 'pnpm-lock.yaml')) ? 'pnpm' : 'npm');

function install(wt, deps) {
  const pm = pmFor(wt);
  const dirs = new Set(['.', ...deps.map(d => dirname(d.file)).filter(d => existsSync(join(wt, d, pm === 'pnpm' ? 'pnpm-lock.yaml' : 'package-lock.json')))]);
  for (const dir of dirs) {
    const argv = pm === 'pnpm' ? ['install', '--no-frozen-lockfile'] : ['install', '--no-audit', '--no-fund'];
    console.log(`  ${C.dim}${pm} ${argv.join(' ')}${dir === '.' ? '' : ` (in ${dir})`}${C.reset}`);
    const r = run(pm, argv, { cwd: join(wt, dir), env: { ...process.env, HUSKY: '0' } });
    if (r.status !== 0) return { ok: false, output: stripAnsi(`${r.stdout}\n${r.stderr}`) };
  }
  return { ok: true };
}

// The repo's own checks: lint, type-check, then tests (run mode, not watch).
function runChecks(wt) {
  const pm = pmFor(wt);
  const scripts = JSON.parse(readFileSync(join(wt, 'package.json'), 'utf8')).scripts ?? {};
  const pick = (...names) => names.find(n => scripts[n]);
  const plan = [['lint', pick('lint')], ['type-check', pick('type-check', 'typecheck')], ['test', pick('test:run', 'test:unit', 'test')]];
  const results = [];
  for (const [label, script] of plan) {
    if (!script) { results.push({ label, script: null, ok: true, skipped: true }); continue; }
    process.stdout.write(`  ${C.dim}${pm} run ${script}${C.reset} … `);
    const started = Date.now();
    const extra = script === 'test' && /^vitest(\s|$)/.test(scripts.test) && !/\brun\b/.test(scripts.test) ? ['--', '--run'] : [];
    const r = run(pm, ['run', script, ...extra], { cwd: wt, env: { ...process.env, CI: '1', FORCE_COLOR: '0' }, timeout: 20 * 60_000 });
    const output = stripAnsi(`${r.stdout}\n${r.stderr}`);
    const summary = output.split('\n').filter(l => /^\s*(Test Files|Tests)\s+\d/.test(l)).map(l => l.trim()).join(' · ');
    const res = { label, script, ok: r.status === 0, seconds: Math.round((Date.now() - started) / 1000), summary, output };
    console.log(res.ok ? `${C.green}pass${C.reset} ${C.dim}${res.seconds}s ${summary}${C.reset}` : `${C.red}FAIL${C.reset}`);
    results.push(res);
  }
  return results;
}

function prBody(row, bump, results, migrated) {
  const lines = [`Upgrades **${PKG}** to ${TO}.x (campaign from \`tools/campaign.mjs\` in workspace-tools).`, '', '### What changed', ''];
  for (const c of bump.changes) lines.push(`- \`${c.name}\` ${c.from} → ${c.to}${c.file === 'package.json' ? '' : ` (${c.file})`}`);
  lines.push(`- lockfile regenerated with ${pmFor(row.wt)}`);
  if (bump.skipped.length) lines.push(`- left alone (no ${TO}.x release): ${bump.skipped.map(n => `\`${n}\``).join(', ')}`);
  if (migrated.length) lines.push('', 'Migration changes:', ...migrated.map(f => `- \`${f}\``));
  lines.push('', '### Local results', '');
  for (const r of results) lines.push(r.skipped ? `- ${r.label}: no script` : `- \`${r.script}\`: ${r.ok ? '✅ pass' : '❌ fail'}${r.summary ? ` — ${r.summary}` : ''}`);
  if (row.botPrs.length) {
    lines.push('', '### Supersedes', '', ...row.botPrs.map(b => `- #${b.number} ${b.title} (${b.bot}, ${b.state})`));
    lines.push('', 'Those can be closed once this merges (`tools/campaign.mjs --reap --apply`).');
  }
  lines.push('', '🤖 Generated with [Claude Code](https://claude.com/claude-code)');
  return lines.join('\n') + '\n';
}

function existingWorktree(repoPath, branch) {
  const list = ok(git(repoPath, ['worktree', 'list', '--porcelain'])) ?? '';
  return list.split('\n\n').map(b => ({ path: b.match(/^worktree (.+)$/m)?.[1], branch: b.match(/^branch refs\/heads\/(.+)$/m)?.[1] })).find(w => w.branch === branch)?.path ?? null;
}

function applyRepo(row) {
  const repoPath = join(ROOT, row.repo);
  const before = ok(git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']))?.trim();
  if (row.state === 'done') { console.log(`${C.green}${row.repo} already on ${PKG} ${row.from}${C.reset}`); return; }
  if (row.prState === 'OPEN') { console.log(`${C.cyan}${row.repo}${C.reset} campaign PR already open: ${row.pr}`); return; }
  let wt = existingWorktree(repoPath, row.branch);
  if (CONTINUE && !wt) throw new Error(`no kept worktree on ${row.branch} — run --apply --keep first`);
  if (!CONTINUE && wt) throw new Error(`a worktree for ${row.branch} already exists at ${wt} — use --continue, or remove it (git -C ${repoPath} worktree remove --force ${wt})`);
  if (ok(git(repoPath, ['ls-remote', '--heads', 'origin', row.branch]))?.trim()) throw new Error(`origin already has ${row.branch} — delete it or open the PR by hand`);
  let bump, keepIt = KEEP;
  if (!CONTINUE) {
    wt = mkdtempSync(join(tmpdir(), `campaign-${row.repo}-`));
    must(git(repoPath, ['worktree', 'add', '--quiet', '-B', row.branch, wt, `origin/${row.defaultBranch}`]), 'git worktree add');
    console.log(`  worktree ${wt} (${row.branch} from origin/${row.defaultBranch})`);
    bump = bumpManifests(wt, row.deps);
    bump.changes.forEach(c => console.log(`  ${C.green}bump${C.reset} ${c.name} ${c.from} → ${c.to}${c.file === 'package.json' ? '' : ` ${C.dim}(${c.file})${C.reset}`}`));
    if (bump.skipped.length) console.log(`  ${C.dim}left alone (no ${TO}.x): ${bump.skipped.join(', ')}${C.reset}`);
  } else {
    console.log(`  continuing in ${wt}`);
    const now = file => JSON.parse(readFileSync(join(wt, file), 'utf8'));
    const changes = row.deps.map(d => ({ file: d.file, name: d.name, from: d.spec, to: now(d.file)[d.field]?.[d.name] })).filter(c => c.to && c.to !== c.from);
    bump = { changes, skipped: [] };
    keepIt = true;
  }
  row.wt = wt;
  try {
    const inst = install(wt, row.deps);
    let results;
    if (!inst.ok) results = [{ label: 'install', script: `${pmFor(wt)} install`, ok: false, output: inst.output }];
    else results = runChecks(wt);
    const failed = results.filter(r => !r.ok);
    if (failed.length) {
      for (const f of failed) {
        const tail = f.output.split('\n').filter(l => /FAIL|Error|error|✗|×|failed|ERR!/.test(l)).slice(0, 40);
        console.log(`\n${C.red}── ${f.script} failed ──${C.reset}\n${(tail.length ? tail : f.output.split('\n').slice(-40)).join('\n')}`);
      }
      saveStatus([{ repo: row.repo, pkg: PKG, from: row.from, to: TO, state: 'failed', pr: null, failures: failed.map(f => f.script), worktree: keepIt ? wt : null }]);
      console.log(`\n${C.red}${row.repo}: not pushed${C.reset} — ${failed.map(f => f.script).join(', ')} failed.${keepIt ? ` Migrate in ${wt}, then --continue.` : ' Re-run with --keep to migrate in place.'}`);
      return;
    }
    must(git(wt, ['add', '-A']), 'git add');
    const touched = (ok(git(wt, ['diff', '--cached', '--name-only', `origin/${row.defaultBranch}`])) ?? '').split('\n').filter(Boolean);
    const migrated = touched.filter(f => !/(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml)$/.test(f));
    const body = `Bumps ${bump.changes.map(c => `${c.name} ${c.from} → ${c.to}`).join(', ') || PKG}.${migrated.length ? `\n\nMigration: ${migrated.join(', ')}` : ''}`;
    must(git(wt, ['commit', '--no-verify', '--quiet', '-F', '-'], { input: `chore(deps): upgrade ${PKG} to ${TO}\n\n${body}\n\n${TRAILER}\n` }), 'git commit');
    must(git(wt, ['push', '--no-verify', '--quiet', 'origin', `HEAD:refs/heads/${row.branch}`]), 'git push');
    const url = must(run('gh', ['pr', 'create', '--repo', row.slug, '--base', row.defaultBranch, '--head', row.branch, '--title', `chore(deps): upgrade ${PKG} to ${TO}`, '--body-file', '-'], { input: prBody(row, bump, results, migrated) }), 'gh pr create').trim();
    console.log(`  ${C.bold}PR${C.reset} ${url}`);
    saveStatus([{ repo: row.repo, pkg: PKG, from: row.from, to: TO, state: 'pr-open', pr: url, failures: [], worktree: null, supersedes: row.botPrs.map(b => b.number) }]);
    keepIt = false;
  } finally {
    if (!keepIt) {
      git(repoPath, ['worktree', 'remove', '--force', wt]);
      git(repoPath, ['worktree', 'prune']);
      git(repoPath, ['branch', '-D', row.branch]);
      rmSync(wt, { recursive: true, force: true });
    }
    const after = ok(git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']))?.trim();
    console.log(`  ${after === before ? C.dim : C.red}local checkout ${after === before ? 'unchanged' : 'CHANGED'}: ${after}${C.reset}`);
  }
}

// ── reap ────────────────────────────────────────────────────────────────────
function reap(repos) {
  const status = loadStatus().campaigns;
  const plan = [];
  for (const repo of repos) {
    const repoPath = join(ROOT, repo);
    const slug = repoSlug(repoPath, repo);
    let prs, camps;
    try { prs = openPrs(slug); camps = campaignPrs(slug).filter(p => p.state !== 'CLOSED'); } catch (e) { console.log(`${C.cyan}${repo}${C.reset} ${C.red}${e.message.split('\n')[0]}${C.reset}`); continue; }
    // The package each live campaign PR covers: from campaigns.json, else its branch name.
    const covered = camps.map(c => {
      const entry = status.find(e => e.repo === repo && branchFor(e.pkg, e.to) === c.headRefName);
      const pkg = entry?.pkg ?? Object.keys(KNOWN_COMPANIONS).find(k => c.headRefName.startsWith(`chore/campaign-${slugOf(k)}-`)) ?? c.headRefName.replace(/^chore\/campaign-|-\d+$/g, '');
      return { pr: c, pkg };
    });
    for (const p of prs.filter(x => BOT.test(x.author.login))) {
      const by = covered.find(c => botPrsFor([p], c.pkg).length);
      const age = Math.floor((Date.now() - Date.parse(p.createdAt)) / 86_400_000);
      const { state } = checkState(p);
      if (by) plan.push({ repo, slug, number: p.number, title: p.title, url: p.url, kind: 'superseded', reason: `superseded by ${by.pr.url} (${by.pr.state.toLowerCase()})` });
      else if (state === 'failing' && age >= STALE_DAYS) plan.push({ repo, slug, number: p.number, title: p.title, url: p.url, kind: 'failing', reason: `checks failing, open ${age} days` });
    }
  }
  if (ONLY) plan.splice(0, plan.length, ...plan.filter(p => p.kind === ONLY));
  if (JSON_OUT) { console.log(JSON.stringify(plan, null, 2)); if (!APPLY) return; }
  else {
    for (const p of plan) console.log(`${C.cyan}${p.repo.padEnd(16)}${C.reset} #${String(p.number).padEnd(4)} ${p.title.slice(0, 70)}\n${' '.repeat(23)}${C.dim}${p.reason}${C.reset}`);
    console.log(`\n${APPLY ? 'closing' : 'would close'} ${plan.length} bot PR(s)${!APPLY && plan.length ? ` ${C.dim}(--reap --apply to close them with a comment)${C.reset}` : ''}`);
  }
  if (!APPLY) return;
  for (const p of plan) {
    const comment = `Closing: ${p.reason}. Closed by \`tools/campaign.mjs --reap\` (workspace-tools); the bot will open a fresh PR for anything still pending.`;
    const r = run('gh', ['pr', 'close', String(p.number), '-R', p.slug, '--comment', comment]);
    console.log(`  ${r.status === 0 ? `${C.green}closed${C.reset}` : `${C.red}failed${C.reset}`} ${p.repo} #${p.number}${r.status === 0 ? '' : ` ${r.stderr.trim()}`}`);
  }
}

// ── main ────────────────────────────────────────────────────────────────────
const repos = listRepos(onlyRepo).filter(r => !repoSettings(r)?.archived);
if (onlyRepo && !repos.length) { console.error(`${C.red}no repo named ${onlyRepo}${C.reset}`); process.exit(1); }

if (REAP) { reap(repos); process.exit(0); }
if (!PKG || !Number.isInteger(TO)) { console.error(`${C.red}usage: --pkg=<name> --to=<major> [--apply --repo=<name> [--keep|--continue]] | --reap [--apply]${C.reset}`); process.exit(1); }
if ((APPLY || CONTINUE) && !onlyRepo) { console.error(`${C.red}--apply/--continue need --repo=<name> (one repo per run)${C.reset}`); process.exit(1); }

const rows = repos.map(r => survey(r)).filter(Boolean)
  .sort((a, b) => (a.tier === 'active' ? 0 : 1) - (b.tier === 'active' ? 0 : 1) || a.repo.localeCompare(b.repo));
const shown = rows.filter(r => r.state !== 'done' || onlyRepo);
saveStatus(rows.map(({ repo, pkg, from, to, state, pr }) => ({ repo, pkg, from, to, state, pr })));

if (APPLY || CONTINUE) {
  if (!rows.length) { console.error(`${C.red}${onlyRepo} doesn't declare ${PKG}${C.reset}`); process.exit(1); }
  printSurvey(rows);
  try { applyRepo(rows[0]); } catch (e) { console.error(`${C.red}${e.message}${C.reset}`); process.exit(1); }
} else if (JSON_OUT) console.log(JSON.stringify(rows.map(({ deps, ...r }) => r), null, 2));
else printSurvey(shown);
