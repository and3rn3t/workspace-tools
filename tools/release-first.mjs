#!/usr/bin/env node
// release-first.mjs — publish a repo's first release from its release-drafter draft.
//
//   node tools/release-first.mjs --repo=guess          # dry run: show the latest draft (tag, name, body excerpt)
//   node tools/release-first.mjs --repo=guess --apply  # publish it as v0.1.0
//
// Publishing is public, so this is always one repo per run, and --apply refuses
// a repo that already has a published release (later releases go through the
// normal release-drafter flow). The draft is published in place by id (PATCH
// /releases/<id>: draft=false, tag_name=name=v0.1.0) — `gh release edit` only
// addresses releases by tag, and drafts often carry a placeholder tag.
// release-drafter's "no previous published release" warning footer (everything
// from the first `---` line) is dropped from the published body.

import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, listRepos } from './lib/manifest.mjs';
import { repoSlug } from './lib/github.mjs';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const repo = (args.find(a => a.startsWith('--repo=')) || '').split('=')[1];
const TAG = 'v0.1.0';
const EXCERPT_LINES = 15;
const C = { reset: '\x1b[0m', dim: '\x1b[2m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m', red: '\x1b[31m', bold: '\x1b[1m' };

const fail = msg => { console.error(`${C.red}${msg}${C.reset}`); process.exit(1); };
if (!repo) fail('--repo=<name> is required (one repo per run)');
if (!listRepos(repo).length) fail(`no repo named ${repo}`);

const gh = argv => spawnSync('gh', argv, { encoding: 'utf8', maxBuffer: 64 << 20 });
const slug = repoSlug(join(ROOT, repo), repo);
const res = gh(['api', `repos/${slug}/releases?per_page=100`]);
if (res.status !== 0) fail(`gh api releases failed: ${res.stderr.trim()}`);
const releases = JSON.parse(res.stdout);
const published = releases.filter(r => !r.draft);
const draft = releases.find(r => r.draft);

console.log(`${C.cyan}${slug}${C.reset}`);
if (published.length) console.log(`  published: ${published[0].tag_name} ${C.dim}(${published.length} release(s); latest ${published[0].published_at?.slice(0, 10)})${C.reset}`);
else console.log(`  published: ${C.dim}none${C.reset}`);
if (!draft) fail('  no release-drafter draft found — merge a PR so release-drafter creates one');

const cut = (draft.body ?? '').split(/\r?\n/).findIndex(l => /^---\s*$/.test(l));
const body = (draft.body ?? '').split(/\r?\n/).slice(0, cut < 0 ? undefined : cut);
while (body.length && !body.at(-1).trim()) body.pop();
console.log(`  draft:     id ${draft.id} · tag ${draft.tag_name || '(none)'} · name ${draft.name || '(none)'} · target ${draft.target_commitish}`);
console.log(`  ${C.dim}── body as published (${body.length} lines${cut < 0 ? '' : ', warning footer dropped'}) ──${C.reset}`);
body.slice(0, EXCERPT_LINES).forEach(l => console.log(`  ${C.dim}│${C.reset} ${l}`));
if (body.length > EXCERPT_LINES) console.log(`  ${C.dim}│ … ${body.length - EXCERPT_LINES} more line(s)${C.reset}`);

if (published.length) fail(`\n${repo} already has a published release — release-first only publishes a repo's first one`);
if (!APPLY) { console.log(`\nwould publish draft ${draft.id} as ${C.bold}${TAG}${C.reset} ${C.dim}(re-run with --apply)${C.reset}`); process.exit(0); }

const edit = gh(['api', '-X', 'PATCH', `repos/${slug}/releases/${draft.id}`, '-F', 'draft=false', '-f', `tag_name=${TAG}`, '-f', `name=${TAG}`, '-f', `body=${body.join('\n')}\n`]);
if (edit.status !== 0) fail(`publishing failed: ${edit.stderr.trim()}`);
console.log(`\n${C.green}published${C.reset} ${JSON.parse(edit.stdout).html_url}`);
