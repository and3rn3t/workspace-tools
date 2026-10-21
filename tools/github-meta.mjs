#!/usr/bin/env node
// github-meta.mjs — fetch each repo's public-facing GitHub state into a local
// cache (.github-meta.json) so the zero-network dashboard can score it.
//
//   node tools/github-meta.mjs              # refresh the cache for every repo
//   node tools/github-meta.mjs --repo=guess # refresh one repo (merged into the cache)
//
// Per repo: description, homepage, topics, fork/archived, default-branch
// protection (classic rule or ruleset), latest completed run per workflow on
// the default branch, and the latest release tag. Read-only API calls.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, listRepos } from './lib/manifest.mjs';
import { resolveToken, apiClient, repoSlug } from './lib/github.mjs';
import { META_CACHE, loadMeta } from './lib/presentation.mjs';

const FAILING = new Set(['failure', 'startup_failure', 'timed_out']);
const onlyRepo = (process.argv.find(a => a.startsWith('--repo=')) || '').split('=')[1];

const token = resolveToken();
if (!token) { console.error('no GitHub token found (set $GH_TOKEN or run `gh auth login`)'); process.exit(1); }
const api = apiClient(token);

async function fetchRepo(dir) {
  const slug = repoSlug(join(ROOT, dir), dir);
  const repo = await api(`/repos/${slug}`);
  if (!repo.data) return { slug, error: `HTTP ${repo.status}` };
  const r = repo.data;
  const branch = r.default_branch;

  const [classic, rules, workflows, runs, releases] = await Promise.all([
    api(`/repos/${slug}/branches/${branch}/protection`),
    api(`/repos/${slug}/rules/branches/${branch}`),
    api(`/repos/${slug}/actions/workflows?per_page=100`),
    api(`/repos/${slug}/actions/runs?branch=${branch}&status=completed&per_page=100`),
    api(`/repos/${slug}/releases?per_page=1`),
  ]);

  // Latest completed run per still-active workflow (deleted or disabled
  // workflows don't count against the repo); the API returns newest first.
  const active = new Map((workflows.data?.workflows ?? []).filter(w => w.state === 'active').map(w => [w.id, w.name]));
  const latest = new Map();
  for (const run of runs.data?.workflow_runs ?? []) {
    if (active.has(run.workflow_id) && !latest.has(run.workflow_id)) latest.set(run.workflow_id, run);
  }
  const failing = [...latest.values()].filter(run => FAILING.has(run.conclusion))
    .map(run => ({ workflow: active.get(run.workflow_id), conclusion: run.conclusion, url: run.html_url }));

  return {
    slug,
    description: r.description || '',
    homepage: r.homepage || '',
    topics: r.topics || [],
    visibility: r.visibility,
    fork: r.fork,
    archived: r.archived,
    defaultBranch: branch,
    protected: classic.status === 200 || (Array.isArray(rules.data) && rules.data.length > 0),
    workflows: latest.size,
    failing,
    latestRelease: releases.data?.[0]?.tag_name || null,
  };
}

const cache = loadMeta() ?? { repos: {} };

const dirs = listRepos(onlyRepo);
const results = {};
for (let i = 0; i < dirs.length; i += 6) {
  const batch = dirs.slice(i, i + 6);
  const fetched = await Promise.all(batch.map(d => fetchRepo(d).catch(e => ({ error: e.message }))));
  batch.forEach((d, j) => { results[d] = fetched[j]; });
}

const next = { generatedAt: new Date().toISOString(), repos: onlyRepo ? { ...cache.repos, ...results } : results };
writeFileSync(META_CACHE, JSON.stringify(next, null, 2) + '\n');

const vals = Object.values(results);
const errors = vals.filter(v => v.error).length;
const failingRepos = Object.entries(results).filter(([, v]) => v.failing?.length).map(([k]) => k);
const unprotected = Object.entries(results).filter(([, v]) => !v.error && !v.archived && !v.protected).map(([k]) => k);
console.log(`github meta written → ${META_CACHE}`);
console.log(`${vals.length} repo(s) · ${failingRepos.length} with failing workflows on default branch${failingRepos.length ? ` (${failingRepos.join(', ')})` : ''} · ${unprotected.length} unprotected${errors ? ` · ${errors} error(s)` : ''}`);
