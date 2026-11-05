#!/usr/bin/env node
// history-commit.mjs — commit the tracked dashboard history rows that `make export`
// writes (workspace-history.json, workspace-history-repos.json) as one
// `chore(history): …` commit naming the days added. It commits only those two
// paths (`git commit --only`), so anything else staged stays staged. Never pushes.
//
//   node tools/history-commit.mjs            # commit
//   node tools/history-commit.mjs --dry-run  # print the message, commit nothing

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './lib/manifest.mjs';

const FILES = ['workspace-history.json', 'workspace-history-repos.json'];
const dryRun = process.argv.includes('--dry-run');
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const changed = git('status', '--porcelain', '--', ...FILES).trim();
if (!changed) {
  console.log('history: nothing to commit');
  process.exit(0);
}

const datesOf = text => { try { return new Set(JSON.parse(text).map(r => r.date)); } catch { return new Set(); } };
const committed = file => { try { return git('show', `HEAD:${file}`); } catch { return '[]'; } };
const newDates = new Set();
for (const file of FILES) {
  const before = datesOf(committed(file));
  for (const date of datesOf(readFileSync(join(ROOT, file), 'utf8'))) if (!before.has(date)) newDates.add(date);
}

// New days name the commit; a re-export of an already-committed day only refreshes it.
const days = [...newDates].sort();
const span = days.length > 2 ? `${days[0]}..${days.at(-1)} (${days.length} days)` : days.join(', ');
const message = days.length ? `chore(history): dashboard rows for ${span}` : 'chore(history): refresh dashboard rows';

if (dryRun) {
  console.log(message);
  process.exit(0);
}
git('commit', '--only', '-m', message, '--', ...FILES);
console.log(`history: committed "${message}"`);
