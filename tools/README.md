# Meta-workspace tools

Consistency + orchestration for every repo in this GitHub folder. Run everything
from the folder root via the top-level `Makefile`.

## Quick reference

| Command | What it does |
|---|---|
| `make doctor` | List each repo's type (node/pnpm, node/npm, python, other), its available scripts, and flag lockfile drift (both `pnpm-lock.yaml` and `package-lock.json` present) |
| `make status` | Git snapshot per repo: uncommitted file count, ahead/behind vs. upstream |
| `make sync` | Dry-run: show baseline files that are **missing** from any repo |
| `make sync-apply` | Create those missing files (never overwrites existing ones) |
| `make drift` | Report files that **exist but differ** from `ai-template-repo` — for manual review |
| `make dashboard` | Regenerate `dashboard.html` — a consistency scorecard across all repos (coverage %, per-repo checks, drift, last commit) |
| `make new-repo NAME=x TYPE=node\|python` | Scaffold a new sibling repo from the template so it starts 100% consistent |
| `make lint` / `build` / `test` / `typecheck` / `format` / `audit` | Fan the command out across all repos, auto-detecting the package manager |
| `make outdated` | Per-repo snapshot of outdated npm/pnpm deps, highlighting major bumps (needs installed deps; Python not included) |

## Automation

- **`dashboard.html`** — open it in a browser for an at-a-glance scorecard. Regenerate with `make dashboard`. Self-contained, no server.
- **Weekly drift check** — a scheduled task (`weekly-repo-drift`, Mondays) runs `make sync` + `make drift` + `make dashboard` and reports newly-missing files, drift, and repos without CI. It recommends `make sync-apply` but never applies changes automatically.
- **New repos start consistent** — always create them with `make new-repo` instead of `git init` from scratch, so they never need backfilling. As of this tooling update, `make new-repo` also drops in `.github/workflows/ci.yml` (from the node/python CI template) and `.github/workflows/consistency.yml`, so a brand-new repo has working CI and the drift guard from its first commit — no manual step required.
- **New repos are auto-discovered** — every `make` target (`doctor`, `status`, `sync`, `drift`, `dashboard`, plus `lint`/`build`/`test`/etc.) lists repos by scanning the folder at run time; there's no registry file to update. The moment a new top-level directory exists here, it's included in the next run and in the Monday scheduled checks. The one thing that stays manual: adding a row to the root `CLAUDE.md` project index, and creating the actual GitHub remote (`new-repo.mjs` only does local scaffolding + `git init`, no `gh repo create`/push) — plus confirming the Renovate GitHub App is scoped to include the new repo if it isn't installed org-wide.

Scope any target to one repo with `REPO=name`, e.g. `make lint REPO=guess` or
`make sync REPO=posture`.

## Design principle: non-destructive

`sync-configs.mjs` **only ever creates missing files**. It never overwrites a
file a repo already has, because several repos legitimately carry richer or
stricter variants that must not be clobbered (e.g. `health`'s project-specific
`SECURITY.md`, its stricter `commitlint` with a `type-enum`, and its detailed
`.editorconfig`; `guess`'s own commitlint). To surface divergence without
touching anything, use `make drift` and reconcile by hand where it matters.

### Source of truth

Shared and Node baseline files come from **`ai-template-repo/`**. Python variants
(a slimmer `renovate.json` and the `conventional-pre-commit` config) live in
`tools/templates/python/`. Update those sources, then `make sync-apply` to
propagate to repos that are missing them.

### Managed files

| File | Applies to | Notes |
|---|---|---|
| `.editorconfig` | all | drift-tracked |
| `SECURITY.md`, `LICENSE`, `.gitignore` | all | per-repo variants expected |
| `.nvmrc` (24.13.0) | node | drift-tracked |
| `commitlint.config.mjs`, `.lintstagedrc.json`, `.husky/commit-msg` | node | hook is drift-tracked |
| `renovate.json` | node / python | per-repo variants expected (e.g. `guess`) |
| `.pre-commit-config.yaml` | python | drift-tracked |
| `.github/workflows/consistency.yml` | all (incl. Xcode) | drift-tracked — this is the PR-time guard itself |
| `.github/workflows/gitleaks.yml` | all (incl. Xcode) | drift-tracked — scans every push/PR for committed secrets via `reusable-gitleaks.yml`. **Note**: `gitleaks-action@v2` is free for public repos but needs a `GITLEAKS_LICENSE` secret for private ones — confirm each repo's visibility before assuming this runs clean. |
| `.github/workflows/stale.yml` | all (incl. Xcode) | not drift-tracked — hand-tune freely once created (see `weather-app`'s richer version) |
| `.github/workflows/actionlint.yml` | all (incl. Xcode) | drift-tracked — validates every other workflow file against the real Actions schema |

**Not managed** (inherently repo-specific): `AGENTS.md`, `CLAUDE.md`, ESLint,
`tsconfig`, Prettier, and the main CI workflow (`ci.yml`/`quality.yml`/etc. — every
repo's real build/test steps differ too much to template safely; `make sync-apply`
will never create or touch it in an existing repo). These stay hand-owned per repo.

## Intentional drift: `.consistency-ignore`

A repo can legitimately carry a richer/stricter version of a baseline file (e.g.
`health`'s detailed `SECURITY.md`/`.editorconfig` and its stricter `commitlint`,
or the pnpm repos' `pnpm exec` husky hook). To declare that as intentional, add a
top-level `.consistency-ignore` in the repo, one path per line:

```
.editorconfig
commitlint.config.mjs
```

Both `make drift` and the PR-time guard skip listed files; the dashboard shows
them as "blessed" rather than counting them as drift.

## Bundle size reporting (opt-in)

`.github` also hosts `reusable-bundle-size.yml`, which comments on PRs with the
compressed-size diff for a Vite build (via `preactjs/compressed-size-action`,
report-only — no failing budget). Unlike the consistency guard and Gitleaks,
this is **not** auto-synced to every repo: build output layout (`dist/` path,
build script name) varies enough across the ~10 Vite repos that a blind
rollout risks a broken CI step somewhere unverified. It's live today on
`huggingface` and `jonah` (both confirmed working this session). Adopt it
elsewhere with the **Bundle Size** workflow template, adjusting `pattern`/
`build-script` to match that repo's actual output:

```yaml
jobs:
  bundle-size:
    uses: and3rn3t/.github/.github/workflows/reusable-bundle-size.yml@main
    with:
      build-script: build
      pattern: "dist/**/*.{js,css}"
      package-manager: npm   # or pnpm
```

## Cloudflare Pages deploy (opt-in)

`.github` hosts `reusable-cloudflare-pages-deploy.yml` — build + `wrangler pages
deploy`, with a production deploy on push to `main` and a preview deploy on
PRs (skipped for Dependabot/Renovate PRs). Live on `huggingface` and
`telescope`; adopt elsewhere with the **Cloudflare Pages Deploy** workflow
template. Repo-specific extras (a PR comment, a one-time `pages project
create` step) belong in a follow-up job (`needs: deploy`) in the caller, not
in the reusable workflow itself — see `telescope`'s `deploy.yml` for the
pattern. Like bundle-size reporting, this is **not** auto-synced via
`sync-configs.mjs`, since deploy setups vary too much to backfill blind.

## Stale issues/PRs and PR labeling

`stale.yml` (via `reusable-stale.yml`) is now a managed baseline file — synced
to every repo that didn't already have one. `weather-app` has its own richer,
hand-tuned version (different issue/PR thresholds, custom messages, a
`keep-open` exempt label) and was correctly left alone by `sync-apply`, which
only ever creates missing files.

PR auto-labeling (`guess`, `test-project`) is already about as lean as it gets
— a ~10-line `actions/labeler@v5` call reading a repo-local `.github/labeler.yml`.
There wasn't enough boilerplate there to justify a reusable-workflow wrapper;
the actual value (which paths map to which labels) is inherently repo-specific.
Copy `guess`'s `labeler.yml` workflow + `.github/labeler.yml` as a starting
point if you want this in another repo.

## PR-time consistency guard

The `.github` repo hosts `reusable-consistency-guard.yml`. It checks a repo's
baseline files against copies stored in `.github/baseline/` (public repo, so no
PAT needed) and fails or warns on drift, respecting `.consistency-ignore`. Adopt
it in a repo via the **Consistency** workflow template, or call it directly:

```yaml
jobs:
  consistency:
    uses: and3rn3t/.github/.github/workflows/reusable-consistency-guard.yml@main
    with:
      mode: warn   # start with warn, switch to fail once the repo is clean
```

When you change a canonical file in `ai-template-repo`, also update the matching
copy under `.github/baseline/` so the guard checks against the new standard.

## Notes

- Zero dependencies — plain Node ESM. Requires Node (already present for the web repos).
- Xcode-only repos (`Printer`, `remote`, `weather-app`, `homekit-automator`) receive the
  universal files (`.editorconfig`, `SECURITY.md`) but no Node/Python tooling.
- After `make sync-apply` adds husky/lint-staged/commitlint to a Node repo, run
  `pnpm install` / `npm install` in that repo once so the hooks materialize.
