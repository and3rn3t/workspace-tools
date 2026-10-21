#!/usr/bin/env node
// sites.mjs — live-site quality for every repo with a site-check caller
// (.github/workflows/site-check.yml → and3rn3t/.github reusable-site-check.yml).
//
//   node tools/sites.mjs          # → .dashboard-data/sites.json + site_history.json
//   node tools/sites.mjs --print
//
// From the last 30 days of site-check runs on the default branch:
//   uptime %     share of runs whose "Homepage returns 200" job succeeded
//   links ok %   share of runs whose "Broken links on homepage" job succeeded
// and, when the reusable workflow uploads it, the latest `lighthouse` artifact
// (lighthouse.json: performance, accessibility, best-practices, seo — 0–100).

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { ROOT, listRepos } from './lib/manifest.mjs';
import { resolveToken, apiClient, repoSlug } from './lib/github.mjs';
import { loadMeta } from './lib/presentation.mjs';
import { tierFor } from './lib/activity.mjs';

const DAYS = 30;
const OUT = join(ROOT, '.dashboard-data');
const token = resolveToken();
if (!token) { console.error('no GitHub token found'); process.exit(1); }
const api = apiClient(token);
const meta = loadMeta();
const since = new Date(Date.now() - DAYS * 86400000).toISOString().slice(0, 10);

const jobOk = (jobs, re) => { const j = jobs.find(x => re.test(x.name)); return j ? j.conclusion === 'success' : null; };

function latestLighthouse(slug, runs) {
  for (const run of runs) {
    const dir = mkdtempSync(join(tmpdir(), 'lh-'));
    try {
      execFileSync('gh', ['run', 'download', String(run.id), '-R', slug, '-n', 'lighthouse', '-D', dir], { stdio: 'ignore' });
      const file = readdirSync(dir).find(f => f.endsWith('.json'));
      if (file) return { ...JSON.parse(readFileSync(join(dir, file), 'utf8')), run_url: run.html_url };
    } catch { /* no artifact on this run — older runs predate Lighthouse */ }
    finally { rmSync(dir, { recursive: true, force: true }); }
  }
  return null;
}

async function siteFor(dir) {
  if (!existsSync(join(ROOT, dir, '.github', 'workflows', 'site-check.yml'))) return null;
  const m = meta?.repos?.[dir];
  const slug = repoSlug(join(ROOT, dir), dir);
  // The URL actually checked is the caller's `url:` input, not the repo's homepage field.
  const checkedUrl = readFileSync(join(ROOT, dir, '.github', 'workflows', 'site-check.yml'), 'utf8').match(/^\s*url:\s*["']?([^"'\s]+)/m)?.[1];
  const branch = m?.defaultBranch ?? 'main';
  const res = await api(`/repos/${slug}/actions/workflows/site-check.yml/runs?branch=${branch}&status=completed&created=>=${since}&per_page=100`);
  const runs = (res.data?.workflow_runs ?? []).filter(r => r.conclusion !== 'cancelled' && r.conclusion !== 'skipped');
  const detailed = await Promise.all(runs.map(async run => {
    const jobs = (await api(`/repos/${slug}/actions/runs/${run.id}/jobs`)).data?.jobs ?? [];
    return { id: run.id, date: run.created_at.slice(0, 10), html_url: run.html_url, up: jobOk(jobs, /returns 200/i), links: jobOk(jobs, /broken links/i) };
  }));
  const pct = (k) => { const v = detailed.filter(d => d[k] !== null); return v.length ? Math.round(v.filter(d => d[k]).length / v.length * 100) : null; };
  const lh = latestLighthouse(slug, runs.slice(0, 5));
  const last = detailed[0];
  return {
    site: {
      repo: dir, tier: tierFor(dir), url: checkedUrl || lh?.url || m?.homepage || '', runs: detailed.length,
      uptime_30d: pct('up'), links_ok_30d: pct('links'), up_now: last?.up ?? null, links_ok_now: last?.links ?? null,
      performance: lh?.performance ?? null, accessibility: lh?.accessibility ?? null, best_practices: lh?.['best-practices'] ?? lh?.best_practices ?? null, seo: lh?.seo ?? null,
      lighthouse_at: lh?.timestamp ?? lh?.fetchedAt ?? null, last_run_url: last?.html_url ?? null,
    },
    history: detailed.map(d => ({ date: d.date, repo: dir, up: d.up, links_ok: d.links })),
  };
}

const results = (await Promise.all(listRepos().map(d => siteFor(d).catch(() => null)))).filter(Boolean);
const sites = results.map(r => r.site);
const history = results.flatMap(r => r.history).sort((a, b) => a.repo.localeCompare(b.repo) || a.date.localeCompare(b.date));

if (process.argv.includes('--print')) { console.table(sites); process.exit(0); }
mkdirSync(OUT, { recursive: true });
// The dashboard refuses an empty file; an all-blank row stands for "no sites".
const blankSite = { repo: '', tier: '', url: '', runs: 0, uptime_30d: null, links_ok_30d: null, up_now: null, links_ok_now: null, performance: null, accessibility: null, best_practices: null, seo: null, lighthouse_at: null, last_run_url: null };
writeFileSync(join(OUT, 'sites.json'), JSON.stringify(sites.length ? sites : [blankSite]));
writeFileSync(join(OUT, 'site_history.json'), JSON.stringify(history.length ? history : [{ date: '', repo: '', up: null, links_ok: null }]));
console.log(`sites → ${OUT}/sites.json (${sites.length} site(s), ${sites.filter(s => s.performance !== null).length} with Lighthouse scores, ${history.length} run rows)`);
