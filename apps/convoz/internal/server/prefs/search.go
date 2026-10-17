package prefs

import (
	"context"

	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// searchReach bounds what a filter hands to a search statement: the newest this many.
const searchReach = 5000

// Starred lists the conversations the person starred, for the search filter is:starred.
func Starred(ctx context.Context, d pdb.DBTX, identityID int64) ([]int64, error) {
	return ids(ctx, d, `SELECT conversation_id FROM conversation_prefs WHERE identity_id = ? AND starred_at IS NOT NULL`, identityID)
}

// Pinned lists the messages the person pinned, newest first, for the search filter is:pinned.
func Pinned(ctx context.Context, d pdb.DBTX, identityID int64) ([]int64, error) {
	return ids(ctx, d, `SELECT message_id FROM pins WHERE identity_id = ? ORDER BY message_id DESC LIMIT ?`, identityID, searchReach)
}

func ids(ctx context.Context, d pdb.DBTX, query string, args ...any) ([]int64, error) {
	rows, err := d.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}
