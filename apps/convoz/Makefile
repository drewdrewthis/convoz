# Release build: no tags. Test build: -tags testhooks. Both are reproducible (-trimpath).
# Both embed the web app (apps/web, built into internal/server/console/web) and the CLIs (make cli-dist), so both build them first: no binary ships a stale UI or a CLI of another version.
GO ?= go
PNPM ?= pnpm
export GOFLAGS := -mod=readonly

.PHONY: build release testhooks web cli-dist sqlc sqlc-check lint-boundaries lint-go-imports lint-table-ownership
build: release testhooks

web:
	$(PNPM) --dir ../.. --filter web build

# The CLI for each platform the server hands out (/cli). The CLI-only main needs no cgo, so one host builds all four. They are
# embedded in the server, so release and testhooks build them first: a server serves exactly its own version of the CLI.
CLI_DIST = internal/server/clidist/cli
CLI_PLATFORMS = linux-amd64 linux-arm64 darwin-amd64 darwin-arm64

cli-dist: $(addprefix $(CLI_DIST)/convoz-,$(CLI_PLATFORMS))

$(CLI_DIST)/convoz-%: FORCE
	CGO_ENABLED=0 GOOS=$(word 1,$(subst -, ,$*)) GOARCH=$(word 2,$(subst -, ,$*)) $(GO) build -trimpath -ldflags="-s -w" -o $@ ./cmd/convoz-cli

FORCE:

release: web cli-dist
	$(GO) build -trimpath -o bin/convoz ./cmd/convoz

testhooks: web cli-dist
	$(GO) build -trimpath -tags testhooks -o bin/convoz-test ./cmd/convoz

# sqlc is pinned by the tool directive in go.mod; generated code is committed.
sqlc:
	$(GO) tool sqlc generate

sqlc-check:
	$(GO) tool sqlc diff

# Module boundaries (AC-16, Go side). CI runs the two checks as their own steps.
GO_IMPORTS = GO_BIN=$(GO) python3 -I ../../scripts/check_go_imports.py
TABLE_OWNERSHIP = python3 -I ../../scripts/check_table_ownership.py

lint-go-imports:
	$(GO_IMPORTS)

lint-table-ownership:
	$(TABLE_OWNERSHIP)

# Alone, this goal must exit 1 on a break and 0 when clean, but make exits 2 when a recipe fails.
# GNU make's question mode (-q) runs a "+" recipe and reports the recipe's own status, so a lone
# lint-boundaries runs in that mode. Next to other goals it runs normally (a break then exits 2).
ifeq ($(strip $(MAKECMDGOALS)),lint-boundaries)
MAKEFLAGS += -q
endif
lint-boundaries:
	+@fail=0; $(GO_IMPORTS) || fail=1; $(TABLE_OWNERSHIP) || fail=1; exit $$fail
