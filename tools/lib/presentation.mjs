// Presentation checks: what a visitor to the repo on GitHub actually sees.
// Local checks read the README and repo files; remote checks read the
// .github-meta.json cache written by tools/github-meta.mjs (skipped, not
// failed, when the cache is absent or has no entry for the repo).
//
// A repo can bless a deliberate exception in .consistency-ignore with a
// `presentation:<key>` line, e.g. `presentation:screenshot` for a CLI.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, ignoredFor } from './manifest.mjs';

export const META_CACHE = join(ROOT, '.github-meta.json');

export function loadMeta() {
  try { return JSON.parse(readFileSync(META_CACHE, 'utf8')); } catch { return null; }
}

const BADGE = /shields\.io|badge\.svg|badgen\.net|\/actions\/workflows\//i;
const imagesIn = md => [
  ...[...md.matchAll(/!\[[^\]]*\]\(([^)\s]+)/g)].map(m => m[1]),
  ...[...md.matchAll(/<img[^>]+src=["']([^"']+)/gi)].map(m => m[1]),
];
const heading = (md, re) => md.split('\n').some(l => /^#{1,4}\s/.test(l) && re.test(l));

// A Cloudflare deploy target means there's a live site the homepage field should point at.
const hasDeployTarget = (dir, depth = 2) => {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return false; }
  for (const e of entries) {
    if (e.isFile() && /^wrangler\.(toml|json|jsonc)$/.test(e.name)) return true;
    if (depth > 0 && e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules'
        && hasDeployTarget(join(dir, e.name), depth - 1)) return true;
  }
  return false;
};

// Each check: test(ctx) → true (pass) | false (fail) | null (not applicable).
export const CHECKS = [
  { key: 'readme',      label: 'README',          group: 'readme',  test: c => !!c.readme },
  { key: 'title',       label: 'Title (H1)',      group: 'readme',  test: c => c.readme && (/^#\s+\S/m.test(c.readme) || /<h1[\s>]/i.test(c.readme)) },
  { key: 'badges',      label: 'Badges',          group: 'readme',  test: c => c.readme && BADGE.test(c.readme) },
  { key: 'screenshot',  label: 'Screenshot',      group: 'readme',  test: c => c.readme && imagesIn(c.readme).some(src => !BADGE.test(src)) },
  { key: 'quickstart',  label: 'Getting started', group: 'readme',  test: c => c.readme && heading(c.readme, /getting started|quick ?start|install|setup|usage/i) },
  { key: 'license-sec', label: 'License section', group: 'readme',  test: c => c.readme && heading(c.readme, /licen[cs]e/i) },
  { key: 'agents',      label: 'AGENTS.md',       group: 'docs',    test: c => existsSync(join(c.path, 'AGENTS.md')) },
  { key: 'claude',      label: 'CLAUDE.md',       group: 'docs',    test: c => existsSync(join(c.path, 'CLAUDE.md')) },
  { key: 'changelog',   label: 'CHANGELOG',       group: 'docs',    test: c => existsSync(join(c.path, 'CHANGELOG.md')) },
  { key: 'description', label: 'Description',     group: 'github',  remote: true, test: c => !!c.meta.description },
  { key: 'topics',      label: '3+ topics',       group: 'github',  remote: true, test: c => c.meta.topics.length >= 3 },
  { key: 'homepage',    label: 'Homepage',        group: 'github',  remote: true, test: c => hasDeployTarget(c.path) ? !!c.meta.homepage : null },
  { key: 'protected',   label: 'Branch protected', group: 'github', remote: true, test: c => c.meta.protected },
  { key: 'ci-green',    label: 'CI green',        group: 'github',  remote: true, test: c => c.meta.workflows ? c.meta.failing.length === 0 : null },
  { key: 'release',     label: 'Release',         group: 'github',  remote: true, test: c => !!c.meta.latestRelease },
  { key: 'security',    label: 'No critical/high alerts', group: 'github', remote: true, test: c => {
    const sev = [c.meta.dependabot, c.meta.codeScanning].filter(Boolean);
    if (!sev.length) return c.meta.dependabot === undefined ? null : true; // older cache without security data
    return sev.every(s => !(s.critical || s.high));
  } },
];

// Evaluate one repo. Status per check: ok | fail | blessed | na | unknown
// (unknown = remote check with no cached metadata).
export function evaluatePresentation(repo, meta = loadMeta()) {
  const path = join(ROOT, repo);
  const readmePath = ['README.md', 'readme.md', 'Readme.md'].map(f => join(path, f)).find(existsSync);
  const ctx = { path, readme: readmePath ? readFileSync(readmePath, 'utf8') : '', meta: meta?.repos?.[repo] };
  if (ctx.meta?.error) ctx.meta = undefined;
  const ignored = ignoredFor(path);

  const checks = CHECKS.map(chk => {
    if (chk.remote && !ctx.meta) return { ...chk, status: 'unknown' };
    const result = chk.test(ctx);
    if (result === null) return { ...chk, status: 'na' };
    if (result) return { ...chk, status: 'ok' };
    return { ...chk, status: ignored.has(`presentation:${chk.key}`) ? 'blessed' : 'fail' };
  });
  const scored = checks.filter(c => ['ok', 'fail', 'blessed'].includes(c.status));
  const have = scored.filter(c => c.status !== 'fail').length;
  const pick = s => checks.filter(c => c.status === s).map(c => c.key);
  return {
    repo, checks, have, total: scored.length,
    score: scored.length ? Math.round((have / scored.length) * 100) : null,
    fail: pick('fail'),
    checked: checks.filter(c => c.status !== 'unknown').map(c => c.key),
  };
}
