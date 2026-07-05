#!/usr/bin/env node
// renovate-status.mjs — aggregate each repo's Renovate "Dependency Dashboard"
// issue into one sorted view. Renovate gates major-version bumps behind
// dependencyDashboardApproval (see ai-template-repo/renovate.json), so these
// pile up silently unless someone goes and looks — this surfaces the backlog.
//
//   node tools/renovate-status.mjs            # every repo, sorted by pending count
//   node tools/renovate-status.mjs --repo=guess
//   node tools/renovate-status.mjs --json
//
// Auth resolution order: $GH_TOKEN / $GITHUB_TOKEN env var, then `gh auth
// token`. Read-only — never modifies anything.

import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = new Set(['ai-template-repo', '.github', '.git', 'tools', 'node_modules']);
const OWNER = 'and3rn3t';

const args = process.argv.slice(2);
const onlyRepo = (args.find(a => a.startsWith('--repo=')) || '').split('=')[1];
const JSON_OUT = args.includes('--json');

function resolveToken() {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  const r = spawnSync('gh', ['auth', 'token'], { encoding: 'utf8' });
  if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  return null;
}

const TOKEN = resolveToken();
if (!TOKEN) {
  console.error('No GitHub token found. Set $GH_TOKEN/$GITHUB_TOKEN, or `gh auth login` first.');
  process.exit(2);
}

async function gh(path) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}

function listRepos() {
  return readdirSync(ROOT, { withFileTypes: true })
    .filter(e => e.isDirectory() && !SKIP.has(e.name) && !e.name.startsWith('.'))
    .map(e => e.name)
    .filter(name => !onlyRepo || name === onlyRepo)
    .sort();
}

const C = { reset: '\x1b[0m', dim: '\x1b[2m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m' };
const report = [];

for (const repo of listRepos()) {
  let issues;
  try {
    issues = await gh(`/repos/${OWNER}/${repo}/issues?state=open&per_page=20`);
  } catch (e) {
    console.error(`${repo}: could not read issues (${e.message}) — skipping`);
    continue;
  }
  if (!issues) continue;
  const dash = issues.find(i => (i.title || '').startsWith('Dependency Dashboard') && !i.pull_request);
  if (!dash) continue;
  const body = dash.body || '';
  const pending = (body.match(/- \[ \]/g) || []).length;
  const awaitingApproval = /rate-limited|awaiting/i.test(body);
  report.push({ repo, pending, url: dash.html_url });
}

report.sort((a, b) => b.pending - a.pending);

if (JSON_OUT) {
  console.log(JSON.stringify(report, null, 2));
} else {
  let total = 0;
  for (const r of report) {
    if (r.pending === 0) continue;
    total += r.pending;
    const tag = r.pending >= 30 ? C.red : r.pending >= 10 ? C.yellow : C.dim;
    console.log(`${C.cyan}${r.repo.padEnd(20)}${C.reset} ${tag}${String(r.pending).padStart(3)} pending${C.reset}  ${C.dim}${r.url}${C.reset}`);
  }
  console.log(`\n${C.dim}────────────────────────────────────────${C.reset}`);
  console.log(`${report.length} repo(s) with a Dependency Dashboard, ${total} pending update(s) awaiting review across the workspace`);
  console.log(`${C.dim}Renovate gates majors behind manual approval by design (see renovate.json) — this is a backlog to review, not a bug.${C.reset}`);
}
