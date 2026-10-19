package auth

import (
	"context"
	"database/sql"
	"errors"

	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// setMachineSource records the node a machine was approved from; an unknown node stores nothing.
func setMachineSource(ctx context.Context, d pdb.DBTX, machineID int64, source string) error {
	if source == "" || beforeSourceNode() {
		return nil
	}
	_, err := d.ExecContext(ctx, `UPDATE machines SET source_node = ? WHERE id = ?`, source, machineID)
	return err
}

// machineSource is the node a machine was approved from; empty when none was stored.
func machineSource(ctx context.Context, d pdb.DBTX, machineID int64) (string, error) {
	if beforeSourceNode() {
		return "", nil
	}
	var s sql.NullString
	if err := d.QueryRowContext(ctx, `SELECT source_node FROM machines WHERE id = ?`, machineID).Scan(&s); err != nil {
		return "", err
	}
	return s.String, nil
}

// activeMachineIDNamed is the id of the active machine called name, or 0.
func activeMachineIDNamed(ctx context.Context, d pdb.DBTX, name string) (int64, error) {
	var id int64
	err := d.QueryRowContext(ctx, `SELECT id FROM machines WHERE name = ? AND revoked_at IS NULL`, name).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, nil
	}
	return id, err
}
