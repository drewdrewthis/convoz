//go:build testhooks

package auth

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/auth/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

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

// sourceNodeMigration is the migration that adds machines.source_node and machine_requests.source_node.
const sourceNodeMigration = 34

// beforeSourceNode plays the previous release when migrations are capped under 34: neither column is there, so the
// machine requests and the approval must not read or write it.
func beforeSourceNode() bool {
	c := platform.MaxMigrationCap()
	return c > 0 && c < sourceNodeMigration
}

// insertRequestBeforeSourceNode is InsertMachineRequest as the previous release wrote it, without the node.
func insertRequestBeforeSourceNode(ctx context.Context, d pdb.DBTX, p db.InsertMachineRequestParams) (id int64, old bool, err error) {
	if !beforeSourceNode() {
		return 0, false, nil
	}
	err = d.QueryRowContext(ctx, `INSERT INTO machine_requests (device_code_hash, user_code, requested_name, host_info, source, created_at, expires_at, poll_interval_ms)
VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
		p.DeviceCodeHash, p.UserCode, p.RequestedName, p.HostInfo, p.Source, p.CreatedAt, p.ExpiresAt, p.PollIntervalMs).Scan(&id)
	return id, true, err
}

// pendingRequestsBeforeSourceNode is ListPendingRequests as the previous release read it.
func pendingRequestsBeforeSourceNode(ctx context.Context, d pdb.DBTX, now time.Time) (out []Request, old bool, err error) {
	if !beforeSourceNode() {
		return nil, false, nil
	}
	rows, err := d.QueryContext(ctx, `SELECT id, user_code, requested_name, host_info, source, created_at, expires_at
FROM machine_requests WHERE state = 'pending' AND expires_at > ? ORDER BY created_at, id`, now.UnixMilli())
	if err != nil {
		return nil, true, err
	}
	defer rows.Close()
	for rows.Next() {
		r, err := scanOldRequest(rows)
		if err != nil {
			return nil, true, err
		}
		out = append(out, r)
	}
	return out, true, rows.Err()
}

// pendingRequestBeforeSourceNode is GetPendingRequest as the previous release read it.
func pendingRequestBeforeSourceNode(ctx context.Context, d pdb.DBTX, id int64, now time.Time) (Request, bool, error) {
	if !beforeSourceNode() {
		return Request{}, false, nil
	}
	r, err := scanOldRequest(d.QueryRowContext(ctx, `SELECT id, user_code, requested_name, host_info, source, created_at, expires_at
FROM machine_requests WHERE id = ? AND state = 'pending' AND expires_at > ?`, id, now.UnixMilli()))
	if errors.Is(err, sql.ErrNoRows) {
		return Request{}, true, ErrNoRequest
	}
	return r, true, err
}

func scanOldRequest(row interface{ Scan(...any) error }) (Request, error) {
	var r Request
	var host sql.NullString
	err := row.Scan(&r.ID, &r.UserCode, &r.Name, &host, &r.Source, &r.CreatedAt, &r.ExpiresAt)
	r.HostInfo = host.String
	return r, err
}
