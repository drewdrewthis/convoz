// Package platform owns the schema migrations, the clock and the test-hook switches.
// The encrypted SQLite file itself lives in the db subpackage.
package platform

import (
	"context"
	"database/sql"
	"errors"
	"strconv"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

const schemaVersionKey = "schema_version"

// SchemaVersion reads the stored schema version; 0 means a fresh database.
func SchemaVersion(ctx context.Context, s *db.Store) (int, error) {
	return schemaVersion(ctx, s.Reader.SQL())
}

func schemaVersion(ctx context.Context, q db.DBTX) (int, error) {
	var one int
	err := q.QueryRowContext(ctx, "SELECT 1 FROM sqlite_master WHERE type='table' AND name='system_kv'").Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	v, err := db.New(q).GetKV(ctx, schemaVersionKey)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && !v.Valid) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	return strconv.Atoi(v.String)
}

func setSchemaVersion(ctx context.Context, q *db.Queries, v int) error {
	return q.SetKV(ctx, db.SetKVParams{Key: schemaVersionKey, Value: sql.NullString{String: strconv.Itoa(v), Valid: true}})
}

// SetSchemaVersion overwrites the stored version. Only the test hooks and the runner call it.
func SetSchemaVersion(ctx context.Context, s *db.Store, v int) error {
	return s.Writer.Tx(ctx, func(q *db.Queries) error { return setSchemaVersion(ctx, q, v) })
}
