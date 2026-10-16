//go:build !testhooks

package httpapi

import (
	"net/http"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform"
)

func registerTestHooks(*http.ServeMux, *platform.DB) {}

// TestMaxMigration is 0 (no cap) in a release build.
func TestMaxMigration() int { return 0 }
