//go:build testhooks

package auth

import "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform"

// identityRequestsMigration is the migration that creates identity_requests.
const identityRequestsMigration = 20

// beforeIdentityRequests plays the previous release when migrations are capped under 20: that release has no
// identity_requests table, so the machine request list and the approval must not read it.
func beforeIdentityRequests() bool {
	c := platform.MaxMigrationCap()
	return c > 0 && c < identityRequestsMigration
}

// viaInternetMigration is the migration that adds identity_requests.via_internet.
const viaInternetMigration = 25

// beforeViaInternet plays the previous release when migrations are capped under 25: the column is not there.
func beforeViaInternet() bool {
	c := platform.MaxMigrationCap()
	return c > 0 && c < viaInternetMigration
}

// invitesMigration is the migration that creates agent_invites.
const invitesMigration = 26

// beforeInvites plays the previous release when migrations are capped under 26: the table is not there.
func beforeInvites() bool {
	c := platform.MaxMigrationCap()
	return c > 0 && c < invitesMigration
}
