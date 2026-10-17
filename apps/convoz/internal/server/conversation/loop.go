package conversation

import (
	"context"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/conversation/db"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// StreakLimit is how many agent messages in a row pause a conversation (I-16).
const StreakLimit = 20

// AgentPosted counts one agent message toward the loop breaker and reports whether this message paused the conversation.
func AgentPosted(ctx context.Context, d pdb.DBTX, now time.Time, conv int64) (paused bool, err error) {
	before, ok, err := Get(ctx, d, conv)
	if err != nil || !ok {
		return false, err
	}
	row, err := db.New(d).BumpAgentStreak(ctx, db.BumpAgentStreakParams{At: nullAt(now), ID: conv})
	if err != nil {
		return false, err
	}
	return before.PausedAt == 0 && row.PausedAt.Valid, nil
}

// HumanPosted (or a Resume) sets the streak back to 0 and lifts a pause. It reports whether a pause was lifted.
func HumanPosted(ctx context.Context, d pdb.DBTX, conv int64) (resumed bool, err error) {
	before, ok, err := Get(ctx, d, conv)
	if err != nil || !ok {
		return false, err
	}
	return before.PausedAt != 0, db.New(d).ResetAgentStreak(ctx, conv)
}
