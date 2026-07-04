# Workflow Optimization Plan

_Reviewed 2026-07-02. Follows the completed CONSISTENCY-PLAN.md (Phases 1–5 done & pushed)._

## Done in this pass (2026-07-02 — working-tree edits, not committed/pushed)

- **Bug fix — CodeQL couldn't upload results.** All 5 reusable-CodeQL callers (and3rn3t,
  homehub, amiibo, health, huggingface) granted only `contents: read`, but the reusable job needs
  `security-events: write` + `actions: read`. In reusable workflows the caller's permissions are
  the ceiling, so CodeQL was running but its upload step would fail with "Resource not accessible
  by integration." Added the missing scopes to all 5. **Verify after push:** check the CodeQL runs
  actually upload to the Security tab (this is the one change to watch).
- **Bug fix — dependency-review PR summary.** Added `pull-requests: write` to 4 dep-review callers
  (and3rn3t, homehub, amiibo, huggingface) so `comment-summary-in-pr` can post.
- **§8** Added `concurrency` (cancel-in-progress) to all 5 reusable workflows — callers inherit it.
  (Note: `permissions` and `timeout-minutes` were already present in the reusable set.)
- **§1** Converted `ai-template-repo` + `test-project` `codeql.yml` and `dependency-review.yml`
  from standalone copies to reusable calls (with correct permissions) so new repos start clean.
- **§10** Added canonical `renovate-config.json` to the `.github` repo. Not yet wired into the 14
  repos — do that after `.github` is pushed (see "Needs Matt" below).
- **§11** Added to `.github`: `CODEOWNERS`, org `profile/README.md`, `PULL_REQUEST_TEMPLATE.md`,
  `ISSUE_TEMPLATE/` (bug + feature + config). Also added `CODEOWNERS` to `ai-template-repo`.
- All 18 changed YAML files + the JSON preset validated.

### Still needs Matt (decisions or push required)
- **Push order:** publish the updated `.github` repo **before** the caller repos, or their CI
  errors with "workflow not found." Same rule as the original migration.
- **§7 pinning:** to pin callers off `@main`, first tag the `.github` repo (e.g. `v1`) and push,
  then swap `@main` → `@v1` across callers. Left as `@main` for now since no tag exists yet.
- **§10 rewire:** after the preset is pushed, reduce each repo's `renovate.json` to
  `{ "extends": ["github>and3rn3t/.github//renovate-config"] }` (+ local overrides for guess/amiibo).
- **§2** version `weather` + `docker` (confirm remotes first).
- **§3** `guess` cron audit, **§4/§12** archive `reddit`/`posture`. Not touched — your call.

---

## Where things stand

The consistency pass worked. A real `and3rn3t/.github` repo now ships 5 reusable workflows
(`reusable-codeql`, `reusable-dependency-review`, `reusable-node-verify`, `reusable-python-test`,
`reusable-playwright-e2e`), and the active repos call them: amiibo, and3rn3t, flipper, health,
homehub, huggingface. Every git repo is clean and fully pushed (0 commits ahead of origin).
`guess` deliberately keeps its own stricter infra (pinned SHAs, security-extended).

That baseline is good. What's left is a handful of gaps and some pruning — not another big rollout.

Repo activity snapshot (by last commit):

| Tier | Repos |
|---|---|
| Active (today) | and3rn3t, guess, health, homehub, huggingface, flipper, jonah, test-project |
| Warm (weeks) | amiibo, apple-music-dj |
| Cold (3–5 mo) | ai-template-repo, apple-photos-cleaner, homekit-automator, r-data, Printer, remote, posture, reddit |
| Not under git | weather, docker |

---

## 1. Fix the template so new repos start consistent (highest leverage)

`ai-template-repo` is the baseline for every new repo, but its `codeql.yml` and
`dependency-review.yml` are still **standalone copies**, not calls to the reusable workflows.
`test-project` (the template's test bed) has the same standalone copies. So every repo cloned
from the template inherits the old duplicated pattern — the exact thing the `.github` repo exists
to prevent.

**Action:** convert `ai-template-repo`'s `codeql.yml` and `dependency-review.yml` to reusable
calls (`uses: and3rn3t/.github/.github/workflows/reusable-*.yml@main`), mirror into
`test-project`, and verify the template's `ci.yml` reusable call is uncommented (line 7 is still
a commented-out example). One-time change; compounds on every future repo.

## 2. Put `weather` and `docker` under version control

`weather` is a 173 MB shipping iOS/Android app (fastlane, docs, screenshots) with **no local
`.git`**. `docker` (271 MB docker-playground) is the same — a real project with source and a
`dist/`, not a git repo locally. If either exists on GitHub, the local copy is a detached export
with no history or backup; if it doesn't, the work is entirely unversioned.

**Action:** confirm remotes exist, then `git init` + `git remote add` (or re-clone) so both track
against `github.com/and3rn3t/`. Until then they're outside every workflow, Renovate, and CodeQL
you've set up.

## 3. Audit `guess`'s 11 nightly cron workflows

`guess` runs 25 workflows, **11 of them on cron** (adaptive-data-refresh, corroborate-nightly,
db-sync-preview, engine-self-tune, enrich-bulk-nightly, real-data-aggregate, reconcile-nightly,
sparse-fill-nightly, vision-enrich-nightly, wikidata-enrich + more). That's a lot of scheduled
Actions minutes and 11 separate failure surfaces to watch.

**Action:** review which still earn their keep. Consider collapsing the data-enrichment nightlies
into **one orchestrator workflow with a job matrix** (or sequential `needs:` chain) so it's one
run, one notification, one place to see failures — instead of 11 independent crons that can fail
silently. Not urgent, but it's the biggest source of ongoing CI cost and noise in the folder.

## 4. Removal / archive candidates

Nothing needs deleting locally, but on GitHub these are archive candidates to reduce surface area:

- **`reddit`** — single-commit daily-briefing experiment, cold 5 months. Archive or fold the idea
  into a scheduled Cowork task instead of a repo.
- **`posture`** — untouched Spark starter (all commits are "Generated by Spark"), no real code.
  Archive until you actually start it.
- **`test-project`** — genuinely useful as the template's smoke test; keep, but it doesn't need
  the full release/label/lighthouse workflow set. Trim it to just the CI + CodeQL calls it exists
  to validate.
- **`docker`** — decide: real project (→ §2, version it) or scratchpad (→ delete the 271 MB local
  copy).

## 5. New shared workflows worth adding to `.github`

The reusable set covers node-verify, python-test, codeql, dep-review, playwright. Gaps that
several repos currently solve with per-repo copies:

- **`reusable-release.yml`** — 6 repos have their own `release.yml`/`release-drafter.yml`
  (ai-template, test-project, homekit-automator, remote, guess, health). One reusable release-
  drafter call would dedupe them.
- **`reusable-lighthouse.yml`** — and3rn3t, health, homehub, ai-template, test-project each carry
  a standalone `lighthouse.yml`. Same job, five copies.
- **`reusable-stale.yml`** — ai-template, test-project, homehub run identical stale-issue bots.
- **`reusable-swift-build.yml`** — health, remote, Printer, weather, homekit-automator are all
  Xcode projects with no shared iOS CI. A reusable build+test workflow would give the native apps
  the same leverage the web apps got. (health already has `ios-build.yml`/`ios-ci.yml` — start
  from those.)

## 6. Small hygiene follow-ups (from CONSISTENCY-PLAN loose ends)

- `homehub` CI still matrixes Node 22.x + 24.x — the plan flagged dropping the 22.x leg; confirm
  it's done or do it.
- Local install steps still pending per that plan: `pnpm install` (and3rn3t) / `npm install`
  (homehub, huggingface) to materialize husky hooks; `pre-commit install` in amiibo.
- Once repo visibility is confirmed public, replace the per-repo Renovate copies with
  `"extends": ["github>and3rn3t/ai-template-repo"]` so config lives in one place (already noted as
  a future improvement in Phase 2).

---

## 7. Supply-chain hardening (grounded in a scan of all 211 workflow files)

Two real gaps:

- **Your reusable workflows are called at `@main`.** All 18 caller references point to
  `and3rn3t/.github/...@main` — a mutable ref. A bad commit to `.github/main` instantly breaks
  (or could compromise) CI in every consuming repo. **Pin callers to a tag or SHA** (e.g. `@v1`)
  and let Renovate bump them. You get the same "one source of truth" benefit without the live-wire
  risk.
- **215 third-party action refs are tag-pinned (`@v4`), only 103 are SHA-pinned.** Your Renovate
  config already sets `helpers:pinGitHubActionDigests`, so the tooling to fix this exists — it just
  hasn't been applied everywhere. That means Renovate either hasn't run on those repos or its
  pin-PRs are sitting unmerged. **Action:** confirm Renovate is enabled and merge the digest-pin
  PRs; going forward every action gets SHA-pinned automatically.

## 8. CI efficiency & cost (where Actions minutes leak)

From the same scan across 211 workflows:

- **Only 44 have a `concurrency:` group.** The other ~167 don't cancel superseded runs — every
  push while a job is running keeps burning minutes on stale commits. Add a default
  `concurrency: { group: ${{ github.workflow }}-${{ github.ref }}, cancel-in-progress: true }` —
  and put it in the **reusable workflows** so all callers inherit it for free.
- **Only 49 set `timeout-minutes`.** The rest can hang up to the 6-hour default on a stuck step.
  Add a sane default (10–20 min) to the reusable workflows.
- Combined with `guess`'s 11 nightly crons (§3), these two are the bulk of avoidable CI spend.

## 9. Least-privilege token scopes

**Only 73 of 211 workflows declare an explicit `permissions:` block** — the rest run with the
default `GITHUB_TOKEN`, which is broader than most jobs need. Set `permissions: contents: read` at
the top of each reusable workflow (and the template), then widen per-job only where needed
(`packages: write`, `pages: write`, etc.). Fixing it in the reusable set covers every caller at once.

## 10. Collapse 14 Renovate copies into one preset

There are **14 near-identical ~90-line `renovate.json` files**, each extending only
`config:recommended` — not your shared preset. This is the Phase 2 "future improvement" that's
still open. Publish the canonical config as `and3rn3t/.github//renovate-config.json` (or
`ai-template-repo//default.json`), then reduce every repo to:

```json
{ "extends": ["github>and3rn3t/.github//renovate-config"] }
```

Repo-specific bits (guess's Expo/RN group, amiibo's pip flavor) stay as local overrides. One place
to change scheduling/automerge rules instead of 14.

## 11. Fill out the `.github` org repo

`and3rn3t/.github` currently holds only `README.md` + `SECURITY.md`. As the org-wide defaults repo
it can supply, for free across every repo that lacks its own:

- **CODEOWNERS** — none exist anywhere in the folder; auto-request your review on PRs.
- **Org profile** (`.github/profile/README.md`) — the landing page on your GitHub org page.
- **PR template + `ISSUE_TEMPLATE/`** — none found; standardizes contributions (and AI-agent PRs).
- **`FUNDING.yml`** and default **release-drafter** config as org defaults.

## 12. Turn `reddit` into a scheduled task, not a repo

The daily-briefing experiment is a natural fit for a scheduled Cowork task (runs on a cron,
delivers to you) rather than a dormant repo with a workflow. If that's the actual goal, I can set
up the schedule and you can archive the repo.

---

## Suggested order

**Do first — safety, before anything else touches these:**
1. §2 version `weather`/`docker` — data-loss risk
2. §7 pin reusable-workflow callers off `@main` — live supply-chain exposure

**High-leverage, low-risk (change reusable workflows once, all callers inherit):**
3. §8 add default `concurrency` + `timeout-minutes` to reusable workflows — immediate CI-minute savings
4. §9 add `permissions: contents: read` to reusable workflows + template
5. §1 template fix — compounds on every future repo

**Cleanup / dedupe:**
6. §10 collapse the 14 Renovate copies into one preset
7. §11 fill out the `.github` org repo (CODEOWNERS, PR template, profile)
8. §6 hygiene loose ends (Node 22 leg, husky installs)
9. §5 add reusable-release + reusable-lighthouse

**Judgment calls (need your input):**
10. §3 `guess` cron audit — biggest ongoing-cost win
11. §4 / §12 archive `reddit` (or convert to scheduled task) + `posture`
