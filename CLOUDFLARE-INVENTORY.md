# Cloudflare Resource Inventory

A point-in-time map of every Worker, D1 database, KV namespace, and R2 bucket on the
and3rn3t Cloudflare account, cross-referenced against what's actually bound in each
repo's `wrangler.toml`. Generated 2026-07-05. Re-run this audit periodically — nothing
here regenerates automatically yet.

## How this was built

1. Pulled `workers_list`, D1 database list, KV namespace list, and R2 bucket list from
   the Cloudflare API (via the Cloudflare MCP connector).
2. Grepped every repo's `wrangler.toml` (including nested ones, e.g. `homehub/workers/`,
   `network/workers/`) for `binding =`, `database_name =`, and `bucket_name =` to see
   what's actually referenced.
3. Anything with zero references anywhere in the workspace is a candidate for cleanup —
   with one important caveat below.

## Caveat: Cloudflare Pages dashboard bindings won't show up here

Pages projects (like `guess`) can have KV/D1/R2 bindings configured **only in the
Cloudflare dashboard**, never touching `wrangler.toml`. A "no references found" result
below means "not referenced in any file in this workspace" — not "confirmed unused."
**Check the Pages project's Settings → Functions → Bindings in the dashboard before
deleting anything flagged here.**

## Confirmed in active use

| Resource | Type | Used by |
|---|---|---|
| `guess-images` | R2 bucket | `guess` (`GUESS_IMAGES` binding) |
| `vitalsense-health-files` | R2 bucket | `health` (`HEALTH_FILES` binding) |
| `vitalsense-audit-logs` | R2 bucket | `health` (`AUDIT_LOGS` binding) |
| `guess-db` / `guess-db-preview` | D1 | `guess` (`GUESS_DB` binding, prod/preview) |
| `network-db` | D1 | `network` (`DB` binding) |
| `HOMEHUB_KV` / `HOMEHUB_KV_preview` | KV | `homehub/workers/wrangler.toml` |
| `LOGS_KV` / `LOGS_KV_preview` | KV | `homehub/workers/wrangler.toml` |
| `production-HEALTH_KV`, `development-HEALTH_KV` (+preview) | KV | `health` (`HEALTH_KV` binding, per-env) |
| `production-SESSION_KV` | KV | `health` (`SESSION_KV` binding) |
| `production-CACHE_KV` | KV | `health` (`CACHE_KV` binding) |
| `SITE_KV` / `SITE_KV_preview` | KV | `jonah` (`SITE_KV` binding) |
| `CACHE` | KV | `network/workers/wrangler.toml` |

## Orphan candidates — investigated, recommend cleanup

| Resource | Type | Evidence | Recommendation |
|---|---|---|---|
| `simulation-worker` | Worker | Created Jul 2025, never modified since. Code is the generic legacy Cloudflare **Workers Sites** static-asset boilerplate (`@cloudflare/kv-asset-handler`, `getAssetFromKV`) — no app-specific logic, no distinctive routes. Looks like a one-off static-site test that was never touched again. | Safe to delete once you've confirmed no DNS route/custom domain still points at it. |
| `datalab-explorer-db` | D1 | Created Aug 2025. Queried directly — **zero real tables**, only the internal `_cf_KV` system table D1 auto-creates. Genuinely empty. No repo in the workspace references it by name. | Safe to delete — there's no data to lose. |
| `TEST_KV` | KV | Name suggests a scratch/test namespace. No repo references it. | Check dashboard for any Pages project binding, then delete if unbound. |
| `SESSIONS` | KV | No `_KV` suffix (unlike every other in-use namespace), no repo references it. Possibly an old naming convention predating the `SESSION_KV` pattern `health` uses now. | Check dashboard, then delete if unbound. |
| `GUESS_KV` / `GUESS_KV_PREVIEW` | KV | Named for `guess`, but not referenced in `guess/wrangler.toml` — `guess` is a Pages project, so this pair is the most likely to be dashboard-only bindings rather than truly orphaned. | **Check the `guess` Pages project's dashboard bindings first.** Don't delete without confirming there.

## Not orphaned, but worth a look: `health`'s Worker sprawl

`health` alone accounts for 12 separate Workers. Went through `wrangler.toml`'s `[env.*]`
blocks and matched each declared environment against the actual worker name it deploys
to, then compared against last-modified dates. Clear pattern: current/live environments
keep getting redeployed into 2026, while a whole family of workers froze around Sep–Nov
2025 and never moved again.

**Confirmed current** — each has a matching `[env.*]` block in `wrangler.toml` today:

| Worker | Env block | Last modified |
|---|---|---|
| `health-app` | (default) | Apr 16, 2026 |
| `health-app-dev` | `[env.development]` | Sep 18, 2025 |
| `health-app-prod` | `[env.production]` | **Jun 30, 2026** |
| `health-app-preview` | `[env.preview]` | **Jul 2, 2026** |
| `vitalsense-websocket-advanced-dev` | `[env.advanced-dev]` (comment: "connected to this repo via the Cloudflare GitHub integration") | Nov 19, 2025 |

**Likely superseded** — no matching `[env.*]` block in `wrangler.toml` at all, and all
6 went silent within the same Sep–Nov 2025 window and never updated again, even as
`health-app`/`health-app-prod` kept shipping through 2026:

| Worker | Notes |
|---|---|
| `vitalsense-websocket-advanced-prod` | No `[env.advanced-prod]` block exists (only `advanced-dev` does). Modified Nov 19, 2025 — same day as `advanced-dev`'s last update, then nothing since. |
| `vitalsense-websocket-enhanced-dev` | Never modified after creation (Sep 27, 2025). |
| `vitalsense-websocket-prod` | Never modified after creation (Sep 27, 2025). Looks like an earlier naming iteration before the `advanced-*` scheme. |
| `vitalsense-websocket-dev` | Same — earlier iteration, superseded by `advanced-dev`. |
| `vitalsense-health-prod-production` | Never modified after the instant it was created (Sep 2, 2025). |
| `vitalsense-health-prod` | Modified once, 3 days after creation (Sep 5, 2025), then nothing for ~10 months. |

**The likely explanation**: `wrangler.toml`'s main `health-app` config already has its
own `HEALTH_WEBSOCKET` Durable Object binding (present in the default, `development`,
`production`, `preview`, *and* `advanced-dev` env blocks). This strongly suggests
websocket handling was consolidated into `health-app` itself via Durable Objects, and
the standalone `vitalsense-websocket-*` worker family was an earlier, separate
architecture that got replaced but never cleaned up.

**One more thing worth fixing in the repo itself** (not just Cloudflare): `wrangler.toml`
still has an `[env.websocket]` block (line 155) that deploys to `name = "vitalsense-websocket-test"`
— a worker name that doesn't exist anywhere in the account's current Worker list. That
env block is dead config; either remove it or update it to point at something real.

## Next steps

1. Check the `guess` Pages project dashboard for `GUESS_KV`/`GUESS_KV_PREVIEW` bindings.
2. If confirmed unbound: delete `TEST_KV`, `SESSIONS`, and (if also unbound)
   `GUESS_KV`/`GUESS_KV_PREVIEW` via the dashboard or `wrangler kv namespace delete`.
3. Delete `datalab-explorer-db` (`wrangler d1 delete datalab-explorer-db`) — confirmed
   empty, no data at risk.
4. Delete `simulation-worker` (`wrangler delete --name simulation-worker`) after
   confirming no custom domain/route still points at it in the dashboard.
5. For `health`'s Worker sprawl: check the dashboard for any custom domain/route on
   `vitalsense-websocket-advanced-prod`, `-enhanced-dev`, `-prod`, `-dev`,
   `vitalsense-health-prod-production`, and `vitalsense-health-prod` — if none of the 6
   have a live route/domain attached, they're safe to delete (`wrangler delete --name <name>`).
6. Remove or fix the dead `[env.websocket]` block in `health/wrangler.toml` (targets
   `vitalsense-websocket-test`, which doesn't exist as a deployed worker).
