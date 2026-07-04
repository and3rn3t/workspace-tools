# workspace-tools

Meta-workspace tooling for the [and3rn3t](https://github.com/and3rn3t) GitHub
folder — a `Makefile` + zero-dependency Node scripts (`tools/*.mjs`) that keep
~30 sibling repos consistent, discoverable, and easy to scaffold from.

This repo does not contain the sibling projects themselves (those are separate
repos, cloned alongside this one on disk) — it contains the tooling that
audits and bootstraps them.

## Quick reference

| Command | What it does |
|---|---|
| `make doctor` | List each repo's type (node/pnpm, node/npm, python, other), its available scripts, and flag lockfile drift |
| `make status` | Git snapshot per repo: uncommitted file count, ahead/behind vs. upstream |
| `make sync` | Dry-run: show baseline files that are **missing** from any repo |
| `make sync-apply` | Create those missing files (never overwrites existing ones) |
| `make drift` | Report files that **exist but differ** from the canonical template — for manual review |
| `make dashboard` | Regenerate `dashboard.html` — a consistency scorecard across all repos |
| `make new-repo NAME=x TYPE=node\|python` | Scaffold a new sibling repo from the template so it starts 100% consistent |
| `make lint` / `build` / `test` / `typecheck` / `format` / `audit` | Fan the command out across all repos, auto-detecting the package manager |
| `make outdated` | Per-repo snapshot of outdated npm/pnpm deps, highlighting major bumps |

See [`tools/README.md`](tools/README.md) for full documentation: the
non-destructive sync design, managed-files table, `.consistency-ignore`,
reusable GitHub Actions workflows, and more.

## Layout

```
Makefile              # entry point — run `make help` for the full list
tools/*.mjs           # the scripts each make target calls
tools/templates/      # Python-specific baseline file variants
CLAUDE.md             # project index of every sibling repo, for AI assistants
CONSISTENCY-PLAN.md   # design notes: baseline-file consistency strategy
DEPENDENCY-UPGRADE-PLAYBOOK.md
WORKFLOW-OPTIMIZATION.md
```

## Requirements

Node.js only, no dependencies. Assumes this repo is cloned as a sibling
directory alongside the projects it manages (i.e. `tools/`'s parent directory
*is* the GitHub folder being audited).
