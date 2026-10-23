// Flaky-workflow detection for ci-history.mjs — pure over one workflow's runs,
// so it's testable without the GitHub API.
//
// A workflow is flaky when one commit both passed and failed (scheduled runs and
// re-triggers hit the same SHA — no code changed, the result did), or when it
// flipped pass↔fail at least FLIP_LIMIT times since `flipSince`.

export const FLIP_DAYS = 14, FLIP_LIMIT = 3;
// Workflows whose outcome follows settings rather than code (bot updaters,
// publishing, releases) aren't test flakiness — a fixed token re-run on the same
// commit is a fix, not a flake.
export const NOT_TESTS = /dependabot updates|publish|release|deploy|stale|label|drafter/i;

// runs: [{ sha, ok, at }] (any order; `at` is an ISO timestamp). flipSince: ISO string.
export function flakiness(runs, flipSince) {
  const sorted = [...runs].sort((a, b) => a.at.localeCompare(b.at));
  const bySha = new Map();
  for (const r of sorted) (bySha.get(r.sha) ?? bySha.set(r.sha, new Set()).get(r.sha)).add(r.ok);
  const mixedShas = [...bySha.values()].filter(s => s.size === 2).length;
  const recent = sorted.filter(r => r.at >= flipSince);
  const flips = recent.slice(1).filter((r, i) => r.ok !== recent[i].ok).length;
  return { mixedShas, flips };
}

export const isFlaky = (workflowName, { mixedShas, flips }) =>
  !NOT_TESTS.test(workflowName) && (mixedShas > 0 || flips >= FLIP_LIMIT);
