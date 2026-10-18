//go:build testhooks

package identity

import "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform"

// handleChangeMigration is the migration that creates handle_requests.
const handleChangeMigration = 22

// beforeHandleChange plays the previous release when migrations are capped under 22: that release has no handle_requests table,
// so Now must not read it.
func beforeHandleChange() bool {
	c := platform.MaxMigrationCap()
	return c > 0 && c < handleChangeMigration
}
