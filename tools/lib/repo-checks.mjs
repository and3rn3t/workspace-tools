// Shared by the tools that change a repo in a temporary worktree and open a PR
// (campaign.mjs, security-fix.mjs): process helpers, package-manager detection
// and the repo's own checks.

import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT } from './manifest.mjs';

const C = { reset: '\x1b[0m', dim: '\x1b[2m', green: '\x1b[32m', red: '\x1b[31m' };

export const run = (cmd, argv, opts = {}) => spawnSync(cmd, argv, { encoding: 'utf8', maxBuffer: 256 << 20, ...opts });
export const git = (repoPath, argv, opts) => run('git', ['-C', repoPath, ...argv], opts);
export const ok = r => (r.status === 0 ? r.stdout : null);
export const must = (r, what) => { if (r.status !== 0) throw new Error(`${what} failed: ${(r.stderr || r.stdout || r.error?.message || '').trim()}`); return r.stdout; };
export const stripAnsi = s => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');

// A fresh folder for a temporary worktree, under <root>/.worktrees (gitignored).
// Not the system temp dir: pnpm walks up looking for pnpm-workspace.yaml and
// will adopt a stray one sitting in $TMPDIR, with its settings.
export function worktreeDir(prefix) {
  mkdirSync(join(ROOT, '.worktrees'), { recursive: true });
  return mkdtempSync(join(ROOT, '.worktrees', `${prefix}-`));
}

export const pmFor = wt => (existsSync(join(wt, 'pnpm-lock.yaml')) ? 'pnpm' : 'npm');

export function defaultRef(repoPath) {
  const ref = ok(git(repoPath, ['rev-parse', '--abbrev-ref', 'origin/HEAD']))?.trim() || 'origin/main';
  return { ref, branch: ref.replace(/^origin\//, '') };
}

// The repo's own checks: lint, type-check, then tests (run mode, not watch).
export function runChecks(wt) {
  const pm = pmFor(wt);
  const scripts = JSON.parse(readFileSync(join(wt, 'package.json'), 'utf8')).scripts ?? {};
  const pick = (...names) => names.find(n => scripts[n]);
  const plan = [['lint', pick('lint')], ['type-check', pick('type-check', 'typecheck')], ['test', pick('test:run', 'test:unit', 'test')]];
  const results = [];
  for (const [label, script] of plan) {
    if (!script) { results.push({ label, script: null, ok: true, skipped: true }); continue; }
    process.stdout.write(`  ${C.dim}${pm} run ${script}${C.reset} … `);
    const started = Date.now();
    const extra = script === 'test' && /^vitest(\s|$)/.test(scripts.test) && !/\brun\b/.test(scripts.test) ? ['--', '--run'] : [];
    const r = run(pm, ['run', script, ...extra], { cwd: wt, env: { ...process.env, CI: '1', FORCE_COLOR: '0' }, timeout: 20 * 60_000 });
    const output = stripAnsi(`${r.stdout}\n${r.stderr}`);
    const summary = output.split('\n').filter(l => /^\s*(Test Files|Tests)\s+\d/.test(l)).map(l => l.trim()).join(' · ');
    const res = { label, script, ok: r.status === 0, seconds: Math.round((Date.now() - started) / 1000), summary, output };
    console.log(res.ok ? `${C.green}pass${C.reset} ${C.dim}${res.seconds}s ${summary}${C.reset}` : `${C.red}FAIL${C.reset}`);
    results.push(res);
  }
  return results;
}

// Prints the interesting lines of each failed check.
export function printFailures(failed) {
  for (const f of failed) {
    const tail = f.output.split('\n').filter(l => /FAIL|Error|error|✗|×|failed|ERR!/.test(l)).slice(0, 40);
    console.log(`\n${C.red}── ${f.script} failed ──${C.reset}\n${(tail.length ? tail : f.output.split('\n').slice(-40)).join('\n')}`);
  }
}
