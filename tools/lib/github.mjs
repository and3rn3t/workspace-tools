// Shared GitHub API access for the network-using tools (status.mjs, github-meta.mjs).
// Auth resolution: $GH_TOKEN / $GITHUB_TOKEN env var, then `gh auth token`.

import { spawnSync } from 'node:child_process';

export const OWNER = 'and3rn3t';

export function resolveToken() {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  const r = spawnSync('gh', ['auth', 'token'], { encoding: 'utf8' });
  if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  return null;
}

// GET helper. Returns { status, data }; data is null on non-2xx.
export function apiClient(token) {
  return async function api(path) {
    const res = await fetch(`https://api.github.com${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    });
    // 204 (e.g. GET /vulnerability-alerts when enabled) has no body.
    return { status: res.status, data: !res.ok ? null : res.status === 204 ? {} : await res.json() };
  };
}

// GraphQL helper. Throws with GitHub's own message on errors.
export function graphqlClient(token) {
  return async function graphql(query, variables = {}) {
    const res = await fetch('https://api.github.com/graphql', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
    const body = await res.json();
    if (!res.ok || body.errors?.length) throw new Error([...new Set(body.errors?.map(e => e.message))].join('; ') || `HTTP ${res.status}`);
    return body.data;
  };
}

// "owner/name" for a local clone, from its origin URL (falls back to OWNER/<dir>).
export function repoSlug(repoPath, dirName) {
  const r = spawnSync('git', ['-C', repoPath, 'remote', 'get-url', 'origin'], { encoding: 'utf8' });
  const m = r.status === 0 && r.stdout.trim().match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/);
  return m ? `${m[1]}/${m[2]}` : `${OWNER}/${dirName}`;
}
