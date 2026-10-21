#!/usr/bin/env node
// fix-prs.mjs — open one reviewable PR per active repo with its dashboard gaps fixed.
//
//   node tools/fix-prs.mjs                        # dry run: every active repo, exactly what it would get
//   node tools/fix-prs.mjs --repo=guess           # dry run, one repo
//   node tools/fix-prs.mjs --repo=guess --verbose # also print the full CHANGELOG that would be written
//   node tools/fix-prs.mjs --repo=guess --diff    # also print the README as a unified diff
//   node tools/fix-prs.mjs --apply --repo=guess   # push branch chore/workspace-fixes + open the PR
//
// Fixes, one commit each, only where missing:
//   1. baseline files from the manifest (lib/manifest.mjs), honoring .consistency-ignore
//   2. README badge row / "Getting started" / "License" sections (lib/presentation.mjs
//      checks), inserted as skeletons per ai-template-repo/docs/README-STANDARD.md —
//      existing prose is never rewritten
//   3. CHANGELOG.md seeded from the repo's release-drafter draft (Keep a Changelog)
//
// Everything is evaluated against origin/<default branch>, not the local checkout
// (which may be on a PR branch or dirty). --apply works in a temporary detached
// `git worktree`, so the repo's checked-out branch and working tree are never
// touched; the worktree is removed afterwards. A repo with an open PR from
// chore/workspace-fixes (or a leftover remote branch of that name) is skipped.
// Commits skip hooks: a fresh worktree has no node_modules for husky/lint-staged,
// and the messages are conventional by construction — the PR's CI does the checking.

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { MANIFEST, TPL, applies, detectTypes, listRepos, typeLabel, ROOT } from './lib/manifest.mjs';
import { CHECKS, loadMeta } from './lib/presentation.mjs';
import { tierFor } from './lib/activity.mjs';
import { repoSlug } from './lib/github.mjs';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const VERBOSE = args.includes('--verbose');
const DIFF = args.includes('--diff');
const onlyRepo = (args.find(a => a.startsWith('--repo=')) || '').split('=')[1];
const BRANCH = 'chore/workspace-fixes';
const TRAILER = 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>';
const C = { reset: '\x1b[0m', dim: '\x1b[2m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m', red: '\x1b[31m', bold: '\x1b[1m' };

if (APPLY && !onlyRepo) { console.error(`${C.red}--apply needs --repo=<name> (one repo per run)${C.reset}`); process.exit(1); }

const run = (cmd, argv, opts = {}) => spawnSync(cmd, argv, { encoding: 'utf8', maxBuffer: 64 << 20, ...opts });
const git = (repoPath, argv, opts) => run('git', ['-C', repoPath, ...argv], opts);
const ok = r => (r.status === 0 ? r.stdout : null);
const must = (r, what) => { if (r.status !== 0) throw new Error(`${what} failed: ${(r.stderr || r.stdout).trim()}`); return r.stdout; };

// Read-only view of one commit: file list + contents, no checkout needed.
// Lookups ignore case, like existsSync on the macOS checkouts the other tools
// read (so an existing PULL_REQUEST_TEMPLATE.md counts as the manifest's lowercase one).
function treeAt(repoPath, sha) {
  const files = new Set((ok(git(repoPath, ['ls-tree', '-r', '-z', '--name-only', sha])) ?? '').split('\0').filter(Boolean));
  const byLower = new Map([...files].map(f => [f.toLowerCase(), f]));
  const actual = p => byLower.get(p.toLowerCase());
  return { files, has: p => !!actual(p), name: actual, read: p => (actual(p) ? ok(git(repoPath, ['show', `${sha}:${actual(p)}`])) : null) };
}
const ignoreSet = text => new Set((text ?? '').split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('#')));

// ── 1. baseline files ────────────────────────────────────────────────────
// Same rule as evaluate() in lib/manifest.mjs ("missing" = absent and not
// blessed), but against the default branch instead of the local checkout.
function missingBaseline(tree, types, ignored) {
  const seen = new Set();
  return MANIFEST.filter(item => {
    if (!applies(item.types, types) || seen.has(item.dest)) return false;
    seen.add(item.dest);
    return existsSync(item.src) && !tree.has(item.dest) && !ignored.has(item.dest);
  });
}

// ── 2. README ────────────────────────────────────────────────────────────
const MANAGED_WORKFLOWS = new Set(MANIFEST.map(m => m.dest).filter(d => d.startsWith('.github/workflows/')));
const NOT_CI = /deploy|release|publish|pages|notify|snake|update|label|stale|sbom|docs/i;

// The repo's main CI workflow: a non-managed workflow that runs on push / pull_request.
function ciWorkflow(tree) {
  const candidates = [...tree.files]
    .filter(f => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(f) && !MANAGED_WORKFLOWS.has(f))
    .map(f => ({ file: f.split('/').pop(), text: tree.read(f) ?? '' }))
    .filter(w => !NOT_CI.test(w.file) && /^\s*(push|pull_request)\s*:|^on:\s*\[?\s*(push|pull_request)/m.test(w.text))
    .map(w => ({ ...w, rank: /^ci([-.]|$)/i.test(w.file) ? 0 : /quality|test|build|check|lint/i.test(w.file) ? 1 : 2 }));
  candidates.sort((a, b) => a.rank - b.rank || a.file.localeCompare(b.file));
  return candidates[0]?.file ?? null;
}

const licenseName = text => (/^\s*MIT License/i.test(text ?? '') ? 'MIT' : /Apache License/i.test(text ?? '') ? 'Apache-2.0' : null);
const shield = s => s.replace(/-/g, '--').replace(/_/g, '__');

function badgeRow(slug, workflow, license, homepage) {
  const rows = [];
  if (workflow) rows.push(`[![CI](https://github.com/${slug}/actions/workflows/${workflow}/badge.svg)](https://github.com/${slug}/actions/workflows/${workflow})`);
  if (license) rows.push(`[![License: ${license}](https://img.shields.io/badge/License-${shield(license)}-blue.svg)](LICENSE)`);
  if (homepage) rows.push(`[![Live site](https://img.shields.io/badge/live-${shield(homepage.replace(/^https?:\/\//, '').replace(/\/$/, ''))}-brightgreen)](${homepage})`);
  return rows;
}

function gettingStarted(tree, repoPath, slug, types) {
  const name = slug.split('/')[1];
  const clone = [`git clone https://github.com/${slug}.git`, `cd ${name}`];
  const block = (prereq, cmds) => [`Prerequisites: ${prereq}.`, '', '```bash', ...clone, ...cmds, '```'];
  if (types.has('node')) {
    const pm = tree.has('pnpm-lock.yaml') ? 'pnpm' : 'npm';
    let scripts = {};
    try { scripts = JSON.parse(tree.read('package.json')).scripts ?? {}; } catch {}
    const script = ['dev', 'start', 'build', 'test'].find(s => scripts[s]);
    const runCmd = script ? (pm === 'npm' && !['start', 'test'].includes(script) ? `npm run ${script}` : `${pm} ${script}`) : null;
    const node = (tree.read('.nvmrc') ?? readFileSync(join(TPL, '.nvmrc'), 'utf8')).trim().replace(/^v/, '').split('.')[0];
    return block(`Node ${node}+${pm === 'pnpm' ? ', pnpm' : ''}`, [`${pm} install`, ...(runCmd ? [runCmd] : [])]);
  }
  if (types.has('python')) {
    const py = (tree.read('pyproject.toml') ?? '').match(/requires-python\s*=\s*["']>=\s*([\d.]+)/)?.[1];
    const prereq = `Python ${py ?? '3'}+${tree.has('uv.lock') ? ', uv' : ''}`;
    if (tree.has('uv.lock')) return block(prereq, ['uv sync']);
    return block(prereq, ['python3 -m venv .venv', 'source .venv/bin/activate', 'pip install -e .']);
  }
  if (types.has('xcode')) {
    const proj = [...tree.files].map(f => f.match(/^(.*?\.xcodeproj)\//)?.[1]).find(Boolean);
    return block('Xcode', [`open ${proj ?? `${name}.xcodeproj`}`]);
  }
  if (tree.has('Cargo.toml')) return block('Rust (stable)', ['cargo run']);
  return ['<!-- TODO: prerequisites, install and run commands -->', '', '```bash', ...clone, '```'];
}

// Insert sections without touching existing lines. Returns { text, notes }.
function patchReadme(md, { badges, quickstart, license }) {
  const lines = md.replace(/\s+$/, '').split('\n');
  const notes = [];
  const headingAt = re => lines.findIndex(l => /^#{1,4}\s/.test(l) && re.test(l));
  if (quickstart) {
    let at = headingAt(/tech stack/i);
    if (at < 0) at = headingAt(/licen[cs]e/i);
    const anchor = at < 0 ? null : lines[at];
    if (at < 0) lines.push('', '## Getting started', '', ...quickstart);
    else lines.splice(at, 0, '## Getting started', '', ...quickstart, '');
    notes.push(`"Getting started" ${anchor ? `before "${anchor}"` : 'at end'}`);
  }
  if (license) {
    lines.push('', '## License', '', license);
    notes.push('"License" at end');
  }
  if (badges) {
    // After the H1 and its tagline paragraph; for an HTML header, after its block (first blank line).
    const h1 = lines.findIndex(l => /^#\s+\S/.test(l) || /<h1[\s>]/i.test(l));
    let at = 0;
    if (h1 >= 0) {
      at = h1 + 1;
      if (/^#\s/.test(lines[h1])) {
        while (at < lines.length && !lines[at].trim()) at++;
        const prose = l => l.trim() && !/^(#|!\[|\[!\[|<|```|\||>)/.test(l.trim());
        if (prose(lines[at] ?? '')) while (at < lines.length && lines[at].trim()) at++;
        else at = h1 + 1;
      } else {
        while (at < lines.length && lines[at].trim()) at++;
      }
    }
    lines.splice(at, 0, ...(at > 0 ? [''] : []), ...badges, ...(lines[at]?.trim() ? [''] : []));
    notes.unshift(`badge row ${h1 < 0 ? 'at top' : `after line ${at} ("${lines[h1].trim().slice(0, 40)}")`}`);
  }
  return { text: lines.join('\n').replace(/\n{3,}/g, '\n\n') + '\n', notes };
}

// ── 3. CHANGELOG ─────────────────────────────────────────────────────────
const KAC = ['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security'];
const kacType = title => (/secur/i.test(title) ? 'Security' : /fix|bug/i.test(title) ? 'Fixed' : /feature|added|new/i.test(title) ? 'Added' : /remov/i.test(title) ? 'Removed' : /deprecat/i.test(title) ? 'Deprecated' : 'Changed');

function latestDraft(slug) {
  const out = ok(run('gh', ['api', `repos/${slug}/releases?per_page=100`]));
  if (out === null) return { error: 'gh api releases failed' };
  return { draft: JSON.parse(out).find(r => r.draft) ?? null };
}

function changelogFrom(draft) {
  const sections = new Map();
  let cur = 'Changed';
  for (const line of (draft?.body ?? '').split(/\r?\n/)) {
    if (/^---\s*$/.test(line)) break; // release-drafter's warning footer
    const h = line.match(/^#{2,3}\s+(.*)/);
    if (h) { cur = kacType(h[1]); continue; }
    const item = line.match(/^[*-]\s+(.*)/);
    if (!item || /^no changes$/i.test(item[1].trim())) continue;
    if (!sections.has(cur)) sections.set(cur, []);
    sections.get(cur).push(`- ${item[1].trim()}`);
  }
  const body = KAC.filter(k => sections.has(k)).flatMap(k => [`### ${k}`, '', ...sections.get(k), '']);
  const text = [
    '# Changelog', '',
    'All notable changes to this project are documented in this file.', '',
    'The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),',
    'and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).', '',
    '## [Unreleased]', '',
    ...body,
  ].join('\n').replace(/\n+$/, '\n');
  return { text, entries: [...sections.values()].reduce((a, s) => a + s.length, 0) };
}

// ── plan one repo ────────────────────────────────────────────────────────
function planRepo(repo, meta) {
  const repoPath = join(ROOT, repo);
  const slug = repoSlug(repoPath, repo);
  const defaultRef = ok(git(repoPath, ['rev-parse', '--abbrev-ref', 'origin/HEAD']))?.trim() ?? 'origin/main';
  const sha = ok(git(repoPath, ['rev-parse', defaultRef]))?.trim();
  if (!sha) return { repo, slug, skip: `cannot resolve ${defaultRef}` };
  const base = { repo, repoPath, slug, defaultRef, defaultBranch: defaultRef.replace(/^origin\//, ''), sha };

  const openPr = ok(run('gh', ['pr', 'list', '--repo', slug, '--head', BRANCH, '--state', 'open', '--json', 'url', '--jq', '.[0].url']))?.trim();
  if (openPr) return { ...base, skip: `open PR already: ${openPr}` };
  if (ok(git(repoPath, ['ls-remote', '--heads', 'origin', BRANCH]))?.trim()) return { ...base, skip: `remote branch ${BRANCH} exists without an open PR — delete it first` };

  const tree = treeAt(repoPath, sha);
  const types = detectTypes(repoPath);
  const ignored = ignoreSet(tree.read('.consistency-ignore'));
  const readmeFile = tree.name('README.md');
  const ctx = { path: repoPath, readme: readmeFile ? tree.read(readmeFile) : '', meta: undefined };
  const failing = key => !ignored.has(`presentation:${key}`) && !CHECKS.find(c => c.key === key).test(ctx);

  const baseline = missingBaseline(tree, types, ignored);
  const fixes = { ...base, types, baseline, notes: [] };

  if (!readmeFile) fixes.notes.push('no README — README fixes skipped');
  else {
    const licenseText = tree.read('LICENSE') ?? (baseline.some(b => b.dest === 'LICENSE') ? readFileSync(join(TPL, 'LICENSE'), 'utf8') : null);
    const license = licenseName(licenseText);
    const want = {};
    if (failing('badges')) {
      const workflow = ciWorkflow(tree);
      const homepage = meta?.repos?.[repo]?.homepage || '';
      want.badges = badgeRow(slug, workflow, license, homepage);
      if (!want.badges.length) { delete want.badges; fixes.notes.push('badges: no CI workflow or recognized license — skipped'); }
      else if (!workflow) fixes.notes.push('badges: no push/PR CI workflow found — no CI badge');
    }
    if (failing('quickstart')) want.quickstart = gettingStarted(tree, repoPath, slug, types);
    if (failing('license-sec')) want.license = license ? `[${license}](LICENSE)` : licenseText ? 'See [LICENSE](LICENSE).' : null;
    if (want.license === null) { delete want.license; fixes.notes.push('license section: repo has no LICENSE — skipped'); }
    if (Object.keys(want).length) {
      const { text, notes } = patchReadme(ctx.readme, want);
      fixes.readme = { file: readmeFile, text, want, notes };
    }
  }

  if (!tree.has('CHANGELOG.md') && !ignored.has('presentation:changelog')) {
    const { draft, error } = latestDraft(slug);
    if (error) fixes.notes.push(`CHANGELOG: ${error} — skipped`);
    else fixes.changelog = { draft, ...changelogFrom(draft) };
  }
  return fixes;
}

const hasWork = f => f.baseline?.length || f.readme || f.changelog;
const readmeSummary = want => [want.badges && 'badge row', want.quickstart && 'Getting started', want.license && 'License'].filter(Boolean);
const changelogSource = cl => (cl.draft
  ? `Unreleased seeded from the release-drafter draft ${cl.draft.tag_name || cl.draft.name || cl.draft.id} (${cl.entries} entr${cl.entries === 1 ? 'y' : 'ies'})`
  : 'empty Unreleased section (no release-drafter draft)');

function printPlan(f) {
  const ind = s => `      ${C.dim}${s}${C.reset}`;
  console.log(`${C.cyan}${f.repo}${C.reset} ${C.dim}[${typeLabel(f.repoPath, f.types)}] ${f.defaultRef} @ ${f.sha.slice(0, 7)}${C.reset}`);
  if (f.baseline.length) {
    console.log(`  ${C.green}chore: add missing baseline files${C.reset}`);
    f.baseline.forEach(b => console.log(`    + ${b.dest}${b.exec ? ' (exec)' : ''}`));
  }
  if (f.readme) {
    console.log(`  ${C.green}docs: README — ${readmeSummary(f.readme.want).join(', ')}${C.reset} ${C.dim}(${f.readme.file})${C.reset}`);
    f.readme.notes.forEach(n => console.log(`    ${n}`));
    if (f.readme.want.badges) f.readme.want.badges.forEach(b => console.log(ind(b)));
    if (f.readme.want.quickstart) ['## Getting started', '', ...f.readme.want.quickstart].forEach(l => console.log(ind(l)));
    if (f.readme.want.license) ['## License', '', f.readme.want.license].forEach(l => console.log(ind(l)));
    if (DIFF) {
      const dir = mkdtempSync(join(tmpdir(), 'fix-prs-diff-'));
      writeFileSync(join(dir, 'a'), git(f.repoPath, ['show', `${f.sha}:${f.readme.file}`]).stdout);
      writeFileSync(join(dir, 'b'), f.readme.text);
      console.log(run('git', ['diff', '--no-index', '--color', 'a', 'b'], { cwd: dir }).stdout);
      rmSync(dir, { recursive: true, force: true });
    }
  }
  if (f.changelog) {
    console.log(`  ${C.green}docs: add CHANGELOG.md${C.reset} ${C.dim}— ${changelogSource(f.changelog)}${C.reset}`);
    if (VERBOSE) f.changelog.text.split('\n').forEach(l => console.log(ind(l)));
  }
  f.notes.forEach(n => console.log(`  ${C.yellow}note${C.reset} ${n}`));
}

// ── apply ────────────────────────────────────────────────────────────────
function prBody(f) {
  const lines = ['Automated workspace fixes from `tools/fix-prs.mjs` (workspace-tools), one commit each:', ''];
  if (f.baseline.length) {
    lines.push('- [ ] **Baseline files** — `chore: add missing baseline files`');
    f.baseline.forEach(b => lines.push(`  - [ ] \`${b.dest}\``));
  }
  if (f.readme) {
    lines.push(`- [ ] **README** — added ${readmeSummary(f.readme.want).join(', ')} (skeletons per ai-template-repo/docs/README-STANDARD.md; existing text untouched)`);
    if (f.readme.want.quickstart) lines.push('  - [ ] check the inferred Getting started commands');
  }
  if (f.changelog) lines.push(`- [ ] **CHANGELOG.md** — Keep a Changelog, ${changelogSource(f.changelog)}`);
  if (f.notes.length) lines.push('', 'Not changed:', ...f.notes.map(n => `- ${n}`));
  lines.push('', '🤖 Generated with [Claude Code](https://claude.com/claude-code)');
  return lines.join('\n') + '\n';
}

function applyRepo(f) {
  const before = ['--abbrev-ref HEAD', 'HEAD'].map(a => ok(git(f.repoPath, ['rev-parse', ...a.split(' ')]))?.trim());
  const wt = mkdtempSync(join(tmpdir(), `fix-prs-${f.repo}-`));
  must(git(f.repoPath, ['worktree', 'add', '--detach', '--quiet', wt, f.sha]), 'git worktree add');
  const commit = (paths, subject, body = '') => {
    must(git(wt, ['add', '--', ...paths]), 'git add');
    must(git(wt, ['commit', '--no-verify', '--quiet', '-F', '-'], { input: `${subject}\n\n${body ? `${body}\n\n` : ''}${TRAILER}\n` }), 'git commit');
    console.log(`  ${C.green}committed${C.reset} ${subject}`);
  };
  try {
    if (f.baseline.length) {
      for (const item of f.baseline) {
        const dest = join(wt, item.dest);
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, readFileSync(item.src));
        if (item.exec) chmodSync(dest, 0o755);
      }
      commit(f.baseline.map(b => b.dest), 'chore: add missing baseline files', `From the workspace manifest (tools/lib/manifest.mjs):\n${f.baseline.map(b => `- ${b.dest}`).join('\n')}`);
    }
    if (f.readme) {
      writeFileSync(join(wt, f.readme.file), f.readme.text);
      const what = readmeSummary(f.readme.want).map(w => (w === 'badge row' ? w : `${w} section`));
      commit([f.readme.file], `docs: add README ${what.join(', ').replace(/, ([^,]*)$/, ' and $1')}`,
        'Skeleton sections per ai-template-repo/docs/README-STANDARD.md; existing text is unchanged.');
    }
    if (f.changelog) {
      writeFileSync(join(wt, 'CHANGELOG.md'), f.changelog.text);
      commit(['CHANGELOG.md'], 'docs: add CHANGELOG', `Keep a Changelog format; ${changelogSource(f.changelog)}.`);
    }
    must(git(wt, ['push', '--no-verify', '--quiet', 'origin', `HEAD:refs/heads/${BRANCH}`]), 'git push');
    const url = must(run('gh', ['pr', 'create', '--repo', f.slug, '--base', f.defaultBranch, '--head', BRANCH, '--title', 'chore: workspace baseline fixes', '--body-file', '-'], { input: prBody(f) }), 'gh pr create').trim();
    console.log(`  ${C.bold}PR${C.reset} ${url}`);
  } finally {
    git(f.repoPath, ['worktree', 'remove', '--force', wt]);
    git(f.repoPath, ['worktree', 'prune']);
    const after = ['--abbrev-ref HEAD', 'HEAD'].map(a => ok(git(f.repoPath, ['rev-parse', ...a.split(' ')]))?.trim());
    const same = before.every((v, i) => v === after[i]);
    console.log(`  ${same ? C.dim : C.red}local checkout ${same ? 'unchanged' : 'CHANGED'}: ${after[0]} @ ${after[1]?.slice(0, 7)}${C.reset}`);
  }
}

// ── main ─────────────────────────────────────────────────────────────────
const meta = loadMeta();
const repos = listRepos(onlyRepo);
if (onlyRepo && !repos.length) { console.error(`${C.red}no repo named ${onlyRepo}${C.reset}`); process.exit(1); }
const active = repos.filter(r => tierFor(r) === 'active' && !meta?.repos?.[r]?.archived);
if (onlyRepo && !active.length) { console.error(`${C.red}${onlyRepo} is not an active repo — fix-prs only targets active repos${C.reset}`); process.exit(1); }

let todo = 0;
for (const repo of active) {
  git(join(ROOT, repo), ['fetch', '--quiet', 'origin']);
  const f = planRepo(repo, meta);
  if (f.skip) { console.log(`${C.cyan}${repo}${C.reset} ${C.yellow}skip${C.reset} ${f.skip}`); continue; }
  if (!hasWork(f)) { if (VERBOSE || onlyRepo) console.log(`${C.cyan}${repo}${C.reset} ${C.dim}nothing to fix${C.reset}`); continue; }
  todo++;
  printPlan(f);
  if (APPLY) applyRepo(f);
}
console.log(`\n${APPLY ? 'opened' : 'would open'}: ${todo} PR(s) across ${active.length} active repo(s)${!APPLY && todo ? ` ${C.dim}(apply one at a time: --apply --repo=<name>)${C.reset}` : ''}`);
