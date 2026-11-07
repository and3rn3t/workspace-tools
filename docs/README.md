# Documentation index

| Doc | Kind | Read it for |
|---|---|---|
| [`../README.md`](../README.md) | Overview | What this repo is, command cheat-sheet |
| [`../tools/README.md`](../tools/README.md) | **Reference (canonical)** | Every `make` target, the sync/drift design, `workspace.json`, budgets, tiers, guard, secrets |
| [`../CLAUDE.md`](../CLAUDE.md) | Generated index | Map of all sibling repos for AI assistants (edit `workspace.json`, not this) |
| [`../.claude/skills/workspace/SKILL.md`](../.claude/skills/workspace/SKILL.md) | Claude skill | Intent → `make` command mapping; which targets need a go-ahead |
| [`weekly-task-instructions.md`](weekly-task-instructions.md) | Runbook | Instructions pasted into the weekly drift scheduled task |
| [`dependency-upgrade-playbook.md`](dependency-upgrade-playbook.md) | Guide (point-in-time) | Migration steps for ESLint 10, Vite 8, TS 6, lucide-react 1 |
| [`cloudflare-inventory.md`](cloudflare-inventory.md) | Snapshot (2026-07-05) | Workers/D1/KV/R2 cross-referenced with `wrangler.toml` bindings |
| [`history/consistency-plan.md`](history/consistency-plan.md) | Archive | Phases 1–13 of the baseline rollout, with rationale |
| [`history/workflow-optimization.md`](history/workflow-optimization.md) | Archive | 2026-07-02 CI/workflow review |

## Keeping docs current

- Adding a `make` target: update the `Makefile` help line, the table in `tools/README.md`, and `SKILL.md`.
- Repo list/summaries: edit `workspace.json`; `CLAUDE.md` is generated.
- Point-in-time docs carry a dated banner; refresh or retire them rather than patching in place.
