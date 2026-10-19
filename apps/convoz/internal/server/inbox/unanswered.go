package inbox

import (
	"context"
	"database/sql"
	"slices"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/inbox/db"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// UnansweredAfter is how long the owner's last message may sit with no answer before the agents are reminded (owner msgs 818, 821).
const UnansweredAfter = 10 * time.Minute

// dueBatch bounds one sweep; the rest is due on the next one.
const dueBatch = 100

// Place is where a conversation is read: its main chat (ThreadRoot 0) or one thread, keyed by the thread root.
type Place struct{ Conversation, ThreadRoot int64 }

// Reminder is a place whose newest counted message is the owner's, and that waited long enough: Message is that message.
type Reminder struct {
	Place
	Message int64
}

// OwnerSpoke notes the owner's message as the newest counted message of its place: it is due for a reminder UnansweredAfter after
// createdAt (unix ms), and an older message of the place is forgotten (a newer one restarts the wait).
func OwnerSpoke(ctx context.Context, d pdb.DBTX, p Place, messageID, createdAt int64) error {
	return db.New(d).TrackPlace(ctx, db.TrackPlaceParams{ConversationID: p.Conversation, ThreadRootID: p.ThreadRoot, MessageID: messageID, DueAt: createdAt + UnansweredAfter.Milliseconds()})
}

// Answered notes that someone else posted a counted message in the place: nothing waits there any more.
func Answered(ctx context.Context, d pdb.DBTX, p Place) error {
	return db.New(d).ClearPlace(ctx, db.ClearPlaceParams{ConversationID: p.Conversation, ThreadRootID: p.ThreadRoot})
}

// Due lists the places whose reminder is due at now, oldest first. It reads the due_at index only.
func Due(ctx context.Context, d pdb.DBTX, now time.Time) ([]Reminder, error) {
	rows, err := db.New(d).DuePlaces(ctx, db.DuePlacesParams{Now: now.UnixMilli(), MaxRows: dueBatch})
	out := make([]Reminder, 0, len(rows))
	for _, r := range rows {
		out = append(out, Reminder{Place: Place{Conversation: r.ConversationID, ThreadRoot: r.ThreadRootID}, Message: r.MessageID})
	}
	return out, err
}

// Remind makes the unanswered item of the reminder's message for one agent.
func Remind(ctx context.Context, d pdb.DBTX, now time.Time, identityID int64, r Reminder) error {
	return db.New(d).InsertUnansweredItem(ctx, db.InsertUnansweredItemParams{IdentityID: identityID, ConversationID: sql.NullInt64{Int64: r.Conversation, Valid: true}, MessageID: nullInt(r.Message), Now: now.UnixMilli()})
}

// Reminded ends the wait of the place: its reminder is sent (or has nobody to go to). Call it in the transaction of Remind.
func Reminded(ctx context.Context, d pdb.DBTX, p Place) error { return Answered(ctx, d, p) }

// Targets are the agents a reminder goes to, from agents (the enabled agent participants), the agents the message @mentions and,
// for a thread, the identities that posted in it. The mentioned agents when there are any; else for a thread its agent posters;
// else every agent. The order of agents is kept.
func Targets(agents, mentioned, posters []int64, inThread bool) []int64 {
	pick := func(from []int64) []int64 {
		var out []int64
		for _, a := range agents {
			if slices.Contains(from, a) {
				out = append(out, a)
			}
		}
		return out
	}
	if out := pick(mentioned); len(out) > 0 {
		return out
	}
	if inThread {
		if out := pick(posters); len(out) > 0 {
			return out
		}
	}
	return agents
}
