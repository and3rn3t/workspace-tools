# workspace-tools

Meta-workspace tooling for the [and3rn3t](https://github.com/and3rn3t) GitHub
folder — a `Makefile` + zero-dependency Node scripts (`tools/*.mjs`) that keep
~30 sibling repos consistent, discoverable, and easy to scaffold from.

This repo does not contain the sibling projects themselves (those are separate
repos, cloned alongside this one on disk) — it contains the tooling that
audits and bootstraps them.

## Quick reference

Run `make help` for the full list. The everyday ones:

| Goal | Command |
|---|---|
| What needs attention? | `make report` (or `make report-quick`, no GitHub API) |
| What got worse since last run? | `make watchdog` |
| Missing / drifted baseline files | `make sync` · `make drift` · `make changes` (apply with `make sync-apply`) |
| Repo settings vs `workspace.json` | `make plan` (then `make apply`) |
| Bot PRs, security alerts, releases | `make merge-green` · `make security-fix` · `make release-train` |
| Stack versions & shared-config adoption | `make versions` · `make outdated` |
| Fan a command across all repos | `make lint\|build\|test\|typecheck\|format\|audit\|health` |
| Dashboards | `make dashboard` (local `dashboard.html`) · `make export` (hosted) |
| New repo | `make new-repo NAME=x TYPE=node\|python` |
| This tooling's own tests | `make test-tools` |

Every `*-apply` target changes something (files, GitHub, PRs); the bare target is
always a dry run. Scope any target with `REPO=name`.

## Documentation

- [`tools/README.md`](tools/README.md) — canonical reference for every target and design decision
- [`docs/README.md`](docs/README.md) — index of guides, runbooks, snapshots and history
- [`CLAUDE.md`](CLAUDE.md) — generated repo map for AI assistants; `workspace.json` is its source

## Layout

```
Makefile              # entry point (`make help`)
workspace.json        # source of truth: repo tiers, summaries, settings
tools/*.mjs           # scripts behind each make target
tools/lib/            # shared manifest, helpers
tools/test/           # node --test suite (`make test-tools`)
tools/templates/      # Python baseline variants
docs/                 # guides, runbooks, snapshots, history
.claude/skills/       # `workspace` skill for Claude
```

## Requirements

Node.js only, no dependencies. Assumes this repo is cloned as a sibling
directory alongside the projects it manages (i.e. `tools/`'s parent directory
*is* the GitHub folder being audited).
