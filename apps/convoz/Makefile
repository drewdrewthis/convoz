# Release build: no tags. Test build: -tags testhooks. Both are reproducible (-trimpath).
GO ?= go
export GOFLAGS := -mod=readonly

.PHONY: build release testhooks sqlc sqlc-check
build: release testhooks

release:
	$(GO) build -trimpath -o bin/convoz ./cmd/convoz

testhooks:
	$(GO) build -trimpath -tags testhooks -o bin/convoz-test ./cmd/convoz

# sqlc is pinned by the tool directive in go.mod; generated code is committed.
sqlc:
	$(GO) tool sqlc generate

sqlc-check:
	$(GO) tool sqlc diff
