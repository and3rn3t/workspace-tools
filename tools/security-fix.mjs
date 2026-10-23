#!/usr/bin/env node
// security-fix.mjs — clear transitive npm/pnpm security alerts with one reviewed
// lockfile-refresh PR per repo.
//
//   node tools/security-fix.mjs                         # dry run: active repos' open alerts by what fixes them
//   node tools/security-fix.mjs --all                   # include dormant repos
//   node tools/security-fix.mjs --severity=medium       # lowest severity counted (default high)
//   node tools/security-fix.mjs --apply --repo=guess [--keep]
//   node tools/security-fix.mjs --apply --repo=guess --no-push   # refresh + checks locally, push nothing
//   add --json for machine-readable output
//
// Most open alerts are transitive dependencies whose patched version is already
// allowed by the parent's range — the lockfile just never moved. Each alert is
// classified from GitHub's Dependabot alerts and the lockfile on origin/<default>:
//   refresh      transitive, a patched version exists → a lockfile refresh may fix it
//   direct       declared in package.json → Renovate/Dependabot bump (or by hand)
//   no fix       no patched version published yet
//   fixed        origin/<default>'s lockfile no longer resolves a vulnerable version
//                (GitHub closes the alert on its next scan)
//
// --apply works in a temporary `git worktree` on branch fix/security-refresh cut
// from origin/<default> (the checked-out branch is never touched). It runs
// `npm update <pkgs>` / `pnpm update --depth Infinity <pkgs>` for the refresh
// alerts in each lockfile's folder, re-reads the lockfile to see which alerts are
// really fixed, then runs the repo's lint, type-check and test scripts. Only when
// at least one alert is fixed and every check passes does it commit, push and open
// the PR. Packages still vulnerable after the refresh are pinned below the fix by
// a parent: the output suggests an override for each, left to review.
// Alert details go to the repo's own PR and the terminal — never into tracked
// workspace-tools files.

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ROOT, detectTypes, listRepos } from './lib/manifest.mjs';
import { tierFor } from './lib/activity.mjs';
import { repoSettings } from './lib/workspace.mjs';
import { repoSlug } from './lib/github.mjs';
import { run, git, ok, must, worktreeDir, defaultRef, runChecks, printFailures } from './lib/repo-checks.mjs';
import { lockfileVersions, stillVulnerable } from './lib/vuln.mjs';

const args = process.argv.slice(2);
const flag = name => args.includes(`--${name}`);
const opt = name => (args.find(a => a.startsWith(`--${name}=`)) || '').split('=').slice(1).join('=') || null;
const APPLY = flag('apply'), KEEP = flag('keep'), NO_PUSH = flag('no-push'), ALL = flag('all'), JSON_OUT = flag('json');
const onlyRepo = opt('repo');
const SEVERITIES = ['low', 'medium', 'high', 'critical'];
const MIN = SEVERITIES.indexOf(opt('severity') ?? 'high');
const BRANCH = 'fix/security-refresh';
const TRAILER = 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>';
const C = { reset: '\x1b[0m', dim: '\x1b[2m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m', bold: '\x1b[1m' };
if (MIN < 0) { console.error(`${C.red}--severity must be one of ${SEVERITIES.join(', ')}${C.reset}`); process.exit(1); }

const LOCKFILES = { 'package-lock.json': 'npm', 'pnpm-lock.yaml': 'pnpm' };
const lockKind = path => LOCKFILES[path.split('/').pop()] ?? null;

// ── survey ──────────────────────────────────────────────────────────────────
function openAlerts(slug) {
  const r = run('gh', ['api', '--paginate', `repos/${slug}/dependabot/alerts?state=open&per_page=100`, '--jq', '.[]']);
  must(r, 'gh api dependabot/alerts');
  return r.stdout.split('\n').filter(Boolean).map(l => JSON.parse(l))
    .filter(a => a.dependency?.package?.ecosystem === 'npm' && lockKind(a.dependency.manifest_path ?? ''))
    .filter(a => SEVERITIES.indexOf(a.security_advisory?.severity) >= MIN)
    .map(a => ({
      number: a.number, ghsa: a.security_advisory.ghsa_id, severity: a.security_advisory.severity, summary: a.security_advisory.summary,
      pkg: a.dependency.package.name, lockfile: a.dependency.manifest_path, relationship: a.dependency.relationship,
      range: a.security_vulnerability.vulnerable_version_range, patched: a.security_vulnerability.first_patched_version?.identifier ?? null,
    }));
}

function classify(alerts, readLock) {
  const versions = new Map();
  const at = lockfile => { if (!versions.has(lockfile)) { const text = readLock(lockfile); versions.set(lockfile, text === null ? null : lockfileVersions(text, lockKind(lockfile))); } return versions.get(lockfile); };
  return alerts.map(a => {
    const v = at(a.lockfile);
    const vulnerable = v ? stillVulnerable(v, a.pkg, a.range) : [];
    const kind = v && !vulnerable.length ? 'fixed' : !a.patched ? 'no fix' : a.relationship === 'direct' ? 'direct' : 'refresh';
    return { ...a, kind, vulnerable };
  });
}

function survey(repo) {
  const repoPath = join(ROOT, repo);
  if (!detectTypes(repoPath).has('node')) return null;
  const slug = repoSlug(repoPath, repo);
  let alerts;
  try { alerts = openAlerts(slug); } catch (e) { return { repo, slug, tier: tierFor(repo), error: e.message.split('\n')[0], alerts: [] }; }
  if (!alerts.length) return null;
  git(repoPath, ['fetch', '--quiet', 'origin']);
  const { ref, branch } = defaultRef(repoPath);
  const classified = classify(alerts, file => ok(git(repoPath, ['show', `${ref}:${file}`])));
  return { repo, slug, tier: tierFor(repo), defaultBranch: branch, alerts: classified };
}

const count = (alerts, kind) => alerts.filter(a => a.kind === kind).length;

function printSurvey(rows) {
  for (const r of rows) {
    if (r.error) { console.log(`${C.cyan}${r.repo}${C.reset} ${C.red}${r.error}${C.reset}`); continue; }
    const sev = s => r.alerts.filter(a => a.severity === s).length;
    console.log(`${C.cyan}${r.repo.padEnd(18)}${C.reset} ${r.tier === 'active' ? 'active ' : `${C.dim}dormant${C.reset}`} ${String(r.alerts.length).padStart(3)} alert(s) ${C.dim}(${sev('critical')} critical, ${sev('high')} high${MIN < 2 ? ', …' : ''})${C.reset}  `
      + `${C.green}${count(r.alerts, 'refresh')} refresh${C.reset} · ${count(r.alerts, 'direct')} direct · ${count(r.alerts, 'no fix')} no fix${count(r.alerts, 'fixed') ? ` · ${count(r.alerts, 'fixed')} fixed on ${r.defaultBranch}` : ''}`);
    const pkgs = [...new Set(r.alerts.filter(a => a.kind === 'refresh').map(a => a.pkg))];
    if (pkgs.length) console.log(`${' '.repeat(27)}${C.dim}refresh: ${pkgs.slice(0, 8).join(', ')}${pkgs.length > 8 ? ` +${pkgs.length - 8}` : ''}${C.reset}`);
  }
  const all = rows.flatMap(r => r.alerts);
  console.log(`\n${all.length} ${SEVERITIES[MIN]}+ npm alert(s) in ${rows.length} repo(s): ${count(all, 'refresh')} may clear with a lockfile refresh · ${count(all, 'direct')} need a declared-range bump · ${count(all, 'no fix')} have no fix yet · ${count(all, 'fixed')} already fixed on the default branch`);
  if (count(all, 'refresh')) console.log(`${C.dim}one repo at a time: --apply --repo=<name> [--keep]${C.reset}`);
}

// ── apply ───────────────────────────────────────────────────────────────────
// Config mistakes that make the refresh itself crash, corrected in the worktree
// and listed in the PR. pnpm reads minimumReleaseAge as minutes: "4h" becomes an
// invalid cutoff date and pnpm dies with "Invalid time value" on any recently
// published version (frozen-lockfile CI installs never resolve, so never notice).
function fixups(wt) {
  const done = [];
  const file = join(wt, 'pnpm-workspace.yaml');
  if (existsSync(file)) {
    const text = readFileSync(file, 'utf8');
    const m = text.match(/^minimumReleaseAge:\s*['"]?(\d+)\s*([mhd])['"]?\s*$/m);
    if (m) {
      const minutes = Number(m[1]) * { m: 1, h: 60, d: 1440 }[m[2]];
      writeFileSync(file, text.replace(m[0], `minimumReleaseAge: ${minutes}`));
      done.push(`\`pnpm-workspace.yaml\`: \`minimumReleaseAge: ${m[1]}${m[2]}\` → \`${minutes}\` — pnpm reads it as minutes; the string made every resolve crash with "Invalid time value"`);
    }
  }
  return done;
}

// Names declared in any package.json of the worktree (3 levels, like campaign.mjs).
// Updating one of those would rewrite its declared range (and pnpm reformats the
// file), so they're left to Renovate/Dependabot and the PR stays lockfile-only.
function declaredNames(wt) {
  const files = (ok(git(wt, ['ls-files', '-z'])) ?? '').split('\0').filter(f => /(^|\/)package\.json$/.test(f) && f.split('/').length <= 4);
  const names = new Set();
  for (const f of files) {
    try { const j = JSON.parse(readFileSync(join(wt, f), 'utf8')); for (const k of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) Object.keys(j[k] ?? {}).forEach(n => names.add(n)); } catch { /* not JSON */ }
  }
  return names;
}

function refresh(wt, alerts) {
  const declared = declaredNames(wt);
  const skipped = [...new Set(alerts.filter(a => a.kind === 'refresh' && declared.has(a.pkg)).map(a => a.pkg))];
  if (skipped.length) console.log(`  ${C.dim}left to Renovate (declared directly somewhere): ${skipped.join(', ')}${C.reset}`);
  const byLock = new Map();
  for (const a of alerts.filter(x => x.kind === 'refresh' && !declared.has(x.pkg))) byLock.set(a.lockfile, new Set([...(byLock.get(a.lockfile) ?? []), a.pkg]));
  for (const [lockfile, pkgs] of byLock) {
    const dir = dirname(lockfile), cwd = join(wt, dir);
    const pm = lockKind(lockfile);
    const argv = pm === 'pnpm'
      ? ['update', ...(existsSync(join(cwd, 'pnpm-workspace.yaml')) ? ['-r'] : []), '--depth', 'Infinity', ...pkgs]
      : ['update', '--no-audit', '--no-fund', ...pkgs];
    console.log(`  ${C.dim}${pm} ${argv.join(' ')}${dir === '.' ? '' : ` (in ${dir})`}${C.reset}`);
    const r = run(pm, argv, { cwd, env: { ...process.env, HUSKY: '0' } });
    if (r.status !== 0) return { ok: false, output: `${r.stdout}\n${r.stderr}` };
  }
  return { ok: true };
}

const overrideHint = (a, pm) => (pm === 'pnpm' ? `pnpm.overrides "${a.pkg}@${a.range.replace(/\s+/g, '')}": "${a.patched}"` : `overrides "${a.pkg}": "^${a.patched}" (check other majors of ${a.pkg} first)`);

function prBody(row, fixed, left, results, touched, configFixes) {
  const link = a => `[${a.ghsa}](https://github.com/advisories/${a.ghsa})`;
  const manifests = touched.filter(f => /(^|\/)package\.json$/.test(f));
  const lines = [`Refreshes the lockfile so ${fixed.length} Dependabot security alert(s) resolve to patched versions. ${manifests.length ? `The package manager also rewrote ${manifests.map(f => `\`${f}\``).join(', ')} — review those hunks.` : 'No declared ranges change — every new version was already allowed by its parent.'}`, '', '### Fixed', '', '| Severity | Package | Now | Advisory |', '| --- | --- | --- | --- |'];
  for (const a of fixed) lines.push(`| ${a.severity} | \`${a.pkg}\` | ≥ ${a.patched} | ${link(a)} |`);
  if (left.length) {
    lines.push('', '### Still open after the refresh', '', 'A parent pins these below the fix; they need an override or a parent upgrade:', '');
    for (const a of left) lines.push(`- ${a.severity} \`${a.pkg}\` ${a.vulnerable.join(', ')} (fixed in ${a.patched}) — ${link(a)}`);
  }
  if (configFixes.length) lines.push('', '### Config fix needed for the refresh', '', ...configFixes.map(f => `- ${f}`));
  lines.push('', '### Files', '', ...touched.map(f => `- \`${f}\``));
  lines.push('', '### Local results', '');
  for (const r of results) lines.push(r.skipped ? `- ${r.label}: no script` : `- \`${r.script}\`: ${r.ok ? '✅ pass' : '❌ fail'}${r.summary ? ` — ${r.summary}` : ''}`);
  lines.push('', 'Opened by `tools/security-fix.mjs` (workspace-tools).', '', '🤖 Generated with [Claude Code](https://claude.com/claude-code)');
  return lines.join('\n') + '\n';
}

function applyRepo(row) {
  const repoPath = join(ROOT, row.repo);
  const before = ok(git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']))?.trim();
  if (!count(row.alerts, 'refresh')) { console.log(`${row.repo}: no alerts a lockfile refresh could fix`); return; }
  if (ok(git(repoPath, ['ls-remote', '--heads', 'origin', BRANCH]))?.trim()) throw new Error(`origin already has ${BRANCH} — merge or close that PR first`);
  const wt = worktreeDir(`security-fix-${row.repo}`);
  must(git(repoPath, ['worktree', 'add', '--quiet', '-B', BRANCH, wt, `origin/${row.defaultBranch}`]), 'git worktree add');
  console.log(`  worktree ${wt} (${BRANCH} from origin/${row.defaultBranch})`);
  let keepIt = KEEP;
  try {
    const configFixes = fixups(wt);
    configFixes.forEach(f => console.log(`  ${C.yellow}config fix${C.reset} ${f.replace(/`/g, '')}`));
    const up = refresh(wt, row.alerts);
    if (!up.ok) {
      const conflict = up.output.match(/Could not resolve dependency:\s*\n.*?(peer\w* \S+@"[^"]+") from (\S+)/s);
      const why = conflict ? `peer conflict already in the tree: ${conflict[2]} wants ${conflict[1].replace(/^peer\w* /, '')} — bump the declared range, then re-run` : up.output.trim().split('\n').filter(l => !/Progress:|Request took/.test(l)).slice(-30).join('\n');
      console.log(`${C.red}${row.repo}: update failed, not pushed${C.reset}\n${why}`);
      return;
    }
    const after = classify(row.alerts.filter(a => a.kind === 'refresh'), file => (existsSync(join(wt, file)) ? readFileSync(join(wt, file), 'utf8') : null));
    const fixed = after.filter(a => a.kind === 'fixed'), left = after.filter(a => a.kind !== 'fixed');
    console.log(`  ${C.green}${fixed.length} fixed${C.reset} by the refresh · ${left.length} still vulnerable`);
    for (const a of left) console.log(`    ${C.yellow}${a.severity.padEnd(8)}${C.reset} ${a.pkg} ${a.vulnerable.join(', ')} → needs ${a.patched}  ${C.dim}${overrideHint(a, lockKind(a.lockfile))}${C.reset}`);
    if (!fixed.length) { console.log(`${C.yellow}${row.repo}: nothing fixed, not pushed${C.reset}`); return; }
    const results = runChecks(wt);
    const failed = results.filter(r => !r.ok);
    if (failed.length) {
      printFailures(failed);
      console.log(`\n${C.red}${row.repo}: not pushed${C.reset} — ${failed.map(f => f.script).join(', ')} failed.${keepIt ? ` Worktree kept at ${wt}.` : ' Re-run with --keep to look in the worktree.'}`);
      return;
    }
    must(git(wt, ['add', '-A']), 'git add');
    if (NO_PUSH) {
      const files = ok(git(wt, ['diff', '--cached', '--stat', `origin/${row.defaultBranch}`]))?.trim();
      console.log(`  ${C.dim}${files}${C.reset}\n${C.green}${row.repo}: ready — ${fixed.length} alert(s) fixed, checks pass${C.reset} (--no-push: nothing committed or pushed)`);
      return;
    }
    const touched = (ok(git(wt, ['diff', '--cached', '--name-only', `origin/${row.defaultBranch}`])) ?? '').split('\n').filter(Boolean);
    const title = `fix(deps): refresh lockfile for ${fixed.length} security alert(s)`;
    const pkgs = [...new Set(fixed.map(a => a.pkg))].join(', ');
    must(git(wt, ['commit', '--no-verify', '--quiet', '-F', '-'], { input: `${title}\n\nUpdates ${pkgs} within their existing ranges.\n\n${TRAILER}\n` }), 'git commit');
    must(git(wt, ['push', '--no-verify', '--quiet', 'origin', `HEAD:refs/heads/${BRANCH}`]), 'git push');
    const url = must(run('gh', ['pr', 'create', '--repo', row.slug, '--base', row.defaultBranch, '--head', BRANCH, '--title', title, '--label', 'security', '--body-file', '-'], { input: prBody(row, fixed, left, results, touched, configFixes) }), 'gh pr create').trim();
    console.log(`  ${C.bold}PR${C.reset} ${url}`);
    keepIt = false;
  } finally {
    if (!keepIt) {
      git(repoPath, ['worktree', 'remove', '--force', wt]);
      git(repoPath, ['worktree', 'prune']);
      git(repoPath, ['branch', '-D', BRANCH]);
      rmSync(wt, { recursive: true, force: true });
    }
    const now = ok(git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']))?.trim();
    console.log(`  ${now === before ? C.dim : C.red}local checkout ${now === before ? 'unchanged' : 'CHANGED'}: ${now}${C.reset}`);
  }
}

// ── main ────────────────────────────────────────────────────────────────────
const repos = listRepos(onlyRepo).filter(r => !repoSettings(r)?.archived && (ALL || onlyRepo || tierFor(r) === 'active'));
if (onlyRepo && !repos.length) { console.error(`${C.red}no repo named ${onlyRepo}${C.reset}`); process.exit(1); }
if (APPLY && !onlyRepo) { console.error(`${C.red}--apply needs --repo=<name> (one repo per run)${C.reset}`); process.exit(1); }

const rows = repos.map(survey).filter(Boolean).sort((a, b) => count(b.alerts, 'refresh') - count(a.alerts, 'refresh') || a.repo.localeCompare(b.repo));
if (JSON_OUT) { console.log(JSON.stringify(rows, null, 2)); process.exit(0); }
printSurvey(rows);
if (APPLY) {
  if (!rows.length) { console.log(`${onlyRepo}: no open ${SEVERITIES[MIN]}+ npm alerts`); process.exit(0); }
  try { applyRepo(rows[0]); } catch (e) { console.error(`${C.red}${e.message}${C.reset}`); process.exit(1); }
}
