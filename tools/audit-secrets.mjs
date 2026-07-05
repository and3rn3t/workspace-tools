#!/usr/bin/env node
// audit-secrets.mjs — cross-check each repo's workflow files against the
// Actions secrets actually configured on GitHub. Read-only; never prints a
// secret value (GitHub's list API only ever returns names, never values).
//
//   node tools/audit-secrets.mjs                 # audit every repo
//   node tools/audit-secrets.mjs --repo=guess     # limit to one repo
//   node tools/audit-secrets.mjs --json           # machine-readable output
//
// Auth resolution order: $GH_TOKEN / $GITHUB_TOKEN env var, then `gh auth
// token` if the GitHub CLI is installed and logged in. No token is ever
// written to disk by this script.

import { readdirSync, readFileSync, existsSync } from 'node:fs';
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

function referencedSecrets(repoPath) {
  const wfDir = join(repoPath, '.github', 'workflows');
  if (!existsSync(wfDir)) return new Map(); // secret -> [workflow files]
  const map = new Map();
  for (const f of readdirSync(wfDir)) {
    if (!f.endsWith('.yml') && !f.endsWith('.yaml')) continue;
    const content = readFileSync(join(wfDir, f), 'utf8');
    const matches = content.matchAll(/secrets\.([A-Z_][A-Z0-9_]*)/g);
    for (const m of matches) {
      const name = m[1];
      if (name === 'GITHUB_TOKEN') continue; // always auto-provided, never a repo secret
      if (!map.has(name)) map.set(name, []);
      map.get(name).push(f);
    }
  }
  return map;
}

const C = { reset: '\x1b[0m', dim: '\x1b[2m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m' };
const report = [];

for (const repo of listRepos()) {
  const referenced = referencedSecrets(join(ROOT, repo));
  if (referenced.size === 0) continue;

  let configured = new Set();
  try {
    const data = await gh(`/repos/${OWNER}/${repo}/actions/secrets`);
    configured = new Set((data?.secrets || []).map(s => s.name));
  } catch (e) {
    console.error(`${repo}: could not read secrets (${e.message}) — skipping`);
    continue;
  }

  const missing = [...referenced.keys()].filter(n => !configured.has(n));
  report.push({ repo, referenced: [...referenced.keys()], configured: [...configured], missing, usedIn: Object.fromEntries(referenced) });
}

if (JSON_OUT) {
  console.log(JSON.stringify(report, null, 2));
} else {
  let totalMissing = 0;
  for (const r of report) {
    if (r.missing.length === 0) continue;
    totalMissing += r.missing.length;
    console.log(`${C.cyan}${r.repo}${C.reset}`);
    for (const name of r.missing) {
      const files = r.usedIn[name].join(', ');
      console.log(`  ${C.red}MISSING${C.reset} ${name} ${C.dim}(used in ${files})${C.reset}`);
    }
  }
  console.log(`\n${C.dim}────────────────────────────────────────${C.reset}`);
  console.log(`${report.length} repo(s) with workflow secrets checked, ${C.red}${totalMissing}${C.reset} missing secret(s) found`);
  if (totalMissing === 0) console.log(`${C.green}all referenced secrets are configured${C.reset}`);
}
