# Meta-workspace orchestration for all and3rn3t repos.
# Thin wrappers over tools/*.mjs — run from the GitHub folder root.
#
#   make help          list targets
#   make doctor        show each repo's type + available scripts
#   make sync          dry-run: what baseline files are missing
#   make sync-apply    create the missing baseline files
#   make drift         report files that differ from ai-template-repo
#   make lint | build | test | typecheck | format | audit
#   make status        git dirty/ahead-behind snapshot per repo
#   make health        lint+typecheck+build(+test), one pass/fail per repo
#   make git-doctor    find (and --fix removes) stray .git internal files/broken refs
#   make renovate-status   aggregate each repo's Dependency Dashboard backlog
#   make report        full morning report: dashboard + git health + secrets + renovate + live CI
#
# Target one repo:  make lint REPO=guess

.DEFAULT_GOAL := help
NODE := node
REPO ?=
REPOFLAG := $(if $(REPO),--repo=$(REPO),)

.PHONY: help doctor sync sync-apply drift dashboard new-repo lint build test typecheck format audit outdated status health git-doctor git-doctor-fix renovate-status report report-quick secrets-audit secrets-sync secrets-sync-apply

help:
	@echo "Meta-workspace targets:"
	@echo "  make doctor        show each repo's type + available scripts (+ lockfile drift)"
	@echo "  make status        git dirty/ahead-behind snapshot per repo"
	@echo "  make sync          dry-run: baseline files that would be created"
	@echo "  make sync-apply    create missing baseline files (non-destructive)"
	@echo "  make drift         report files that differ from the template"
	@echo "  make dashboard     generate dashboard.html (consistency scorecard)"
	@echo "  make new-repo NAME=x [TYPE=node|python]   scaffold a consistent new repo"
	@echo "  make lint|build|test|typecheck|format|audit   fan out across repos"
	@echo "  make health        lint+typecheck+build(+test) per repo, one pass/fail each"
	@echo "  make outdated      snapshot of outdated npm/pnpm deps per repo"
	@echo "  make secrets-audit         cross-check workflow secrets.X refs against configured GitHub secrets"
	@echo "  make secrets-sync         dry-run: what tools/sync-secrets.mjs would push from .secrets.local.json"
	@echo "  make secrets-sync-apply   actually push shared secrets via gh secret set"
	@echo "  make git-doctor            find stray .git internal files / broken refs (report only)"
	@echo "  make git-doctor-fix        same, but delete what it finds"
	@echo "  make renovate-status       aggregate each repo's Dependency Dashboard pending-update count"
	@echo "  make report                full morning report (dashboard + git health + secrets + renovate + live CI)"
	@echo "  make report-quick          same, local-only (no GitHub API calls)"
	@echo "  add REPO=name to scope to one repo (e.g. make lint REPO=guess)"

doctor:
	@$(NODE) tools/repo-run.mjs doctor $(REPOFLAG)

sync:
	@$(NODE) tools/sync-configs.mjs $(REPOFLAG)

sync-apply:
	@$(NODE) tools/sync-configs.mjs --apply $(REPOFLAG)

drift:
	@$(NODE) tools/sync-configs.mjs --drift $(REPOFLAG)

dashboard:
	@$(NODE) tools/dashboard.mjs --open

NAME ?=
TYPE ?= node
new-repo:
	@test -n "$(NAME)" || { echo "usage: make new-repo NAME=myrepo [TYPE=node|python]"; exit 2; }
	@$(NODE) tools/new-repo.mjs $(NAME) --type=$(TYPE) --apply

lint:
	@$(NODE) tools/repo-run.mjs lint $(REPOFLAG)

build:
	@$(NODE) tools/repo-run.mjs build $(REPOFLAG)

test:
	@$(NODE) tools/repo-run.mjs test $(REPOFLAG)

typecheck:
	@$(NODE) tools/repo-run.mjs typecheck $(REPOFLAG)

format:
	@$(NODE) tools/repo-run.mjs format $(REPOFLAG)

audit:
	@$(NODE) tools/repo-run.mjs audit $(REPOFLAG)

outdated:
	@$(NODE) tools/repo-run.mjs outdated $(REPOFLAG)

status:
	@$(NODE) tools/repo-run.mjs status $(REPOFLAG)

secrets-audit:
	@$(NODE) tools/audit-secrets.mjs $(REPOFLAG)

secrets-sync:
	@$(NODE) tools/sync-secrets.mjs $(REPOFLAG)

secrets-sync-apply:
	@$(NODE) tools/sync-secrets.mjs --apply $(REPOFLAG)

health:
	@$(NODE) tools/repo-run.mjs health $(REPOFLAG)

git-doctor:
	@$(NODE) tools/git-doctor.mjs $(REPOFLAG)

git-doctor-fix:
	@$(NODE) tools/git-doctor.mjs --fix $(REPOFLAG)

renovate-status:
	@$(NODE) tools/renovate-status.mjs $(REPOFLAG)

report:
	@$(NODE) tools/status.mjs

report-quick:
	@$(NODE) tools/status.mjs --quick
