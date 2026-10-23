// Fixture repos for the tools tests: throwaway folders in the OS temp dir.
// The libs resolve repos as join(ROOT, name), so tests address a fixture by its
// path relative to ROOT — no real sibling repo is ever read.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, relative } from 'node:path';
import { ROOT } from '../../lib/manifest.mjs';

const made = [];

// files: { 'path/in/repo': 'contents' }. Returns { path, name } — `name` is what
// evaluate()/scoreRepo()/evaluatePresentation() take.
export function fixtureRepo(files = {}) {
  const path = mkdtempSync(join(tmpdir(), 'tools-test-'));
  made.push(path);
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(path, file)), { recursive: true });
    writeFileSync(join(path, file), content);
  }
  return { path, name: relative(ROOT, path) };
}

export function cleanupFixtures() {
  for (const p of made.splice(0)) rmSync(p, { recursive: true, force: true });
}
