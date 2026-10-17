package conversation

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/conversation/db"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// StreakLimit is how many agent messages in a row pause a conversation (I-16). The DB CHECK "paused means 20" pins it.
const StreakLimit = 20

// The loop breaker's state lives in the conversation row (agent_streak, paused_at; I-16). The rule is the message
// module's (it knows what a message is); these functions only keep the two columns, so the DB CHECK "paused means 20" holds.

// LoopPaused reports whether agents are stopped in the conversation.
func LoopPaused(ctx context.Context, d pdb.DBTX, id int64) (bool, error) {
	r, err := db.New(d).LoopState(ctx, id)
	return r.PausedAt.Valid, err
}

// LoopCountAgentPost adds one agent message to the streak and reports whether it was the limit-th, which pauses the
// conversation. A conversation already at the limit is not counted again.
func LoopCountAgentPost(ctx context.Context, d pdb.DBTX, now time.Time, id int64, limit int) (paused bool, err error) {
	n, err := db.New(d).LoopCountAgentPost(ctx, db.LoopCountAgentPostParams{
		LimitStreak: int64(limit), At: sql.NullInt64{Int64: now.UnixMilli(), Valid: true}, ID: id,
	})
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return n == int64(limit), err
}

// LoopReset sets the streak to 0 and lifts a pause; it reports whether there was a pause.
func LoopReset(ctx context.Context, d pdb.DBTX, id int64) (wasPaused bool, err error) {
	q := db.New(d)
	was, err := q.LoopWasPaused(ctx, id)
	if err != nil {
		return false, err
	}
	_, err = q.LoopReset(ctx, id)
	return was, err
}

// AgentPosted counts one agent message toward the loop breaker and reports whether this message paused the conversation.
func AgentPosted(ctx context.Context, d pdb.DBTX, now time.Time, conv int64) (paused bool, err error) {
	return LoopCountAgentPost(ctx, d, now, conv, StreakLimit)
}

// HumanPosted (or a Resume) sets the streak back to 0 and lifts a pause. It reports whether a pause was lifted.
func HumanPosted(ctx context.Context, d pdb.DBTX, conv int64) (resumed bool, err error) {
	return LoopReset(ctx, d, conv)
}
