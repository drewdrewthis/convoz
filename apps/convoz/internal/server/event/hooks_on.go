//go:build testhooks

package event

import (
	"context"
	"encoding/json"
	"strings"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// appendAsPreviousRelease plays the S1b release when migrations are capped before 7: its events table still has the
// old shape (no version on the type), so the migration test can start from rows that release wrote.
func appendAsPreviousRelease(ctx context.Context, d pdb.DBTX, now time.Time, typ string, payload any) (int64, bool, error) {
	if c := platform.MaxMigrationCap(); c <= 0 || c >= 7 {
		return 0, false, nil
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return 0, true, err
	}
	var id int64
	err = d.QueryRowContext(ctx, "INSERT INTO events (type, payload, created_at) VALUES (?1, ?2, ?3) RETURNING id",
		strings.TrimSuffix(typ, ".v1"), string(raw), now.UnixMilli()).Scan(&id)
	return id, true, err
}
