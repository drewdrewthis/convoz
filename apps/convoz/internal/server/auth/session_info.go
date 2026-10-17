package auth

import (
	"context"
	"database/sql"
	"errors"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/auth/db"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// SessionOrigin says where a session ran: its label and the machine's name.
type SessionOrigin struct{ Label, Machine string }

// OriginOf returns the label and machine of a session; ok is false for an unknown id.
func OriginOf(ctx context.Context, d pdb.DBTX, sessionID int64) (o SessionOrigin, ok bool, err error) {
	r, err := db.New(d).SessionLabelAndMachine(ctx, sessionID)
	if errors.Is(err, sql.ErrNoRows) {
		return SessionOrigin{}, false, nil
	}
	return SessionOrigin{Label: r.Label, Machine: r.MachineName}, err == nil, err
}
