// Advisory ranges vs lockfiles — enough semver to tell whether a lockfile still
// resolves a vulnerable version of a package. Ranges are GitHub's
// `vulnerable_version_range` form: comma-separated comparators, all of which
// must hold (">= 0.9.0, < 0.9.12", "< 3.1.6", "= 1.2.3"). Pre-release tags are
// ignored (1.2.3-beta compares as 1.2.3).

const parse = v => String(v).replace(/^[v=\s]+/, '').split(/[-+]/)[0].split('.').map(n => Number(n) || 0);

export function compare(a, b) {
  const x = parse(a), y = parse(b);
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0) ? -1 : 1;
  return 0;
}

export function inRange(version, range) {
  return range.split(',').map(s => s.trim()).filter(Boolean).every(part => {
    const [, op = '=', v] = part.match(/^(>=|<=|>|<|=)?\s*(.+)$/) ?? [];
    const c = compare(version, v);
    return { '>=': c >= 0, '<=': c <= 0, '>': c > 0, '<': c < 0, '=': c === 0 }[op];
  });
}

// name → Set of resolved versions, from package-lock.json (v2/v3) or pnpm-lock.yaml (v6–v9) text.
export function lockfileVersions(text, kind) {
  const out = new Map();
  const add = (name, version) => { if (!out.has(name)) out.set(name, new Set()); out.get(name).add(version); };
  if (kind === 'npm') {
    for (const [path, entry] of Object.entries(JSON.parse(text).packages ?? {})) {
      const name = path.match(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)$/)?.[1]; // '' is the root project
      if (name && entry.version && !entry.link) add(name, entry.version);
    }
    return out;
  }
  // pnpm: package keys are two-space indented: `/name@1.2.3:` (v6), `name@1.2.3:` or `'@scope/name@1.2.3(peer@1)':` (v9).
  for (const [, name, version] of text.matchAll(/^ {2}'?\/?((?:@[^/@'\s]+\/)?[^@'\s:/]+)@(\d[^('\s:]*)/gm)) add(name, version);
  return out;
}

// Versions of `name` in the lockfile that `range` still matches.
export const stillVulnerable = (versions, name, range) => [...(versions.get(name) ?? [])].filter(v => inRange(v, range));
