//go:build !testhooks

package httpapi

import (
	"net/http"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

func registerTestHooks(*http.ServeMux, *db.Store) {}
