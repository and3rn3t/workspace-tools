# Repo Consistency Plan

Goal: bring all actively developed repos (commits since April 2026) to a common baseline, then backfill older repos opportunistically. Decisions locked in: **Node 24 LTS**, **Renovate everywhere**, **commitlint + husky on all active repos**.

**Active repos (focus):** amiibo, and3rn3t, guess, health, homehub, huggingface
**Older repos (best-effort):** flipper, remote, weather, Printer, jonah, apple-music-dj, apple-photos-cleaner

## Phase 1 — Baseline hygiene (active repos) ✅ DONE 2026-07-02

Completed: .nvmrc 24.13.0 + engines >=24 (and3rn3t, guess, homehub, huggingface; health already there); .editorconfig (amiibo, and3rn3t, guess); SECURITY.md (amiibo, and3rn3t, huggingface); LICENSE (amiibo); AGENTS.md source-of-truth pattern (amiibo, and3rn3t, homehub, huggingface; health got a pointer AGENTS.md since its CLAUDE.md is the established doc; guess kept its own richer AGENTS.md).
Notes: homehub CI still matrixes Node 22.x+24.x — drop the 22.x leg in Phase 3. Matt needs `nvm install 24` locally for the pnpm repos (pnpm enforces engines).

| Item | Needs it | Source |
|---|---|---|
| `.nvmrc` = 24 LTS + `engines` `>=24` | and3rn3t, guess, homehub, huggingface (health: verify only) | ai-template-repo |
| `.editorconfig` | amiibo, and3rn3t, guess | ai-template-repo |
| `SECURITY.md` | amiibo, huggingface | ai-template-repo |
| `LICENSE` | amiibo | MIT, match other repos |
| `AGENTS.md` + pointer CLAUDE.md/copilot-instructions | all six (adapted per repo; guess: convert existing copilot file to pointer) | ai-template-repo pattern |

## Phase 2 — Dependency automation ✅ DONE 2026-07-02

Completed: canonical renovate config (based on guess's, minus its Expo/RN group) rolled out to and3rn3t, health, homehub, huggingface + saved to ai-template-repo as the standard; amiibo got a Python-flavored variant (actions/security/major rules, no lockfile maintenance); guess kept its richer config. Deleted dependabot.yml from health, homehub, huggingface, and the template.
Notes: health's old dependabot covered swift (/ios) and devcontainers — Renovate's managers pick both up automatically. Couldn't verify repo visibility via API, so configs are per-repo copies; if repos are public (or the Renovate app has org access), a future improvement is `"extends": ["github>and3rn3t/ai-template-repo"]` with a default.json preset. Older repos (flipper, jonah, posture, test-project) still have dependabot — Phase 5.

- Renovate config in all six; add `renovate.json` to amiibo (pip) and health.
- Remove duplicate `dependabot.yml` from homehub, huggingface; replace in health (keep GitHub Actions updates via renovate's `github-actions` manager).
- Align renovate configs on one shared preset (schedule, automerge rules for devDependencies patch/minor).

## Phase 3 — CI parity ✅ DONE 2026-07-02

Completed: huggingface ci.yml (lint + type-check + format:check + coverage + build, Node from .nvmrc); amiibo ci.yml (pytest on Python 3.10 & 3.13); CodeQL added to and3rn3t (js), huggingface (js/ts), amiibo (python); dependency-review added to all three; homehub ci.yml matrix now 24.x-only with conditionals flipped. All YAML syntax-validated.
~~Deferred: extracting a shared reusable workflow into an `and3rn3t/.github` repo.~~ Done 2026-07-02: local `.github` repo created (reusable-node-verify, reusable-python-test, workflow templates, default SECURITY.md) — needs to be pushed to GitHub as a **public** repo named `.github`.

Round 2 (2026-07-02): shared repo gained reusable-codeql, reusable-dependency-review, reusable-playwright-e2e + default release-drafter config (committed locally — push `.github` again). Migrated: codeql callers (health, homehub, and3rn3t, huggingface, amiibo), dep-review callers (and3rn3t, huggingface, amiibo, homehub), playwright (and3rn3t quality e2e, huggingface e2e nightly, homehub test.yml e2e). Cleanups: huggingface deploy.yml slimmed to build+deploy (quality lives in ci.yml), homehub test.yml dropped duplicate unit job (a11y + e2e remain), health's dead dependabot-auto-merge.yml deleted. guess intentionally not migrated (pinned SHAs, security-extended — stricter than shared).

CI migrations to reusable calls (2026-07-02): huggingface ci.yml, flipper ci.yml (+ added .nvmrc), amiibo ci.yml, and3rn3t quality.yml (lint + unit jobs; e2e stays custom for Playwright setup). **PUSH ORDER MATTERS: publish the `.github` repo BEFORE pushing these repos, or their CI will fail with "workflow not found".** Left as-is deliberately: homehub (custom coverage gates), health, guess (own reusable infra).

- **huggingface**: add quality CI (lint + type-check + vitest) — currently only deploy.yml/e2e.yml.
- **amiibo**: add CI (pytest + ruff/format check) — currently none.
- **CodeQL + dependency-review**: add to and3rn3t, huggingface, amiibo (already in guess/health/homehub).
- Longer-term: extract guess's `reusable-node-verify.yml` into a shared `.github` repo (`and3rn3t/.github`) so all repos call one workflow.

## Phase 4 — Commit conventions ✅ DONE 2026-07-02

Completed: commitlint.config.mjs (health's stricter variant) + .husky/commit-msg (guess's merge-safe hook) + prepare script + devDeps added to and3rn3t, homehub, huggingface, and ai-template-repo. amiibo got .pre-commit-config.yaml with conventional-pre-commit v4.4.0 (verified latest tag).
Action needed from Matt: run `pnpm install` (and3rn3t) / `npm install` (homehub, huggingface) to materialize husky + update lockfiles; `pip install pre-commit && pre-commit install --hook-type commit-msg` in amiibo.

- Add commitlint (`commitlint.config.mjs`) + husky `commit-msg` hook to: and3rn3t, homehub, huggingface, amiibo (husky N/A for amiibo — use pre-commit instead).
- Copy config from guess/health (already identical pattern).

## Phase 5 — Older repos ✅ DONE 2026-07-02

Completed: flipper got ci.yml (Node 24 — untested on 24 locally, watch first run), renovate.json, AGENTS.md source-of-truth (merged CLAUDE.md + old copilot repo defaults), pointer CLAUDE.md/copilot-instructions, dependabot removed. remote got AGENTS.md + copilot pointers (CLAUDE.md stays SoT — it and the old copilot file were exact duplicates), LICENSE, SECURITY.md. Printer got LICENSE + SECURITY.md; weather got SECURITY.md. jonah/posture/test-project switched dependabot → canonical renovate. Zero dependabot.yml files remain in the folder.

## Phase 6 — Sync mechanism + orchestration ✅ DONE 2026-07-03

The prior phases were one-time hand-copies that will drift again. Phase 6 adds the *mechanism* to keep repos consistent, plus a cross-repo command runner. All under `tools/` + root `Makefile` (see `tools/README.md`).

- **`tools/sync-configs.mjs`** — non-destructive template sync. Creates missing baseline files from `ai-template-repo` (Python variants from `tools/templates/python/`), type-aware (node/python/xcode/all). Never overwrites; a `--drift` mode only *reports* files that differ. `make sync` / `make sync-apply` / `make drift`.
- **`tools/repo-run.mjs`** — fans `lint|build|test|typecheck|format|audit|doctor` across all repos, auto-detecting pnpm vs npm vs Python (ruff/pytest), skipping repos that lack the command. `make lint`, `make doctor`, etc. `REPO=name` scopes to one.
- **Applied 2026-07-03:** `make sync-apply` created **39** missing files across 19 repos (stragglers reddit, weather-app, docker-playground, jonah, posture, apple-music-dj, apple-photos-cleaner, homekit-automator, Printer, remote got their baseline; active repos got `.lintstagedrc.json`). Removed homehub's duplicate `.prettierrc.json` (kept the complete `.prettierrc`). Post-apply: 0 missing, 75 in sync.
- **10 known drift items (intentionally left — richer/stricter per-repo variants, review by hand if ever reconciling):** and3rn3t/guess/health `.husky/commit-msg`; apple-photos-cleaner, docker-playground, flipper, health, homehub, homekit-automator, huggingface `.editorconfig`. health's is the deliberate stricter/detailed one.
- **Follow-up for Matt:** in each Node repo that newly got husky/commitlint/lint-staged (docker-playground, flipper, jonah, posture), run `npm install` (or `pnpm install`) once so the git hooks materialize.

## Phase 7 — Dashboard, scaffolder, automation ✅ DONE 2026-07-03

- **`tools/dashboard.mjs`** (`make dashboard`) — scans all repos, emits self-contained `dashboard.html`: per-repo type, CI/renovate/husky/commitlint/editorconfig/nvmrc/AGENTS/pre-commit coverage, drift flags, consistency score, last commit. First run: **93% overall, 7/19 fully consistent, 10 drift**.
- **`tools/new-repo.mjs`** (`make new-repo NAME=x TYPE=node|python`) — bootstraps a new sibling repo from the template baseline (+ git init) so future repos start green and never need backfilling. Dry-run by default, `--apply` to create.
- **Scheduled task `weekly-repo-drift`** (Mondays ~8:39am) — runs `make sync` + `make drift` + `make dashboard`, reports newly-missing files / drift / repos without CI. Recommends `make sync-apply`, never auto-applies. Complements the existing `weekly-claude-md-freshness` task.

## Phase 8 — PR guard, drift reconciliation, outdated ✅ DONE 2026-07-03

- **Drift reconciled to 0.** Normalized accidental drift (apple-photos-cleaner, docker-playground, flipper, huggingface `.editorconfig` were subsets/reorders → template; **health's `.husky/commit-msg` was a broken one-liner missing the merge-safe skip logic → restored**). Blessed intentional richer variants via a new **`.consistency-ignore`** mechanism: health (`.editorconfig`, `commitlint`), guess (`.husky/commit-msg`, `commitlint`), homehub + homekit-automator (`.editorconfig`), and3rn3t (`.husky/commit-msg`, pnpm exec). `make drift` and the dashboard now honor these. Result: **0 drift, 14/19 fully consistent** (was 7).
- **PR-time consistency guard** in the `.github` repo: `reusable-consistency-guard.yml` diffs a caller's baseline files against copies in `.github/baseline/` (public repo, no PAT), respects `.consistency-ignore`, fail-or-warn. Ships with a `Consistency` workflow template (default `mode: warn`). Simulated across all repos → 0 violations. **To adopt: add the Consistency workflow to each repo (start warn, flip to fail once clean). Remember to update `.github/baseline/` whenever a canonical file changes in ai-template-repo.**
- **`make outdated`** — per-repo snapshot of outdated npm/pnpm deps with major-bump highlighting. Notable at time of writing: jonah 62 outdated (18 major), huggingface 69 (15), flipper 25 (8), homehub 75 (3).

## Phase 9 — Guard rollout + dependency playbook ✅ DONE 2026-07-03

- **Guard adopted** (warn mode) via `.github/workflows/consistency.yml` in and3rn3t, guess, health, homehub, huggingface (node defaults) and amiibo (`files: .editorconfig`). All 6 YAML-validated; guard logic simulated → 0 violations. **Push order: publish the `.github` repo (with `reusable-consistency-guard.yml` + `baseline/`) BEFORE these repos, or the workflow errors "not found."** Flip each to `mode: fail` once its first run is green.
- **`DEPENDENCY-UPGRADE-PLAYBOOK.md`** — researched migration guide for the outstanding majors (ESLint 10, Vite 8/Rolldown, TypeScript 6, lucide-react 1) with per-repo priority tables. Not auto-applied: the sandbox can't run repo build/test (macOS native binaries vs Linux), so major bumps go through Renovate PRs where real CI verifies. Order: homehub/flipper → huggingface (Vitest 1→4) → jonah (18 majors, staged). docker-playground has 0 majors.

## Phase 10 — Flipper lint + shared eslint-config ✅ DONE 2026-07-03

- **flipper lint cleaned:** fixed all **12 eslint errors** (unused imports/vars, unescaped JSX apostrophes) — verified `eslint` 0 errors (8 hooks/fast-refresh warnings left deliberately, as fixing them can change runtime behavior) and `tsc -b` passes. Gives the ESLint 10 bump a green starting point.
- **`@and3rn3t/eslint-config`** (new `eslint-config/` repo) — publishable package exporting the canonical flat config (React + typescript-eslint), plugins bundled as deps, `eslint`/`typescript` as peers. Scaffolded consistent via `make sync-apply`. Adopting it replaces a repo's hand-rolled `eslint.config.js`. **Pinned to eslint 9:** `eslint-plugin-react` doesn't support eslint 10 yet ([issue 3977](https://github.com/jsx-eslint/eslint-plugin-react/issues/3977)) — when it does, one dep bump here moves every consumer to 10. Rollout target: flipper, huggingface, and3rn3t, guess, health, homehub, jonah. Needs publishing to a registry before consumers can install.

## Phase 11 — flipper adopts the shared eslint-config (reference) ✅ DONE 2026-07-03

Reference adoption for the other repos to copy. flipper's `eslint.config.js` now just `import and3rn3t from '@and3rn3t/eslint-config'; export default and3rn3t`. package.json: added `"@and3rn3t/eslint-config": "file:../eslint-config"`, removed the now-redundant plugin devDeps (`@eslint/js`, `eslint-plugin-react[-hooks|-refresh]`, `globals`, `typescript-eslint`), kept `eslint` on `^9.28.0`. **Activation on Matt's machine: `npm install` then `npm run lint`.** Switch `file:` to `^0.1.0` once the package is published. Roll the same change to huggingface, and3rn3t, guess, health, homehub, jonah.

**Correction (2026-07-03):** first cut of this package/adoption targeted eslint 10; `eslint-plugin-react` doesn't support eslint 10 yet, and the `file:` install also failed on the package's `prepare: husky` running in the consumer. Fixed: package pinned to eslint 9, `prepare` guarded as `husky 2>/dev/null || true`, flipper reverted to eslint 9. ESLint 10 deferred until upstream plugin support lands.

**✅ Verified working (2026-07-03):** after `cd eslint-config && npm install` (needed once for `file:` symlink resolution — see eslint-config README), flipper's `npm run lint` runs the shared config: **0 errors, 8 warnings** (the hooks/fast-refresh ones intentionally left). Reference adoption complete.

## Phase 12 — Publish setup for @and3rn3t/eslint-config ✅ DONE 2026-07-03 (build side)

Chosen registry: **public npm**. package.json: `publishConfig.access: public`, added `repository`/`homepage`/`bugs`/`keywords`, `files` ships only `index.js`. Added `eslint.config.js` (self-lint via own config) and `.github/workflows/publish.yml` — publishes to npm **with provenance** on each GitHub Release (needs repo secret `NPM_TOKEN`). Provenance kept OUT of `publishConfig` so a local first `npm publish` doesn't error (provenance only works in CI). Lockfile present for CI `npm ci`.

**Matt's manual steps:** (1) npm account + `@and3rn3t` scope/org; (2) create GitHub repo `and3rn3t/eslint-config` + push (incl. package-lock.json); (3) `npm login` && `npm publish` for the first release; (4) add `NPM_TOKEN` secret for automated releases thereafter; (5) switch consumers `file:../eslint-config` → `^0.1.0`. Full detail in eslint-config/README.md.

**✅ PUBLISHED & LIVE (2026-07-03):** `@and3rn3t/eslint-config@0.1.0` is on public npm (`npm view` confirms). flipper switched to `^0.1.0`, `npm install` + `npm run lint` → 0 errors. Remaining: roll the same 3-line change to huggingface, and3rn3t, guess, health, homehub, jonah; add `NPM_TOKEN` secret to automate future releases.

## Phase 13 — eslint-config v0.2.0 retarget + wider rollout 🔶 2026-07-03 (needs republish)

Inspecting the six candidate repos showed they do NOT share flipper's config. Key finds: **and3rn3t** is plain JS + Worker (not React/TS — n/a); **health** & **guess** are heavily customized (type-aware, jsx-a11y, multi-context; guess on react-hooks 7); **homehub is already on eslint 10**. The real common base is `@eslint/js` + `typescript-eslint` + `react-hooks` + `react-refresh` + `^_` unused-vars — **without** `eslint-plugin-react` (only flipper used it).

Actions: **retargeted `@and3rn3t/eslint-config` → v0.2.0** — dropped `eslint-plugin-react`, common base only. Adopted (extend pattern, extras preserved) in **huggingface** and **jonah**; **flipper** bumped to `^0.2.0`. Each removed the now-redundant plugin devDeps (`@eslint/js`, `eslint-plugin-react-hooks`/`-refresh`, `globals`, `typescript-eslint`). All configs syntax-checked; consumer bases are byte-identical to the shared config so no new lint findings expected. **Skipped:** homehub (eslint 10, ahead), guess & health (custom), and3rn3t (plain JS).

**Matt's manual steps:** (1) republish the package — bump is already `0.2.0`, so `cd eslint-config && npm publish` (or cut a Release once `NPM_TOKEN` is set); (2) in flipper, huggingface, jonah: `npm install && npm run lint` to pull `^0.2.0` and confirm clean. Future eslint-10 move: bump the package's deps+peer to 10, republish, and homehub + the eslint-9 repos unify on 10.

## Verification

- Consistency scorecard: open `dashboard.html` (regenerate with `make dashboard`).
- Cross-repo: `make lint` / `make test` / `make typecheck` from the folder root.
- Consistency drift: `make drift` (surfaces divergence without touching files).
- Per repo after changes: `pnpm validate` (or repo equivalent: lint + type-check + test).
- Nothing is committed or pushed without explicit approval; changes land as working-tree edits for review.
- Weekly `weekly-claude-md-freshness` scheduled task already monitors doc drift.

## Suggested order of execution

1. Phase 1 (pure file adds, zero risk)
2. Phase 2 (config swap, low risk)
3. Phase 4 (tooling, needs `pnpm install` per repo)
4. Phase 3 (CI YAML — verify against each repo's scripts)
5. Phase 5 opportunistically
