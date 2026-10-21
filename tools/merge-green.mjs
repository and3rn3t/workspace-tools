#!/usr/bin/env node
// merge-green.mjs — bot-PR autopilot for active repos.
//
//   node tools/merge-green.mjs                 # dry run: classify every open Renovate/Dependabot PR
//   node tools/merge-green.mjs --apply         # merge the green, non-major ones
//   node tools/merge-green.mjs --repo=guess [--apply]
//   node tools/merge-green.mjs --json
//
// A PR is merged only when, re-checked right before merging, it is: open, by a bot,
// not a draft, MERGEABLE, every check SUCCESS/NEUTRAL/SKIPPED, and not a major
// update — majors are read from the PR body ("from 3.2.7 to 5.0.5", "`^3.0.0` -> `^4.0.0`"),
// not just the title, because grouped Dependabot PRs hide them ("bump tinypool,
// @vitest/coverage-v8, @vitest/ui" was vitest 3 → 5). Grouped updates are left
// for review. Merges are normal squash merges — never --admin, so branch
// protection still applies. In repos whose protection requires up-to-date
// branches, each merge makes the rest of that repo's PRs stale: Dependabot ones
// get an "@dependabot rebase" comment (Renovate rebases its own) and show up as
// green again on the next run.
//
// Repos with `"automerge": false` in workspace.json are listed but never merged.

import { execFileSync } from 'node:child_process';
import { listRepos } from './lib/manifest.mjs';
import { tierFor } from './lib/activity.mjs';
import { repoSettings } from './lib/workspace.mjs';
import { OWNER } from './lib/github.mjs';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const JSON_OUT = args.includes('--json');
const onlyRepo = (args.find(a => a.startsWith('--repo=')) || '').split('=')[1];
const C = { reset: '\x1b[0m', dim: '\x1b[2m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m', bold: '\x1b[1m' };

const BOT = /renovate|dependabot/i;
const OK = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
const PENDING = new Set(['PENDING', 'IN_PROGRESS', 'QUEUED', 'EXPECTED', 'WAITING', 'REQUESTED']);
const FIELDS = 'number,title,body,author,headRefName,isDraft,mergeable,statusCheckRollup,url';

const gh = (argv) => execFileSync('gh', argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const ghJson = (argv) => JSON.parse(gh(argv));

const majorOf = v => { const m = String(v).match(/(\d+)(?:\.\d+)*/); return m ? Number(m[1]) : null; };

// Every version change a PR announces, from its title and body.
function versionChanges(pr) {
  const text = `${pr.title}\n${pr.body ?? ''}`;
  const pairs = [
    ...text.matchAll(/from v?([\d][\w.-]*) to v?([\d][\w.-]*)/gi),               // Dependabot
    ...text.matchAll(/`[\^~>=<]*v?([\d][\w.-]*)`\s*(?:->|→)\s*`[\^~>=<]*v?([\d][\w.-]*)`/g), // Renovate table
  ];
  return pairs.map(([, from, to]) => ({ from: majorOf(from), to: majorOf(to) })).filter(p => p.from !== null && p.to !== null);
}

export function classify(pr) {
  if (/(^|\/)major-/i.test(pr.headRefName) || /\(major\)|\bmajor\b update/i.test(pr.title)) return 'major';
  const changes = versionChanges(pr);
  if (changes.some(c => c.to > c.from)) return 'major';
  if (/\bgroup\b.*\bwith \d+ updates?/i.test(pr.title)) return 'group';
  if (!changes.length && /\bto v?\d+\s*(\[|$)/i.test(pr.title)) return 'major';            // "update x to v5"
  return 'minor/patch';
}

export function checkState(pr) {
  const rs = pr.statusCheckRollup ?? [];
  if (!rs.length) return { state: 'no checks', failing: [] };
  const st = rs.map(r => r.conclusion || r.state || r.status);
  if (st.some(s => !s || PENDING.has(s))) return { state: 'pending', failing: [] };
  const failing = [...new Set(rs.filter(r => !OK.has(r.conclusion || r.state)).map(r => r.name || r.context))];
  return { state: failing.length ? 'failing' : 'green', failing };
}

const strictRepo = (repo) => {
  try { return ghJson(['api', `repos/${OWNER}/${repo}/branches/main/protection`, '--jq', '{s: .required_status_checks.strict}']).s === true; }
  catch { return false; }
};

const repos = listRepos(onlyRepo).filter(r => tierFor(r) === 'active' && !repoSettings(r)?.archived);
const report = [];
let merged = 0, rebaseAsked = 0;

for (const repo of repos) {
  let prs;
  try { prs = ghJson(['pr', 'list', '-R', `${OWNER}/${repo}`, '--state', 'open', '--limit', '100', '--json', FIELDS]); }
  catch (e) { report.push({ repo, error: e.message.split('\n')[0] }); continue; }
  const automerge = repoSettings(repo)?.automerge !== false;
  const strict = APPLY && automerge ? strictRepo(repo) : false;
  const bots = prs.filter(p => BOT.test(p.author.login)).map(p => ({
    repo, number: p.number, bot: /renovate/i.test(p.author.login) ? 'renovate' : 'dependabot',
    kind: classify(p), ...checkState(p), mergeable: p.mergeable, draft: p.isDraft, title: p.title, url: p.url,
  }));
  for (const p of bots) {
    p.eligible = automerge && !p.draft && p.kind === 'minor/patch' && p.state === 'green';
    p.action = !automerge ? 'automerge off' : p.eligible ? (APPLY ? 'pending merge' : 'would merge') : p.kind !== 'minor/patch' ? `review (${p.kind})` : p.state;
  }

  if (APPLY) {
    let mergedHere = false;
    for (const p of bots.filter(b => b.eligible)) {
      // Fresh re-check right before merging: anything may have changed since the list.
      const fresh = ghJson(['pr', 'view', String(p.number), '-R', `${OWNER}/${repo}`, '--json', `state,${FIELDS}`]);
      const still = fresh.state === 'OPEN' && BOT.test(fresh.author.login) && !fresh.isDraft && classify(fresh) === 'minor/patch' && checkState(fresh).state === 'green';
      if (!still) { p.action = 'changed — skipped'; continue; }
      if (fresh.mergeable !== 'MERGEABLE') {
        if (strict && mergedHere && p.bot === 'dependabot') { gh(['pr', 'comment', String(p.number), '-R', `${OWNER}/${repo}`, '--body', '@dependabot rebase']); rebaseAsked++; p.action = 'rebase requested'; }
        else p.action = `not mergeable (${fresh.mergeable})`;
        continue;
      }
      try {
        gh(['pr', 'merge', String(p.number), '-R', `${OWNER}/${repo}`, '--squash']);
        p.action = 'merged'; merged++; mergedHere = true;
      } catch (e) {
        const msg = e.stderr?.toString().trim().split('\n').pop() ?? e.message;
        if (strict && /administrator|not up to date|behind/i.test(msg) && p.bot === 'dependabot') {
          gh(['pr', 'comment', String(p.number), '-R', `${OWNER}/${repo}`, '--body', '@dependabot rebase']); rebaseAsked++; p.action = 'rebase requested';
        } else if (strict && /administrator|not up to date|behind/i.test(msg)) p.action = 'behind main — Renovate will rebase';
        else p.action = `merge failed: ${msg}`;
      }
    }
  }
  report.push(...bots);
}

if (JSON_OUT) { console.log(JSON.stringify(report, null, 2)); process.exit(0); }

const colour = a => a === 'merged' || a === 'would merge' ? C.green : /review|failing|failed|not mergeable/.test(a) ? C.yellow : C.dim;
for (const repo of repos) {
  const rows = report.filter(r => r.repo === repo);
  if (!rows.length) continue;
  console.log(`${C.cyan}${repo}${C.reset}`);
  for (const r of rows) {
    if (r.error) { console.log(`  ${C.red}error${C.reset} ${r.error}`); continue; }
    const why = r.state === 'failing' ? ` ${C.dim}(${r.failing.slice(0, 2).join(', ')})${C.reset}` : '';
    console.log(`  ${colour(r.action)}${r.action.padEnd(22)}${C.reset} #${String(r.number).padEnd(5)} ${r.kind.padEnd(12)} ${r.title.slice(0, 70)}${why}`);
  }
}
const prs = report.filter(r => !r.error);
const count = (pred) => prs.filter(pred).length;
console.log(`\n${prs.length} bot PR(s) in ${repos.length} active repo(s): ${count(r => r.eligible)} green patch/minor · ${count(r => r.kind !== 'minor/patch')} major/group for review · ${count(r => r.state === 'failing')} failing · ${count(r => r.state === 'pending')} pending`);
if (APPLY) console.log(`merged ${merged}${rebaseAsked ? ` · asked Dependabot to rebase ${rebaseAsked} (merge on the next run once green)` : ''}`);
else if (count(r => r.eligible)) console.log(`${C.dim}run with --apply to merge the ${count(r => r.eligible)} green patch/minor PR(s)${C.reset}`);
