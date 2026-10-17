package conversation

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/conversation/db"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// PickupLease is how long a pickup holds before the holder must renew it.
const PickupLease = 30 * time.Minute

// Errors of a pickup.
var (
	ErrNotOpen    = errors.New("that conversation is not open for pickup")
	ErrStaleFence = errors.New("this pickup was released")
)

// TakenError means another agent holds the pickup.
type TakenError struct{ Agent int64 }

func (e TakenError) Error() string { return "the conversation was picked up by another agent" }

// Assignment is a pickup in force: who holds it, from which session, and the fence that proves it.
type Assignment struct {
	Conversation, Agent, Session, Fence, PickedUpAt, LeaseUntil int64
}

// AssignmentOf returns the pickup in force; found is false when the conversation is not held.
func AssignmentOf(ctx context.Context, d pdb.DBTX, conv int64) (a Assignment, found bool, err error) {
	r, err := db.New(d).GetAssignment(ctx, conv)
	if errors.Is(err, sql.ErrNoRows) {
		return Assignment{}, false, nil
	}
	return Assignment{Conversation: r.ConversationID, Agent: r.AgentID, Session: r.SessionID.Int64, Fence: r.Fence, PickedUpAt: r.PickedUpAt, LeaseUntil: r.LeaseUntil}, err == nil, err
}

// OpenPickup offers the conversation to any agent that has the pickup scope (SEC-6).
func OpenPickup(ctx context.Context, d pdb.DBTX, now time.Time, conv, human int64) error {
	return db.New(d).OpenPickup(ctx, db.OpenPickupParams{At: sql.NullInt64{Int64: now.UnixMilli(), Valid: true}, By: sql.NullInt64{Int64: human, Valid: true}, ID: conv})
}

// Pickup lets an agent take a conversation that was opened for it. Exactly one caller wins: the writer runs one
// transaction at a time, so the second sees the first one's assignment and gets a TakenError. The fence is the
// conversation's assign_version, which counts up for ever (I-47).
func Pickup(ctx context.Context, d pdb.DBTX, now time.Time, conv, agent, session int64) (Assignment, error) {
	c, ok, err := Get(ctx, d, conv)
	if err != nil {
		return Assignment{}, err
	}
	if !ok || c.PickupOpenedAt == 0 {
		return Assignment{}, ErrNotOpen
	}
	if cur, held, err := AssignmentOf(ctx, d, conv); err != nil {
		return Assignment{}, err
	} else if held {
		return Assignment{}, TakenError{Agent: cur.Agent}
	}
	q := db.New(d)
	fence, err := q.NextAssignVersion(ctx, conv)
	if err != nil {
		return Assignment{}, err
	}
	at := now.UnixMilli()
	a := Assignment{Conversation: conv, Agent: agent, Session: session, Fence: fence, PickedUpAt: at, LeaseUntil: now.Add(PickupLease).UnixMilli()}
	err = q.InsertAssignment(ctx, db.InsertAssignmentParams{
		ConversationID: conv, AgentID: agent, SessionID: sql.NullInt64{Int64: session, Valid: session != 0}, Fence: fence, At: at, LeaseUntil: a.LeaseUntil,
	})
	return a, err
}

// Renew is the pickup-only action: it extends the hold when the caller still holds the pickup under this fence, and
// answers ErrStaleFence otherwise (the pickup was released and maybe taken by someone else).
func Renew(ctx context.Context, d pdb.DBTX, now time.Time, conv, agent, fence int64) error {
	n, err := db.New(d).RenewAssignment(ctx, db.RenewAssignmentParams{
		LeaseUntil: now.Add(PickupLease).UnixMilli(), ConversationID: conv, AgentID: agent, Fence: fence,
	})
	if err == nil && n == 0 {
		err = ErrStaleFence
	}
	return err
}

// ReleaseSessions frees every pickup the ended sessions held, so the conversations are open for pickup again. It
// returns the conversations that were freed. Every path that ends a lease calls it in the same transaction (I-38).
func ReleaseSessions(ctx context.Context, d pdb.DBTX, sessionIDs []int64) ([]int64, error) {
	var freed []int64
	for _, id := range sessionIDs {
		rows, err := db.New(d).DeleteAssignmentsOfSession(ctx, sql.NullInt64{Int64: id, Valid: true})
		if err != nil {
			return nil, err
		}
		freed = append(freed, rows...)
	}
	return freed, nil
}

// ReleaseOf frees the pickup an agent holds on one conversation (the agent was removed or left). It reports whether there was one.
func ReleaseOf(ctx context.Context, d pdb.DBTX, conv, agent int64) (bool, error) {
	rows, err := db.New(d).DeleteAssignmentOfAgent(ctx, db.DeleteAssignmentOfAgentParams{ConversationID: conv, AgentID: agent})
	return len(rows) > 0, err
}
