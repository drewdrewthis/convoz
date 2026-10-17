package ask

import (
	"context"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/ask/db"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// States maps ask message ids to their state, for the conversation page to label the ask messages.
func States(ctx context.Context, d pdb.DBTX, messageIDs []int64) (map[int64]string, error) {
	out := map[int64]string{}
	if len(messageIDs) == 0 {
		return out, nil
	}
	rows, err := db.New(d).AskStatesOf(ctx, messageIDs)
	if err != nil {
		return nil, err
	}
	for _, r := range rows {
		out[r.MessageID] = r.State
	}
	return out, nil
}
