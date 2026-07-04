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
#
# Target one repo:  make lint REPO=guess

.DEFAULT_GOAL := help
NODE := node
REPO ?=
REPOFLAG := $(if $(REPO),--repo=$(REPO),)

.PHONY: help doctor sync sync-apply drift dashboard new-repo lint build test typecheck format audit outdated status

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
	@echo "  make outdated      snapshot of outdated npm/pnpm deps per repo"
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
