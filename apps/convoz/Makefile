# Release build: no tags. Test build: -tags testhooks. Both are reproducible (-trimpath).
GO ?= go
export GOFLAGS := -mod=readonly

.PHONY: build release testhooks
build: release testhooks

release:
	$(GO) build -trimpath -o bin/convoz ./cmd/convoz

testhooks:
	$(GO) build -trimpath -tags testhooks -o bin/convoz-test ./cmd/convoz
