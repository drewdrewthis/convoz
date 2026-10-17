package auth

import (
	"context"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/auth/db"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// Origin is the session label and the machine name behind a session id: what a reader sees next to a handoff note.
type Origin struct {
	Label   string
	Machine string
}

// SessionOrigins looks up the origin of each session id, ended sessions included (a note outlives its session).
func SessionOrigins(ctx context.Context, d pdb.DBTX, ids []int64) (map[int64]Origin, error) {
	out := make(map[int64]Origin, len(ids))
	if len(ids) == 0 {
		return out, nil
	}
	rows, err := db.New(d).SessionOrigins(ctx, ids)
	if err != nil {
		return nil, err
	}
	for _, r := range rows {
		out[r.ID] = Origin{Label: r.Label, Machine: r.MachineName}
	}
	return out, nil
}
