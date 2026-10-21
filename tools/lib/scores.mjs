// Consistency scoring shared by dashboard.mjs (local HTML) and export.mjs (hosted
// dashboard), so both always show the same numbers.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { evaluate } from './manifest.mjs';

// Manifest files grouped into display columns (first matching rule wins).
export const GROUPS = [
  { key: 'baseline',  label: 'Baseline',   match: d => ['.editorconfig', 'SECURITY.md', 'LICENSE', '.gitignore', '.nvmrc', 'renovate.json'].includes(d) },
  { key: 'hooks',     label: 'Hooks',      match: d => ['commitlint.config.mjs', '.lintstagedrc.json', '.husky/commit-msg', '.pre-commit-config.yaml'].includes(d) },
  { key: 'community', label: 'Community',  match: d => /^(CODE_OF_CONDUCT|CONTRIBUTING)\.md$|ISSUE_TEMPLATE|pull_request_template|CODEOWNERS/.test(d) },
  { key: 'guards',    label: 'Guards',     match: d => /workflows\/(codeql|gitleaks|consistency|actionlint|dependency-review)\.yml$/.test(d) },
  { key: 'automation',label: 'Automation', match: () => true },
];
const groupOf = d => GROUPS.find(g => g.match(d)).key;

// Checks outside the manifest that still count toward the score.
const hasCI = p => { try { return readdirSync(join(p, '.github', 'workflows')).some(f => /\.ya?ml$/.test(f)); } catch { return false; } };
// One dependency bot per repo: Renovate enabled AND Dependabot version updates
// configured means duplicate PRs. (hack/weather-app deliberately run Dependabot
// with Renovate disabled — that's fine.)
const renovateOn = p => { try { return JSON.parse(readFileSync(join(p, 'renovate.json'), 'utf8')).enabled !== false; } catch { return false; } };
const dependabotUpdates = p => { try { return /package-ecosystem/.test(readFileSync(join(p, '.github', 'dependabot.yml'), 'utf8')); } catch { return false; } };
export const EXTRA = [
  { key: 'ci',     label: 'CI',     test: p => hasCI(p) },
  { key: 'agents', label: 'AGENTS', test: p => existsSync(join(p, 'AGENTS.md')) },
  { key: 'onebot', label: '1 bot',  test: p => !(renovateOn(p) && dependabotUpdates(p)) },
];

const PRESENT = new Set(['ok', 'drift', 'vary', 'blessed']);

// Per-repo consistency: manifest files present per group + the EXTRA checks.
export function scoreRepo(name) {
  const ev = evaluate(name);
  const groups = Object.fromEntries(GROUPS.map(g => [g.key, { have: 0, total: 0, missing: [] }]));
  for (const { item, status } of ev.items) {
    if (status === 'miss-src') continue;
    const g = groups[groupOf(item.dest)];
    g.total++;
    if (PRESENT.has(status)) g.have++; else g.missing.push(item.dest);
  }
  const extras = EXTRA.map(x => x.test(ev.repoPath));
  const have = Object.values(groups).reduce((a, g) => a + g.have, 0) + extras.filter(Boolean).length;
  const total = Object.values(groups).reduce((a, g) => a + g.total, 0) + extras.length;
  return { ev, groups, extras, have, total, score: total ? Math.round((have / total) * 100) : null };
}
