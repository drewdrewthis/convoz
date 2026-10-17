package inbox

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/inbox/db"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// Handoff limits (design §3.8): a note is bytes, so it always fits section 2 of the brief whole (M7).
const (
	MaxHandoffBytes = 4096
	KeepHandoffs    = 50
)

// ErrHandoffSize means the note is empty or longer than MaxHandoffBytes.
var ErrHandoffSize = errors.New("a handoff note is 1 to 4096 bytes")

// Handoff is a note one session of an agent left for the next one. SessionID names the session and so the machine.
type Handoff struct {
	ID        int64
	Identity  int64
	SessionID int64
	Body      string
	ClientID  string
	CreatedAt int64
}

func handoffOf(r db.Handoff) Handoff {
	return Handoff{ID: r.ID, Identity: r.IdentityID, SessionID: r.SessionID, Body: r.Body, ClientID: r.ClientID, CreatedAt: r.CreatedAt}
}

// AddHandoff stores a note. A repeat of the same client id returns the stored note and created false (I-24). The identity
// keeps its newest KeepHandoffs notes.
func AddHandoff(ctx context.Context, d pdb.DBTX, now time.Time, identity, session int64, body, clientID string) (h Handoff, created bool, err error) {
	if len(body) < 1 || len(body) > MaxHandoffBytes {
		return Handoff{}, false, ErrHandoffSize
	}
	q := db.New(d)
	n, err := q.InsertHandoff(ctx, db.InsertHandoffParams{IdentityID: identity, SessionID: session, Body: body, ClientID: clientID, Now: now.UnixMilli()})
	if err != nil {
		return Handoff{}, false, err
	}
	if n > 0 {
		first, err := q.HandoffCutoff(ctx, db.HandoffCutoffParams{IdentityID: identity, Skip: KeepHandoffs - 1})
		switch {
		case errors.Is(err, sql.ErrNoRows): // fewer notes than the limit: nothing to drop
		case err != nil:
			return Handoff{}, false, err
		default:
			if err := q.DeleteHandoffsBefore(ctx, db.DeleteHandoffsBeforeParams{IdentityID: identity, FirstKept: first}); err != nil {
				return Handoff{}, false, err
			}
		}
	}
	row, err := q.HandoffByClient(ctx, db.HandoffByClientParams{IdentityID: identity, ClientID: clientID})
	return handoffOf(row), n > 0, err
}

// Handoffs lists the identity's notes, newest first, at most max.
func Handoffs(ctx context.Context, d pdb.DBTX, identity int64, max int) ([]Handoff, error) {
	rows, err := db.New(d).ListHandoffs(ctx, db.ListHandoffsParams{IdentityID: identity, MaxRows: int64(max)})
	if err != nil {
		return nil, err
	}
	out := make([]Handoff, len(rows))
	for i, r := range rows {
		out[i] = handoffOf(r)
	}
	return out, nil
}

// HandoffCount is how many notes the identity keeps.
func HandoffCount(ctx context.Context, d pdb.DBTX, identity int64) (int64, error) {
	return db.New(d).CountHandoffs(ctx, identity)
}

// ExpiredGroup is the items of one conversation that expired unread, and when the first of them did (unix ms).
type ExpiredGroup struct {
	Conversation int64
	Count        int64
	Since        int64
}

// ExpiredUnread lists the items that left the identity's queue unread, one group per conversation, oldest first.
func ExpiredUnread(ctx context.Context, d pdb.DBTX, identity int64) ([]ExpiredGroup, error) {
	rows, err := db.New(d).ExpiredUnread(ctx, identity)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}
	out := make([]ExpiredGroup, len(rows))
	for i, r := range rows {
		since, _ := r.Since.(int64)
		out[i] = ExpiredGroup{Conversation: r.ConversationID.Int64, Count: r.N, Since: since}
	}
	return out, nil
}
