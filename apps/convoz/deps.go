//go:build deps

// The libraries the later modules use, pinned now (the foundation work package adds every known dependency, so no
// parallel work package edits go.mod). This file builds only with -tags deps; each blank import goes once its module
// imports the package for real.
package deps

import (
	_ "github.com/SherClockHolmes/webpush-go"  // notify: web push (VAPID)
	_ "github.com/andybalholm/brotli"          // platform: response compression
	_ "github.com/evanw/esbuild/pkg/api"       // appkit: Tier 2 app bundling
	_ "github.com/tink-crypto/tink-go/v2/aead" // upload: streaming segment encryption
	_ "github.com/yuin/goldmark"               // message: server-side markdown checks
)
