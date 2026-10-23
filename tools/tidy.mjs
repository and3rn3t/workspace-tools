#!/usr/bin/env node
// tidy.mjs — local hygiene across every clone, plus release nudges.
//
//   node tools/tidy.mjs              # dry run: what would change
//   node tools/tidy.mjs --apply      # do the local-only fixes
//   node tools/tidy.mjs --repo=guess
//
// Local fixes (only with --apply, and only in clones with no uncommitted changes):
//   back-to-default   checked out on a branch whose PR is merged/closed, or that
//                     origin's default branch already contains → switch to default
//   fast-forward      default branch behind origin → `git merge --ff-only`
//   delete-merged     local branches fully merged into origin's default (never the
//                     default or the checked-out branch)
//   prune             `git fetch --prune` + `git worktree prune`
// Stale .git lock files are handled by `make git-doctor-fix` (run after --apply).
// Nothing is pushed, nothing on GitHub changes.
//
// Release nudges (report only): a release-drafter draft with notes waiting while
// the last published release is 30+ days old (or there is none) — publish with
// `node tools/release-first.mjs --repo=x` for a first release, or GitHub's UI.

import { spawnSync, execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { ROOT, listRepos } from './lib/manifest.mjs';
import { loadMeta } from './lib/presentation.mjs';
import { tierFor } from './lib/activity.mjs';
import { OWNER } from './lib/github.mjs';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const onlyRepo = (args.find(a => a.startsWith('--repo=')) || '').split('=')[1];
const C = { reset: '\x1b[0m', dim: '\x1b[2m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m' };
const NUDGE_DAYS = 30;

const git = (repo, argv) => { const r = spawnSync('git', ['-C', join(ROOT, repo), ...argv], { encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : null; };
const ghJson = (argv) => { try { return JSON.parse(execFileSync('gh', argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })); } catch { return null; } };
const meta = loadMeta();

const report = [];
for (const repo of listRepos(onlyRepo)) {
  if (git(repo, ['rev-parse', '--git-dir']) === null) continue;
  const actions = [];
  if (APPLY) git(repo, ['fetch', '--prune', '--quiet']);
  const defRef = git(repo, ['rev-parse', '--abbrev-ref', 'origin/HEAD']);
  if (!defRef) { report.push({ repo, actions: [{ kind: 'skip', text: 'no origin/HEAD' }] }); continue; }
  const def = defRef.replace(/^origin\//, '');
  const branch = git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const dirty = (git(repo, ['status', '--porcelain']) ?? '').split('\n').filter(Boolean).length;

  // back-to-default
  if (branch && branch !== def && branch !== 'HEAD') {
    const contained = git(repo, ['merge-base', '--is-ancestor', branch, defRef]) !== null;
    const prs = ghJson(['pr', 'list', '-R', `${OWNER}/${repo}`, '--head', branch, '--state', 'all', '--json', 'number,state', '--limit', '5']) ?? [];
    const open = prs.some(p => p.state === 'OPEN');
    const done = prs.length && prs.every(p => p.state !== 'OPEN');
    if (!open && (done || contained)) {
      const why = done ? `PR #${prs[0].number} ${prs[0].state.toLowerCase()}` : 'already in ' + def;
      if (dirty) actions.push({ kind: 'back-to-default', text: `on ${branch} (${why}) — ${dirty} uncommitted file(s), left alone` });
      else {
        actions.push({ kind: 'back-to-default', text: `${branch} → ${def} (${why})` });
        if (APPLY) git(repo, ['checkout', '-q', def]);
      }
    }
  }
  // fast-forward the default branch when it's checked out and clean
  const current = APPLY ? git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']) : branch;
  const behind = Number(git(repo, ['rev-list', '--count', `${def}..${defRef}`]) ?? 0);
  const ahead = Number(git(repo, ['rev-list', '--count', `${defRef}..${def}`]) ?? 0);
  if (behind && !ahead) {
    if (current === def && !dirty) { actions.push({ kind: 'fast-forward', text: `${def} ${behind} commit(s) behind origin` }); if (APPLY) git(repo, ['merge', '--ff-only', '--quiet', defRef]); }
    else if (current !== def) { actions.push({ kind: 'fast-forward', text: `${def} ${behind} behind (not checked out)` }); if (APPLY) git(repo, ['fetch', '--quiet', 'origin', `${def}:${def}`]); }
  }
  // delete local branches already merged into origin's default
  const merged = (git(repo, ['branch', '--format=%(refname:short)', '--merged', defRef]) ?? '').split('\n').filter(b => b && b !== def && b !== (APPLY ? git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']) : branch));
  // -D, not -d: `git branch -d` checks against the checked-out branch, so it refuses
  // a branch merged into origin's default while a PR branch is checked out. The
  // --merged filter above already proved each one is in origin's default branch.
  for (const b of merged) { actions.push({ kind: 'delete-merged', text: `branch ${b}` }); if (APPLY) git(repo, ['branch', '-D', '-q', b]); }
  // prune stale worktrees
  const worktrees = (git(repo, ['worktree', 'list', '--porcelain']) ?? '').split('\n').filter(l => l.startsWith('prunable')).length;
  if (worktrees) { actions.push({ kind: 'prune', text: `${worktrees} stale worktree(s)` }); if (APPLY) git(repo, ['worktree', 'prune']); }

  // release nudge (report only) for active repos
  const m = meta?.repos?.[repo];
  if (tierFor(repo) === 'active' && m && !m.error && !m.archived) {
    const age = m.latestReleaseAt ? Math.floor((Date.now() - Date.parse(m.latestReleaseAt)) / 86400000) : null;
    if (age === null || age >= NUDGE_DAYS) {
      const draft = (ghJson(['api', `repos/${OWNER}/${repo}/releases?per_page=10`]) ?? []).find(r => r.draft && (r.body ?? '').trim().length > 40);
      if (draft) actions.push({ kind: 'release-nudge', text: `draft ${draft.name || draft.tag_name} is waiting; ${age === null ? 'no release published yet' : `last release ${age} days ago`}` });
    }
  }
  if (actions.length) report.push({ repo, branch, dirty, actions });
}

if (args.includes('--json')) { console.log(JSON.stringify(report, null, 2)); process.exit(0); }
const colour = k => (k === 'release-nudge' ? C.yellow : k === 'skip' ? C.dim : C.green);
for (const r of report) {
  console.log(`${C.cyan}${r.repo}${C.reset}`);
  for (const a of r.actions) console.log(`  ${colour(a.kind)}${a.kind.padEnd(16)}${C.reset} ${a.text}`);
}
const count = k => report.reduce((n, r) => n + r.actions.filter(a => a.kind === k).length, 0);
const local = count('back-to-default') + count('fast-forward') + count('delete-merged') + count('prune');
console.log(`\n${APPLY ? 'did' : 'would do'} ${local} local fix(es) in ${report.filter(r => r.actions.some(a => a.kind !== 'release-nudge' && a.kind !== 'skip')).length} repo(s) · ${count('release-nudge')} release nudge(s)`);
if (!APPLY && local) console.log(`${C.dim}run with --apply to do the local fixes (then make git-doctor-fix for stale locks)${C.reset}`);
