---
name: workspace
description: Cross-repo questions and chores for Matt's GitHub.nosync workspace — CI status, drift and missing baseline files, dependency/bot PRs, security alerts, releases, stack versions, shared-config adoption, the hosted dashboard. Use when a request spans repos ("is anything red", "what needs attention", "merge the green Renovate PRs", "which repos are behind on vite", "cut releases") or mentions make doctor/status/sync/drift/plan/export/watchdog.
---

# Workspace tooling

All cross-repo work goes through the root `Makefile` in
`/Users/andernet/Documents/GitHub.nosync` (sources in `tools/`, full reference in
`tools/README.md`). Scope any target to one repo with `REPO=<name>`.

## Intent → command

| Request | Run | Notes |
|---|---|---|
| "What needs attention?" / morning check | `make report-quick` (local only) or `make report` | `report` hits the GitHub API |
| "Did anything get worse?" | `make watchdog` | prints only regressions, or "quiet" |
| Is CI red anywhere | `make meta` then `make report` | failing workflows per default branch |
| Missing baseline files / drift | `make sync`, `make drift`, `make changes` | `make changes` re-snapshots — run it once |
| Repo settings vs `workspace.json` | `make plan` | `make apply` changes GitHub — ask first |
| Bot dependency PRs | `make merge-green` (dry run) | `merge-green-apply` merges — ask first |
| Security alerts | `make security-fix` | `security-fix-apply REPO=x` opens a PR — ask first |
| Releases | `make release-train` | `-prepare` / `-apply` open PRs / publish — ask first |
| Stack majors, shared eslint/prettier/tsconfig adoption, pnpm pins | `make versions` | |
| Lint/type-check/test everything | `make health` (or `make lint REPO=x`) | |
| Local git state across repos | `make status`, `make git-doctor` | |
| Live sites | `make sites` | |
| Refresh hosted dashboard data | `make export`, then `make history-commit` | dashboard: https://claude.ai/artifact/ExtjNb6AHaPEwEr73uTTkB |
| New repo | `make new-repo` | never plain `git init` |
| Tooling's own tests | `make test-tools` | run after editing anything in `tools/` |

## Rules

- Dry-run targets are safe to run unprompted. Every `-apply` target, `make apply`,
  and anything that commits, pushes, merges, releases or deploys needs the user's
  go-ahead first.
- Repo settings, summaries and tiers live in `workspace.json`. The root
  `CLAUDE.md` project index is generated from it, so edit `workspace.json`, not the index.
- `posture` and `reddit` are archived on purpose; ignore their "ahead" counts.
- Security alert counts never go into tracked files (workspace-tools is public).
- When editing `tools/`, the manifest of managed files lives in
  `tools/lib/manifest.mjs`. Add tests under `tools/test/`, and update the
  `tools/README.md` table plus the `make help` line.
