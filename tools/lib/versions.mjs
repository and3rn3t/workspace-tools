// Declared major versions of key stack packages per repo, merged across every
// package.json in the repo (root plus nested apps/, frontend/, workers/ …,
// up to 3 levels deep). Used by tools/versions.mjs and the dashboard's Stack column.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './manifest.mjs';

export const KEY_PACKAGES = ['react', 'vite', 'vitest', 'typescript', 'tailwindcss', 'eslint', 'wrangler', '@playwright/test'];

function packageJsons(dir, depth = 3, out = []) {
  if (existsSync(join(dir, 'package.json'))) out.push(join(dir, 'package.json'));
  if (depth === 0) return out;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules' && e.name !== 'dist') packageJsons(join(dir, e.name), depth - 1, out);
  }
  return out;
}

// "^19.2.0" → 19, ">=5.4 <6" → 5, "workspace:*" / "latest" / git URLs → null.
const majorOf = spec => { const m = String(spec).match(/(?:^|[\s^~>=<v])(\d+)(?:\.|$|\s)/); return m ? Number(m[1]) : null; };

// { react: 19, vite: 7, … } — highest declared major per key package; absent keys omitted.
export function repoVersions(repo) {
  const majors = {};
  for (const file of packageJsons(join(ROOT, repo))) {
    let pkg;
    try { pkg = JSON.parse(readFileSync(file, 'utf8')); } catch { continue; }
    const deps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies };
    for (const name of KEY_PACKAGES) {
      const major = deps[name] ? majorOf(deps[name]) : null;
      if (major !== null && (majors[name] === undefined || major > majors[name])) majors[name] = major;
    }
  }
  return majors;
}

// Newest major in use anywhere in the workspace, per key package.
export function workspaceLatest(allVersions) {
  const latest = {};
  for (const majors of Object.values(allVersions)) {
    for (const [name, major] of Object.entries(majors)) if (latest[name] === undefined || major > latest[name]) latest[name] = major;
  }
  return latest;
}

// Key packages where the repo's major trails the workspace's newest.
export const behindOf = (majors, latest) => Object.keys(majors).filter(name => majors[name] < latest[name]);
