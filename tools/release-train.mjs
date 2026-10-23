#!/usr/bin/env node
// release-train.mjs — keep active repos released: what's waiting, the next
// version, and publishing through each repo's own release mechanism.
//
//   node tools/release-train.mjs                        # dry run: every active repo
//   node tools/release-train.mjs --repo=guess           # one repo, with the notes that would publish
//   node tools/release-train.mjs --prepare --repo=guess # PR: CHANGELOG section + version fields
//   node tools/release-train.mjs --apply --repo=guess   # publish (public — one repo per run)
//   --version=1.2.3 overrides the proposal · --all includes dormant repos · --json
//
// Next version comes from conventional commits on origin/<default> since the
// highest published x.y.z release: breaking → major (minor while 0.x), feat →
// minor, otherwise patch. A repo is *due* when it has release-worthy commits
// (feat/fix/perf/revert/breaking; fix(deps) from bots counts — security) and its
// last release is 14+ days old, or it has none.
//
// --prepare is needed first when the repo has a CHANGELOG.md without that version,
// or a package.json / package-lock.json / pyproject.toml version that differs: it
// opens chore/release-v<x> (Keep a Changelog "Unreleased" moves under the new
// heading; other changelogs get generated notes). Merge it, then --apply.
//
// --apply publishes the way the repo already releases (workflows read from
// origin/<default>; `"release"` in workspace.json overrides):
//   tag       a workflow runs on `push: tags: v*` → push an annotated tag; the workflow publishes
//   dispatch  a release workflow takes a `version` input → `gh workflow run … -f version=`
//   self      a workflow bumps and releases on green CI (birds) → reported, never touched
//   api       release-drafter / nothing → publish the draft (or a new release) via the API,
//             notes from the CHANGELOG section, else the draft body, else generated
//   off       never released by the train
// It refuses when default-branch workflows are failing (from .github-meta.json).

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, listRepos } from './lib/manifest.mjs';
import { tierFor } from './lib/activity.mjs';
import { repoSettings } from './lib/workspace.mjs';
import { repoSlug } from './lib/github.mjs';
import { loadMeta } from './lib/presentation.mjs';
import { run, git, ok, must, worktreeDir, defaultRef } from './lib/repo-checks.mjs';
import { baseRelease, classifyCommit, nextVersion, renderNotes, changelogWithRelease, changelogHas, parseSemver } from './lib/release.mjs';

const args = process.argv.slice(2);
const flag = name => args.includes(`--${name}`);
const opt = name => (args.find(a => a.startsWith(`--${name}=`)) || '').split('=').slice(1).join('=') || null;
const APPLY = flag('apply'), PREPARE = flag('prepare'), ALL = flag('all'), JSON_OUT = flag('json');
const onlyRepo = opt('repo'), VERSION = opt('version');
const DUE_DAYS = 14, DAY = 86_400_000;
const TRAILER = 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>';
const C = { reset: '\x1b[0m', dim: '\x1b[2m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m', bold: '\x1b[1m' };
const fail = msg => { console.error(`${C.red}${msg}${C.reset}`); process.exit(1); };
if (VERSION && !parseSemver(VERSION)) fail('--version must be x.y.z');
if ((APPLY || PREPARE) && !onlyRepo) fail('--apply/--prepare need --repo=<name> (one repo per run)');

const meta = loadMeta();
const show = (repoPath, ref, file) => ok(git(repoPath, ['show', `${ref}:${file}`]));

// ── how a repo releases ─────────────────────────────────────────────────────
function releaseMode(repoPath, ref, override) {
  if (override && override !== 'auto') return { mode: override, workflow: null };
  const files = (ok(git(repoPath, ['ls-tree', '--name-only', `${ref}:.github/workflows`])) ?? '').split('\n').filter(f => /\.ya?ml$/.test(f));
  const wf = files.map(f => ({ file: f, text: show(repoPath, ref, `.github/workflows/${f}`) ?? '' }));
  // Bounded patterns: workflow files are small, but nested \s quantifiers backtrack badly.
  const self = wf.find(w => /^release\.ya?ml$/.test(w.file) && /workflow_run:/.test(w.text));
  if (self) return { mode: 'self', workflow: self.file };
  const tag = wf.find(w => /\bpush:[^]{0,160}?\btags:[ \t]*(?:\n[ \t]*-[ \t]*|\[[ \t]*)?['"]?v/.test(w.text));
  if (tag) return { mode: 'tag', workflow: tag.file };
  const dispatch = wf.find(w => /^release\.ya?ml$/.test(w.file) && /workflow_dispatch:[ \t]*\n[ \t]+inputs:[ \t]*\n[ \t]+version:/.test(w.text));
  if (dispatch) return { mode: 'dispatch', workflow: dispatch.file };
  const onPublished = wf.find(w => /\brelease:[ \t]*\n[ \t]+types:[ \t]*\[?[ \t]*published/.test(w.text));
  return { mode: 'api', workflow: onPublished?.file ?? null };
}

// Version fields that should match the release: [{ file, version }].
function versionFields(repoPath, ref) {
  const out = [];
  const pkg = show(repoPath, ref, 'package.json');
  if (pkg) { try { const v = JSON.parse(pkg).version; if (v) out.push({ file: 'package.json', version: v }); } catch { /* not JSON */ } }
  const lock = show(repoPath, ref, 'package-lock.json');
  if (lock && out.length) { try { const v = JSON.parse(lock).version; if (v) out.push({ file: 'package-lock.json', version: v }); } catch { /* not JSON */ } }
  const py = show(repoPath, ref, 'pyproject.toml')?.match(/^\[project\][^[]*?^version\s*=\s*"([^"]+)"/ms)?.[1];
  if (py) out.push({ file: 'pyproject.toml', version: py });
  return out;
}

// ── survey ──────────────────────────────────────────────────────────────────
function survey(repo) {
  const repoPath = join(ROOT, repo);
  if (!existsSync(join(repoPath, '.git'))) return null;
  const s = repoSettings(repo);
  const slug = repoSlug(repoPath, repo);
  git(repoPath, ['fetch', '--quiet', '--tags', 'origin']);
  const { ref, branch } = defaultRef(repoPath);
  const res = run('gh', ['api', '--paginate', `repos/${slug}/releases?per_page=100`, '--jq', '.[]']);
  if (res.status !== 0) return { repo, slug, error: res.stderr.trim().split('\n').pop() };
  const releases = res.stdout.split('\n').filter(Boolean).map(l => JSON.parse(l));
  const base = baseRelease(releases);
  const lastAt = releases.filter(r => !r.draft).map(r => Date.parse(r.published_at)).sort((a, b) => b - a)[0] ?? null;
  const draft = releases.find(r => r.draft) ?? null;
  const hasTag = base && ok(git(repoPath, ['rev-parse', '-q', '--verify', `refs/tags/${base.tag_name}`]));
  const range = base ? (hasTag ? [`${base.tag_name}..${ref}`] : [ref, `--since=${base.published_at}`]) : [ref, '-n', '300'];
  const log = ok(git(repoPath, ['log', '--no-merges', '--format=%s%x1f%an%x1f%b%x1e', ...range])) ?? '';
  const commits = log.split('\x1e').map(e => e.trim()).filter(Boolean).map(e => { const [subject, author, body] = e.split('\x1f'); return { subject, author, body }; });
  const worthy = commits.filter(c => classifyCommit(c).worthy);
  const fields = versionFields(repoPath, ref);
  const declared = fields.find(f => f.file !== 'package-lock.json')?.version ?? null;
  const version = VERSION ?? nextVersion(base?.tag_name, commits, declared);
  const changelog = show(repoPath, ref, 'CHANGELOG.md');
  const { mode, workflow } = releaseMode(repoPath, ref, s?.release);
  const failing = meta?.repos?.[repo]?.failing ?? [];
  const ageDays = lastAt ? Math.floor((Date.now() - lastAt) / DAY) : null;
  const toPrepare = [
    ...(changelog !== null && !changelogHas(changelog, version) ? ['CHANGELOG.md'] : []),
    ...fields.filter(f => f.version !== version).map(f => f.file),
  ];
  const state = mode === 'off' ? 'off' : mode === 'self' ? 'self' : !worthy.length ? 'nothing'
    : ageDays !== null && ageDays < DUE_DAYS ? 'recent' : failing.length ? 'blocked' : toPrepare.length ? 'prepare' : 'ready';
  return { repo, slug, tier: tierFor(repo), defaultBranch: branch, ref, base: base?.tag_name ?? null, ageDays, commits, worthy: worthy.length, version, declared, fields, changelog, toPrepare, mode, workflow, draft: draft && { id: draft.id, tag: draft.tag_name, body: draft.body ?? '' }, failing: failing.map(f => f.workflow), state };
}

const STATE_COLOUR = { ready: C.green, prepare: C.yellow, blocked: C.red, recent: C.dim, nothing: C.dim, self: C.dim, off: C.dim };
const STATE_TEXT = { ready: 'ready', prepare: 'prepare', blocked: 'CI red', recent: 'recent', nothing: 'nothing', self: 'self', off: 'off' };

function printSurvey(rows) {
  for (const r of rows) {
    if (r.error) { console.log(`${C.cyan}${r.repo}${C.reset} ${C.red}${r.error}${C.reset}`); continue; }
    const last = r.base ? `${r.base} ${r.ageDays}d ago` : 'never released';
    const next = ['nothing', 'self', 'off'].includes(r.state) ? '' : `→ v${r.version}`;
    console.log(`${STATE_COLOUR[r.state]}${STATE_TEXT[r.state].padEnd(8)}${C.reset} ${C.cyan}${r.repo.padEnd(22)}${C.reset} ${last.padEnd(22)} ${next.padEnd(10)} ${C.dim}${r.worthy}/${r.commits.length} release-worthy · ${r.mode}${r.workflow ? ` (${r.workflow})` : ''}${C.reset}`);
    if (r.state === 'prepare') console.log(`${' '.repeat(32)}${C.dim}--prepare: ${r.toPrepare.join(', ')}${C.reset}`);
    if (r.state === 'blocked') console.log(`${' '.repeat(32)}${C.dim}failing on ${r.defaultBranch}: ${r.failing.join(', ')}${C.reset}`);
    if (r.state === 'self') console.log(`${' '.repeat(32)}${C.dim}releases itself on green CI — the train leaves it alone${C.reset}`);
  }
  const n = s => rows.filter(r => r.state === s).length;
  console.log(`\n${rows.length} repo(s): ${n('ready')} ready · ${n('prepare')} need --prepare · ${n('blocked')} blocked by red CI · ${n('recent')} released < ${DUE_DAYS}d ago · ${n('nothing')} nothing release-worthy`);
  if (n('ready') || n('prepare')) console.log(`${C.dim}one repo at a time: --repo=<name> to see the notes, then --prepare / --apply${C.reset}`);
}

// Notes that would publish: CHANGELOG section > release-drafter draft (warning footer cut) > generated.
function notesFor(r, changelogText = r.changelog) {
  const section = changelogText?.match(new RegExp(`^## \\[?v?${r.version.replace(/\./g, '\\.')}\\]?[^\\n]*\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm'))?.[1].trim();
  if (section) return { from: 'CHANGELOG.md', body: section + '\n' };
  const draft = r.draft?.body.split(/\r?\n/);
  const cut = draft ? draft.findIndex(l => /^---\s*$/.test(l)) : -1;
  const drafted = draft?.slice(0, cut < 0 ? undefined : cut).join('\n').trim();
  if (drafted && /^\s*[*-] (?!No changes)\S/m.test(drafted)) return { from: `draft ${r.draft.tag}`, body: drafted + '\n' };
  return { from: 'commits', body: renderNotes(r.commits) };
}

// ── prepare ─────────────────────────────────────────────────────────────────
function prepare(r) {
  if (!r.toPrepare.length) { console.log(`${r.repo}: nothing to prepare — run --apply`); return; }
  const repoPath = join(ROOT, r.repo);
  const branch = `chore/release-v${r.version}`;
  if (ok(git(repoPath, ['ls-remote', '--heads', 'origin', branch]))?.trim()) fail(`origin already has ${branch} — merge or close that PR first`);
  const wt = worktreeDir(`release-${r.repo}`);
  must(git(repoPath, ['worktree', 'add', '--quiet', '-B', branch, wt, r.ref]), 'git worktree add');
  try {
    const today = new Date().toISOString().slice(0, 10);
    for (const file of r.toPrepare) {
      const path = join(wt, file), text = readFileSync(path, 'utf8');
      if (file === 'CHANGELOG.md') writeFileSync(path, changelogWithRelease(text, r.version, today, renderNotes(r.commits)));
      else if (file === 'pyproject.toml') writeFileSync(path, text.replace(/^(\[project\][^[]*?^version\s*=\s*")[^"]+"/ms, `$1${r.version}"`));
      else if (file === 'package.json') writeFileSync(path, text.replace(/("version"\s*:\s*")[^"]+"/, `$1${r.version}"`));
      else if (file === 'package-lock.json') { const j = JSON.parse(text); j.version = r.version; if (j.packages?.['']) j.packages[''].version = r.version; writeFileSync(path, JSON.stringify(j, null, 2) + '\n'); }
      console.log(`  ${C.green}updated${C.reset} ${file}`);
    }
    must(git(wt, ['add', '-A']), 'git add');
    const title = `chore(release): v${r.version}`;
    must(git(wt, ['commit', '--no-verify', '--quiet', '-F', '-'], { input: `${title}\n\nPrepares v${r.version}: ${r.toPrepare.join(', ')}.\n\n${TRAILER}\n` }), 'git commit');
    must(git(wt, ['push', '--no-verify', '--quiet', 'origin', `HEAD:refs/heads/${branch}`]), 'git push');
    const notes = notesFor(r, readFileSync(join(wt, 'CHANGELOG.md'), 'utf8'));
    const body = [`Prepares **v${r.version}** (${r.base ? `from ${r.base}` : 'first release'}; ${r.worthy} release-worthy of ${r.commits.length} commits).`, '', `Updates ${r.toPrepare.map(f => `\`${f}\``).join(', ')}. After this merges, \`tools/release-train.mjs --apply --repo=${r.repo}\` publishes through \`${r.mode}\`${r.workflow ? ` (${r.workflow})` : ''}.`, '', '### Release notes', '', notes.body.trim(), '', '🤖 Generated with [Claude Code](https://claude.com/claude-code)'].join('\n') + '\n';
    const url = must(run('gh', ['pr', 'create', '--repo', r.slug, '--base', r.defaultBranch, '--head', branch, '--title', title, '--body-file', '-'], { input: body }), 'gh pr create').trim();
    console.log(`  ${C.bold}PR${C.reset} ${url}`);
  } finally {
    git(repoPath, ['worktree', 'remove', '--force', wt]);
    git(repoPath, ['worktree', 'prune']);
    git(repoPath, ['branch', '-D', branch]);
    rmSync(wt, { recursive: true, force: true });
  }
}

// ── publish ─────────────────────────────────────────────────────────────────
function publish(r) {
  const tag = `v${r.version}`;
  if (['nothing', 'recent'].includes(r.state) && !VERSION) fail(`${r.repo}: ${r.state === 'nothing' ? 'nothing release-worthy since the last release' : `released ${r.ageDays}d ago`} — pass --version=x.y.z to release anyway`);
  if (r.state === 'self' || r.state === 'off') fail(`${r.repo}: release mode is ${r.mode} — the train doesn't publish it`);
  if (r.failing.length) fail(`${r.repo}: workflows failing on ${r.defaultBranch} (${r.failing.join(', ')}) — fix CI first`);
  if (r.toPrepare.length) fail(`${r.repo}: run --prepare first and merge its PR (${r.toPrepare.join(', ')} don't match v${r.version})`);
  const repoPath = join(ROOT, r.repo);
  if (ok(git(repoPath, ['ls-remote', '--tags', 'origin', `refs/tags/${tag}`]))?.trim()) fail(`${r.repo}: tag ${tag} already exists on origin`);
  const sha = must(git(repoPath, ['rev-parse', r.ref]), 'rev-parse').trim();
  const notes = notesFor(r);
  if (r.mode === 'tag') {
    must(git(repoPath, ['tag', '-a', tag, sha, '-m', `${tag}\n\n${notes.body}`]), 'git tag');
    const push = git(repoPath, ['push', '--no-verify', 'origin', `refs/tags/${tag}`]);
    if (push.status !== 0) { git(repoPath, ['tag', '-d', tag]); fail(`git push tag failed: ${push.stderr.trim()}`); }
    console.log(`${C.green}pushed${C.reset} ${tag} at ${sha.slice(0, 7)} — ${r.workflow} publishes the release`);
  } else if (r.mode === 'dispatch') {
    must(run('gh', ['workflow', 'run', r.workflow, '-R', r.slug, '--ref', r.defaultBranch, '-f', `version=${r.version}`]), 'gh workflow run');
    console.log(`${C.green}dispatched${C.reset} ${r.workflow} with version=${r.version}`);
  } else {
    const fields = ['-f', `tag_name=${tag}`, '-f', `name=${tag}`, '-f', `target_commitish=${sha}`, '-f', `body=${notes.body}`, '-F', 'draft=false', '-f', 'make_latest=true'];
    const res = r.draft
      ? must(run('gh', ['api', '-X', 'PATCH', `repos/${r.slug}/releases/${r.draft.id}`, ...fields]), 'publish draft')
      : must(run('gh', ['api', '-X', 'POST', `repos/${r.slug}/releases`, ...fields]), 'create release');
    console.log(`${C.green}published${C.reset} ${JSON.parse(res).html_url}${r.workflow ? ` — triggers ${r.workflow}` : ''}`);
  }
}

// ── main ────────────────────────────────────────────────────────────────────
const repos = listRepos(onlyRepo).filter(r => !repoSettings(r)?.archived && (ALL || onlyRepo || tierFor(r) === 'active'));
if (onlyRepo && !repos.length) fail(`no repo named ${onlyRepo}`);
const order = { ready: 0, prepare: 1, blocked: 2, recent: 3, nothing: 4, self: 5, off: 6 };
const rows = repos.map(survey).filter(Boolean).sort((a, b) => (order[a.state] ?? 9) - (order[b.state] ?? 9) || a.repo.localeCompare(b.repo));
if (JSON_OUT) { console.log(JSON.stringify(rows.map(({ commits, changelog, ...r }) => ({ ...r, commits: commits.length })), null, 2)); process.exit(0); }
printSurvey(rows);
const r = rows[0];
if (onlyRepo && r && !r.error && !['nothing', 'self', 'off'].includes(r.state)) {
  const notes = notesFor(r);
  console.log(`\n${C.bold}v${r.version}${C.reset} notes ${C.dim}(from ${notes.from})${C.reset}`);
  notes.body.trim().split('\n').slice(0, 25).forEach(l => console.log(`  ${C.dim}│${C.reset} ${l}`));
}
if (PREPARE) prepare(r);
if (APPLY) publish(r);
