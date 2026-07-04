# Dependency Upgrade Playbook

Prioritized guide for clearing the outstanding **major** version bumps across the
repos, with the real 2026 breaking changes for the upgrades that recur in several
projects. Generated 2026-07-03 from `make outdated`.

## Why this is a playbook, not an auto-applied change

Major bumps here (ESLint 10, Vite 8, TypeScript 6, lucide-react 1, …) carry real
breaking changes. They can only be trusted once a repo's own **build + tests**
pass, and those can't run in the Cowork Linux sandbox — each repo's `node_modules`
holds macOS native binaries (rollup/swc/esbuild), so `vite build` / `vitest` fail
on a platform mismatch. Rather than hand over unverified `package.json` edits, the
recommended path is:

1. **Let Renovate open the major PRs.** It's already configured in every repo with
   `major` updates gated behind Dependency Dashboard approval — approve them from
   the dashboard issue and each lands as a PR that runs the repo's real CI.
2. **Apply the migration steps below** in that PR branch (locally, where `npm test`
   works), using the codemods noted for each.
3. **Merge when green.** The new `Consistency` guard and existing CI keep it honest.

Do the **safe tiers first** (types, test tooling, small majors), then the framework
migrations one at a time.

## Shared migrations (affect multiple repos)

### ESLint 9 → 10  (`eslint`, `@eslint/js`, `eslint-plugin-react-hooks` 5→7, `globals` 16→17)

Affects: flipper, huggingface, jonah (and any other flat-config repo).

> **⚠️ Blocked upstream (as of 2026-07):** `eslint-plugin-react` does not yet
> support ESLint 10 — its peer range caps at eslint 9 and it errors under 10
> ([issue](https://github.com/jsx-eslint/eslint-plugin-react/issues/3977)). Stay on
> **eslint 9** until it ships v10 support. The shared `@and3rn3t/eslint-config` is
> pinned to eslint 9 for this reason; when the plugin updates, bump that package
> once and all consumers move together. The notes below apply when it's unblocked.

Once unblocked this is **low-risk** because all these repos already use flat config
(`eslint.config.js`).

Breaking changes that matter here:

- The legacy `.eslintrc` system is fully removed. Not used in these repos, so no action.
- Config file lookup now starts from each linted file's directory rather than cwd — matters only for monorepos with nested configs (glance at `guess`/`health` if you extend the guard there).
- **JSX reference tracking** is now built in: identifiers used only in JSX are counted as references. This *removes* the class of false-positive `no-unused-vars` errors — a net win, and it may let you delete `eslint-plugin-react`'s equivalent workarounds.
- Requires Node ≥ 20.19 (you're on 24, fine).
- `eslint-plugin-react-hooks` 7 aligns with the new React compiler lint rules — review its changelog for any newly-enabled rules that flag existing code.

Steps: bump the four packages together, run `eslint .`, fix any newly-surfaced
rules. Use `npx @eslint/eslint-transforms` for removed context-method APIs if a
custom rule uses them (these repos don't).

**Shortcut:** adopt **`@and3rn3t/eslint-config`** (in the `eslint-config/` repo) —
it bundles the flat config + plugin versions (eslint 9 for now), so a repo
consolidates its lint setup by replacing its `eslint.config.js` with `import
and3rn3t from '@and3rn3t/eslint-config'; export default and3rn3t`. Lint rules stop
drifting, and when eslint 10 is unblocked upstream, one bump to that package moves
every consumer at once. See that repo's README for rollout order.

### Vite 7 → 8  (Rolldown)

Affects: flipper, huggingface, jonah (7→8), homehub (6→8, do 6→7 first).

Vite 8 swaps esbuild+Rollup for the Rust-based **Rolldown** bundler. Most apps
upgrade with no config change thanks to a compat layer, but watch:

- `build.rollupOptions` → `build.rolldownOptions` (compat layer auto-converts, but migrate it).
- CJS-interop default changed — check any `require()`/default-import of CJS packages.
- Lightning CSS is the default CSS minifier; set `build.cssMinify: 'esbuild'` to revert if output differs.
- **De-risk it:** first set `"vite": "npm:rolldown-vite@7"` (drop-in on the v7 API) and confirm the app builds/renders, *then* move to real Vite 8. Cloudflare Pages/Workers output should be diffed before deploy.

homehub is on Vite **6** — take it 6→7 first (smaller), then 7→8.

### TypeScript 5 → 6

Affects: flipper, jonah. **Highest-friction of the four** — many default changes:

- `strict` is now default; `esModuleInterop`/`allowSyntheticDefaultImports` are always on; `types` defaults to `[]` (you may need to add `"types": ["node", ...]` back); `moduleResolution: classic` and `module: amd/umd/system/none` removed; `target: es5` deprecated.
- Use the **`ts5to6` codemod** to migrate `tsconfig.json`, and `"ignoreDeprecations": "6.0"` as a temporary escape valve (removed in TS 7 — don't leave it).
- Because these repos target modern ESM + bundler resolution already, the main work is confirming `tsconfig` defaults and re-adding `types` where a global (e.g. `vite/client`, `node`) silently dropped.

Do TypeScript **after** ESLint and Vite in each repo, since `typescript-eslint` and Vite both interact with it.

### lucide-react 0.x → 1.0

Affects: flipper, jonah. Mechanical but needs a sweep:

- **Icon renames:** `XCircle→CircleX`, `CheckCircle→CircleCheck`, `AlertCircle→CircleAlert`, `HelpCircle→CircleHelp`, `MinusCircle→CircleMinus`, `PlusCircle→CirclePlus`, `XOctagon→OctagonX`, `AlertOctagon→OctagonAlert`, etc.
- **Brand icons removed** (GitHub, Slack, Figma, …) for legal reasons — replace with inline SVGs or another set. `jonah` (a portfolio) likely uses brand/social icons — audit those first.
- Find usages: `grep -rE "from ['\"]lucide-react['\"]" src` then check each imported name against the v1 rename list.

## Per-repo plans (majors only, safe → risky)

### flipper — 8 majors
| Package | Bump | Tier |
|---|---|---|
| globals | 16 → 17 | safe (config only) |
| jsdom | 28 → 29 | safe (test env) |
| eslint-plugin-react-hooks | 5 → 7 | ESLint group |
| @eslint/js, eslint | 9 → 10 | ESLint group |
| vite | 7 → 8 | framework |
| lucide-react | 0.484 → 1.23 | icon sweep |
| typescript | 5 → 6 | last |

Note: flipper currently has **12 pre-existing lint errors** (unused vars in tests) — clean those first so the ESLint 10 bump has a green starting point.

### huggingface — 15 majors
Biggest jump is the **Vitest 1 → 4** family (`vitest`, `@vitest/coverage-v8`, `@vitest/ui` all 1.x → 4.x) — treat as one group and expect config/API changes in `vitest.config`. Also `@types/node` 20 → 26 (safe), `jsdom` 23 → 29, `@testing-library/react` 15 → 16, `react-day-picker` 9 → 10, `react-resizable-panels` 2 → 4, `marked` 15 → 18, plus the shared ESLint 10 and Vite 8. Order: types/jsdom → Vitest family → testing-library → ESLint → Vite → the component libs.

### jonah — 18 majors (highest)
Portfolio repo, lots of libraries: `zod` 3 → 4, `uuid` 11 → 14, `date-fns` 3 → 4, `recharts` 2 → 3, `@octokit/core` 6 → 7 + `octokit` 4 → 5, `@hookform/resolvers` 4 → 5, `react-day-picker` 9 → 10, `react-resizable-panels` 2 → 4, `marked` 15 → 18, `@cloudflare/workers-types` 4 → 5 (safe), plus shared ESLint 10, Vite 8, TypeScript 6, lucide-react 1. **zod 3→4** and **date-fns 3→4** have notable API changes — do those individually. This repo is the most work; schedule it last or in stages.

### homehub — 3 majors
`concurrently` 9 → 10 (safe, dev script runner), `recharts` 2 → 3 (chart API changes — review chart components), `vite` 6 → 8 (do 6→7 then 7→8). Smallest queue after flipper.

### docker-playground — 0 majors
Only minor/patch updates; Renovate will automerge per your config. Nothing to do.

## Suggested order

1. **homehub** (only 3, good warm-up) and **flipper** (clean the 12 lint errors, then the ESLint/safe tier).
2. **huggingface** (Vitest 1→4 is the main event).
3. **jonah** last, in stages (it has the most surface area).

Within each repo: safe tier → ESLint 10 → Vite 8 → framework/libs → TypeScript 6 → lucide-react 1, running `npm run lint && npm run type-check && npm test && npm run build` after each group.

## Sources

- ESLint v10 migration — https://eslint.org/docs/latest/use/migrate-to-10.0.0 and https://eslint.org/blog/2026/02/eslint-v10.0.0-released/
- Vite migration from v7 / Vite 8 + Rolldown — https://vite.dev/guide/migration and https://vite.dev/changes/
- TypeScript 6.0 — https://www.typescriptlang.org/docs/handbook/release-notes/typescript-6-0.html (codemod: `ts5to6`)
- lucide-react v1 migration — https://lucide.dev/guide/react/migration
