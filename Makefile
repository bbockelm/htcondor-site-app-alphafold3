# Site app build. `make help` lists the targets.
#
# APP decides the bundle's file name, and the bundle's file name decides
# the app's id and URL on the access point. Override it to deploy the
# same source as a second app: `make bundle APP=cryoem-next`.
APP ?= $(notdir $(CURDIR))

# The API server to proxy to in development, and to test against.
API ?= https://localhost:8443
# Images used by `make e2e`. Two, because demo mode runs a personal
# HTCondor and the published API image carries only the Go binary --
# see the header of scripts/e2e.sh.
#
# `latest` is the newest RELEASE of the API server, which is what a
# site runs. (This repository's own CI overrides it with `devel`, the
# server's main branch, because the two are developed together.) Pin a
# release tag in your own repo.
API_IMAGE ?= ghcr.io/bbockelm/golang-htcondor:latest
POOL_IMAGE ?= htcondor/mini:latest
# Where demo mode writes its generated passwords, inside the container.
DEMO_CREDS ?= /tmp/htcondor-demo-credentials.json

NPM := npm --prefix web

.DEFAULT_GOAL := help
.PHONY: help install dev build bundle test e2e lint fmt check clean openapi

help: ## List targets
	@grep -hE '^[a-z][a-zA-Z0-9_-]*:.*?## ' $(MAKEFILE_LIST) \
		| awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

install: web/node_modules ## Install dependencies

web/node_modules: web/package-lock.json web/package.json
	$(NPM) ci
	@touch web/node_modules

dev: install ## Dev server on :5173, proxying /api and /login to $(API)
	VITE_API_TARGET=$(API) $(NPM) run dev

build: install ## Production build into web/dist
	$(NPM) run build

test: install ## Unit tests
	$(NPM) run test

lint: install ## Lint and typecheck
	$(NPM) run lint
	$(NPM) run typecheck

fmt: install ## Format
	$(NPM) run format

check: lint test build ## Everything CI runs before e2e

# The deliverable: one zip plus its digest.
#
# -X and the fixed timestamps make the bundle REPRODUCIBLE -- the same
# source produces the same bytes and therefore the same digest. That is
# what lets an operator check that the zip on the access point is the one
# built from a given commit, rather than only that it arrived intact.
bundle: build ## Package dist/$(APP).zip and dist/$(APP).zip.sha256
	rm -rf dist/stage dist/$(APP).zip dist/$(APP).zip.sha256
	mkdir -p dist/stage/web
	cp app.yaml dist/stage/
	cp -R web/dist/. dist/stage/web/
	find dist/stage -exec touch -t 198001010000 {} +
	cd dist/stage && zip -qrX ../$(APP).zip .
	cd dist && shasum -a 256 $(APP).zip > $(APP).zip.sha256
	@rm -rf dist/stage
	@echo
	@echo "  dist/$(APP).zip"
	@cat dist/$(APP).zip.sha256
	@echo
	@echo "  Deploy:  scp dist/$(APP).zip dist/$(APP).zip.sha256 AP:/etc/condor/webapps/"
	@echo "  Then the operator names the groups that may see it, once, in the"
	@echo "  access point's configuration: HTTP_API_SITE_APP_$(shell printf '%s' "$(APP)" | tr 'a-z-' 'A-Z_')_GROUPS"

e2e: install bundle ## Playwright against a demo API server in Docker
	./scripts/e2e.sh

# The committed openapi.json is what AGENTS.md tells you to consult
# instead of guessing at endpoints. It is a copy, so it can rot; this
# refreshes it from a running server and fails if the result is not
# valid JSON.
openapi: ## Refresh openapi.json from a running server (API=https://...)
	@curl -ksSf "$(API)/openapi.json" -o openapi.json.new
	@python3 -c "import json; d=json.load(open('openapi.json.new')); assert 'paths' in d and 'components' in d, 'not an OpenAPI document'" || { echo "not an OpenAPI document; leaving openapi.json alone"; rm -f openapi.json.new; exit 1; }
	@mv openapi.json.new openapi.json
	@echo "openapi.json refreshed from $(API)"

clean: ## Remove build output
	rm -rf web/dist dist test-results playwright-report
