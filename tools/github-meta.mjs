#!/usr/bin/env node
// github-meta.mjs — fetch each repo's public-facing GitHub state into a local
// cache (.github-meta.json) so the zero-network dashboard can score it.
//
//   node tools/github-meta.mjs              # refresh the cache for every repo
//   node tools/github-meta.mjs --repo=guess # refresh one repo (merged into the cache)
//
// One small GraphQL query per repo covers description, homepage, topics, fork/
// archived, classic branch protection, latest release, open PRs (by author),
// open issues and open Dependabot alerts (by severity). REST fills what
// GraphQL lacks: rulesets (only when no classic rule), Actions workflows +
// latest completed run per workflow on the default branch, code-scanning and
// secret-scanning alerts. Read-only.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, listRepos } from './lib/manifest.mjs';
import { resolveToken, apiClient, graphqlClient, repoSlug } from './lib/github.mjs';
import { META_CACHE, loadMeta } from './lib/presentation.mjs';

const FAILING = new Set(['failure', 'startup_failure', 'timed_out']);
const BOTS = /renovate|dependabot|github-actions|\[bot\]/i;
const onlyRepo = (process.argv.find(a => a.startsWith('--repo=')) || '').split('=')[1];

const token = resolveToken();
if (!token) { console.error('no GitHub token found (set $GH_TOKEN or run `gh auth login`)'); process.exit(1); }
const api = apiClient(token);
const graphql = graphqlClient(token);

const REPO_FIELDS = `
  name nameWithOwner description homepageUrl isArchived isFork visibility
  repositoryTopics(first: 30) { nodes { topic { name } } }
  defaultBranchRef { name branchProtectionRule { id } }
  latestRelease { tagName publishedAt }
  pullRequests(states: OPEN, first: 100) { totalCount nodes { author { login } } }
  issues(states: OPEN) { totalCount }
`;

// Per repo rather than one paged query over all repos: a page of repos each
// carrying 100 PR + 100 alert nodes exceeds GitHub's resource limits and
// undercounts alerts, and per-repo queries run in parallel with the REST calls.
// Dependabot alerts get their own paginated query: inside the combined query
// above GitHub silently returns only 25 of guess's 98 alert nodes.
async function vulnerabilitySeverities(owner, name) {
  const severities = [];
  let cursor = null, total = 0;
  do {
    const d = await graphql(`query($owner: String!, $name: String!, $cursor: String) { repository(owner: $owner, name: $name) {
      vulnerabilityAlerts(states: OPEN, first: 100, after: $cursor) { totalCount pageInfo { hasNextPage endCursor } nodes { createdAt securityAdvisory { severity } } } } }`, { owner, name, cursor });
    const page = d.repository.vulnerabilityAlerts;
    total = page.totalCount;
    severities.push(...page.nodes.map(a => ({ severity: a.securityAdvisory?.severity, createdAt: a.createdAt })));
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);
  if (severities.length !== total) throw new Error(`dependabot alerts: got ${severities.length} of ${total}`);
  return severities;
}

const repoQuery = (owner, name) => graphql(`query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${REPO_FIELDS} } }`, { owner, name })
  .then(d => d.repository);

const countBy = (items, key) => items.reduce((acc, i) => { const k = key(i); if (k) acc[k] = (acc[k] ?? 0) + 1; return acc; }, {});
const SEVERITY = { CRITICAL: 'critical', HIGH: 'high', MODERATE: 'medium', MEDIUM: 'medium', LOW: 'low' };
const CODE_SEVERITY = { critical: 'critical', high: 'high', medium: 'medium', low: 'low', error: 'high', warning: 'medium', note: 'low' };

async function restDetails(slug, branch, classicProtected) {
  const [rules, workflows, runs, code, secrets, alerts, fixes] = await Promise.all([
    classicProtected ? Promise.resolve(null) : api(`/repos/${slug}/rules/branches/${branch}`),
    api(`/repos/${slug}/actions/workflows?per_page=100`),
    api(`/repos/${slug}/actions/runs?branch=${branch}&status=completed&per_page=100`),
    api(`/repos/${slug}/code-scanning/alerts?state=open&per_page=100`),
    api(`/repos/${slug}/secret-scanning/alerts?state=open&per_page=100`),
    api(`/repos/${slug}/vulnerability-alerts`),
    api(`/repos/${slug}/automated-security-fixes`),
  ]);
  // Latest completed run per still-active workflow (deleted or disabled
  // workflows don't count against the repo); the API returns newest first.
  const active = new Map((workflows.data?.workflows ?? []).filter(w => w.state === 'active').map(w => [w.id, w.name]));
  const latest = new Map();
  for (const run of runs.data?.workflow_runs ?? []) if (active.has(run.workflow_id) && !latest.has(run.workflow_id)) latest.set(run.workflow_id, run);
  return {
    protected: classicProtected || (Array.isArray(rules?.data) && rules.data.length > 0),
    workflows: latest.size,
    failing: [...latest.values()].filter(run => FAILING.has(run.conclusion))
      .map(run => ({ workflow: active.get(run.workflow_id), conclusion: run.conclusion, url: run.html_url })),
    // null = feature not enabled / not visible (404/403), so "0" always means checked and clean.
    codeScanning: Array.isArray(code.data)
      ? { total: code.data.length, ...countBy(code.data, a => CODE_SEVERITY[a.rule?.security_severity_level ?? a.rule?.severity]) }
      : null,
    codeScanningOpened: Array.isArray(code.data)
      ? code.data.map(a => ({ severity: CODE_SEVERITY[a.rule?.security_severity_level ?? a.rule?.severity], createdAt: a.created_at }))
      : [],
    secretScanning: Array.isArray(secrets.data) ? secrets.data.length : null,
    // Dependabot settings for the `security` plan category; null = not readable.
    security: {
      alerts: alerts.status === 204 ? true : alerts.status === 404 ? false : null,
      updates: fixes.data ? fixes.data.enabled === true : fixes.status === 404 ? false : null,
    },
  };
}

async function fetchRepo(dir) {
  const slug = repoSlug(join(ROOT, dir), dir);
  const [owner, name] = slug.split('/');
  const [r, severities] = await Promise.all([repoQuery(owner, name), vulnerabilitySeverities(owner, name).catch(() => null)]);
  if (!r) return { slug, error: 'repository not found' };
  const branch = r.defaultBranchRef?.name ?? 'main';
  const rest = await restDetails(slug, branch, !!r.defaultBranchRef?.branchProtectionRule);
  const prAuthors = r.pullRequests.nodes.map(p => p.author?.login ?? '');
  // null = alerts not readable (disabled or no permission), so 0 always means checked and clean.
  const vuln = severities?.map(a => SEVERITY[a.severity]) ?? null;
  // Age in days of the oldest open critical / high alert (Dependabot + code scanning) — for alert SLAs.
  const opened = [...(severities ?? []).map(a => ({ severity: SEVERITY[a.severity], createdAt: a.createdAt })), ...rest.codeScanningOpened];
  const oldest = (sev) => { const ts = opened.filter(a => a.severity === sev && a.createdAt).map(a => Date.parse(a.createdAt)); return ts.length ? Math.floor((Date.now() - Math.min(...ts)) / 86400000) : null; };
  delete rest.codeScanningOpened;
  return {
    slug,
    description: r.description || '',
    homepage: r.homepageUrl || '',
    topics: r.repositoryTopics.nodes.map(t => t.topic.name),
    visibility: r.visibility.toLowerCase(),
    fork: r.isFork,
    archived: r.isArchived,
    defaultBranch: branch,
    ...rest,
    latestRelease: r.latestRelease?.tagName ?? null,
    latestReleaseAt: r.latestRelease?.publishedAt ?? null,
    openPrs: { human: prAuthors.filter(a => !BOTS.test(a)).length, bot: prAuthors.filter(a => BOTS.test(a)).length, total: r.pullRequests.totalCount },
    openIssues: r.issues.totalCount,
    dependabot: vuln ? { total: vuln.length, ...countBy(vuln, s => s) } : null,
    oldestAlertDays: { critical: oldest('critical'), high: oldest('high') },
  };
}

const started = Date.now();
const cache = loadMeta() ?? { repos: {} };
const dirs = listRepos(onlyRepo);
const results = {};
for (let i = 0; i < dirs.length; i += 8) {
  const batch = dirs.slice(i, i + 8);
  const fetched = await Promise.all(batch.map(d => fetchRepo(d).catch(e => ({ error: e.message }))));
  batch.forEach((d, j) => { results[d] = fetched[j]; });
}

const next = { generatedAt: new Date().toISOString(), repos: onlyRepo ? { ...cache.repos, ...results } : results };
writeFileSync(META_CACHE, JSON.stringify(next, null, 2) + '\n');

const vals = Object.values(results);
const errors = vals.filter(v => v.error).length;
const failingRepos = Object.entries(results).filter(([, v]) => v.failing?.length).map(([k]) => k);
const unprotected = Object.entries(results).filter(([, v]) => !v.error && !v.archived && !v.protected).map(([k]) => k);
const critHigh = vals.reduce((a, v) => a + (v.dependabot?.critical ?? 0) + (v.dependabot?.high ?? 0) + (v.codeScanning?.critical ?? 0) + (v.codeScanning?.high ?? 0), 0);
console.log(`github meta written → ${META_CACHE} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
console.log(`${vals.length} repo(s) · ${failingRepos.length} with failing workflows on default branch${failingRepos.length ? ` (${failingRepos.join(', ')})` : ''} · ${unprotected.length} unprotected · ${critHigh} critical/high security alerts${errors ? ` · ${errors} error(s)` : ''}`);
