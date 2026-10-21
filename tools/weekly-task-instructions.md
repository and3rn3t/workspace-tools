# "Weekly repo drift" scheduled task — instructions

Paste everything below the line into the task's Instructions in the Claude desktop
app (Scheduled → Weekly repo drift → Edit). claude.ai shows them read-only.

---

Run the weekly workspace check for Matt's GitHub dev folder. Use the device_bash tool (the user's computer). The folder is the connected "GitHub.nosync" folder at /Users/andernet/Documents/GitHub.nosync, mounted at $HOME/mnt/GitHub.nosync. NOTE: the plain "GitHub" folder is empty; always use GitHub.nosync.

1. cd into $HOME/mnt/GitHub.nosync and run, in this order, capturing output:
   - `make meta` (refreshes .github-meta.json from the GitHub API: descriptions, topics, protection, failing workflows, releases)
   - `make changes` (week-over-week diff against .consistency-snapshot.json: NEW REPO, + missing, + drift, + present (presentation regression on an active repo), TIER (a repo changed tier), and the matching "-" fixed lines. It updates the snapshot, so run it exactly ONCE per run.)
   - `make plan` (differences between workspace.json — the source of truth for repo settings — and reality; nothing is applied)
   - `make export` (writes the hosted dashboard's datasets to .dashboard-data/ and today's row in workspace-history.json)
   - `make dashboard` (regenerates the local dashboard.html; last line is the summary)
   If `make` is unavailable, use `node tools/github-meta.mjs`, `node tools/sync-configs.mjs --since-last`, `node tools/plan.mjs`, `node tools/export.mjs`, `node tools/dashboard.mjs`.

2. Refresh the hosted dashboard https://claude.ai/artifact/ExtjNb6AHaPEwEr73uTTkB: upload each of the six files in .dashboard-data/ (summary.json, repos.json, plan.json, ci.json, versions.json, history.json) as an asset of that artifact, then update each `datasets/<name>` document's `source.url` to the new `/_blob/<id>` and `updated` to `{at: <now ISO>, by: "Weekly repo drift"}`. If uploading isn't possible from this session, say so in the reply and continue.

3. Decide whether to notify:
   - Send a push notification ONLY if `make changes` lists at least one NEW REPO, `+ missing`, `+ drift`, `+ present` or `TIER` line, the export shows failing workflows on an active repo that weren't failing last week, `make plan` shows changes in the `archive` or `protection` areas, or a command failed / the folder couldn't be reached.
   - Otherwise do NOT notify; write a one-line summary in the reply.
   - "-" lines alone (things got fixed) are good news: mention them, no notification.

4. When notifying, keep it short and skimmable:
   - Lead with what changed, e.g. "guess lost its CI badge; homehub moved to dormant".
   - List each new item by repo.
   - Include the dashboard summary line and the hosted dashboard link.
   - For missing files recommend `make sync-apply` (or `REPO=<name>`); for settings differences recommend reviewing `make plan` then `make apply`. DO NOT apply anything automatically.

Do not commit or push anything, and do not run `make apply`.
