package upload

import (
	"context"

	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// searchReach bounds what the filter hands to a search statement: the newest this many messages.
const searchReach = 5000

// MessagesWithFiles lists the messages that carry an attachment (a voice note, an image or a file; an app bundle is not one),
// newest first, for the search filter has:file.
func MessagesWithFiles(ctx context.Context, d pdb.DBTX) ([]int64, error) {
	rows, err := d.QueryContext(ctx,
		`SELECT DISTINCT message_id FROM uploads WHERE message_id IS NOT NULL AND kind <> 'app' ORDER BY message_id DESC LIMIT ?`, searchReach)
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
