// Package inbox owns the inbox_items table: the queue an agent identity reads through `convoz watch` and `convoz inbox`.
// Items hold ids only; the composition root reads the message through canSee when it delivers one (design §3.8, I-43).
// Claim, ack, extend and release are the statements of §3.8, one transaction each (the caller's).
package inbox

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/inbox/db"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// Claim limits (design §3.8, §13).
const (
	MaxClaim          = 20
	MinVisibility     = 30 * time.Second
	MaxVisibility     = 30 * time.Minute
	DefaultVisibility = 5 * time.Minute
)

// Item is one inbox row as the claim and peek calls return it.
type Item struct {
	ID             int64
	ConversationID int64
	FirstMessageID int64
	MessageID      int64 // the newest message of the item
	Count          int64
	Reason         string
	State          string // "ready" or "claimed"; a claim that has run out reads as "ready"
	ClaimToken     []byte // nil unless the item is claimed
	ClaimSession   int64
	Held           bool // the session already held it: returned again with the same token, not a new delivery
}

func nullInt(v int64) sql.NullInt64 { return sql.NullInt64{Int64: v, Valid: v != 0} }

// FanOut records one new main message for one agent participant: the ready "activity" item of that conversation
// takes the message and counts one more, or is made. sourceSeq is the seq of the message's event.
func FanOut(ctx context.Context, d pdb.DBTX, now time.Time, identityID, conversationID, messageID, sourceSeq int64) error {
	return db.New(d).UpsertActivityItem(ctx, db.UpsertActivityItemParams{
		IdentityID: identityID, ConversationID: nullInt(conversationID), MessageID: nullInt(messageID), SourceSeq: sourceSeq, Now: now.UnixMilli(),
	})
}

// Request is a claim call. IncludeHeld asks for the items the session already holds before claiming new ones.
type Request struct {
	Identity    int64
	Session     int64
	N           int
	Visibility  time.Duration
	IncludeHeld bool
}

// Claim returns the items this session holds (when IncludeHeld) and then claims ready ones up to N in total.
// Items delivered five times leave the queue first, and claims that ran out merge back into the ready item of
// their conversation or become ready again, so another session can take them (M2, M4).
func Claim(ctx context.Context, d pdb.DBTX, now time.Time, r Request) ([]Item, error) {
	q := db.New(d)
	nowMs := now.UnixMilli()
	n := min(max(r.N, 1), MaxClaim)
	var out []Item
	if r.IncludeHeld {
		held, err := q.HeldItems(ctx, db.HeldItemsParams{IdentityID: r.Identity, SessionID: nullInt(r.Session), Now: sql.NullInt64{Int64: nowMs, Valid: true}, MaxRows: int64(n)})
		if err != nil {
			return nil, err
		}
		for _, h := range held {
			out = append(out, Item{ID: h.ID, ConversationID: h.ConversationID.Int64, FirstMessageID: h.FirstMessageID.Int64, MessageID: h.MessageID.Int64,
				Count: h.Count, Reason: h.Reason, State: h.State, ClaimToken: h.ClaimToken, ClaimSession: r.Session, Held: true})
		}
	}
	if len(out) >= n {
		return out, nil
	}
	if err := q.ExpirePoisonItems(ctx, db.ExpirePoisonItemsParams{Now: nowMs, IdentityID: r.Identity}); err != nil {
		return nil, err
	}
	if err := mergeExpiredClaims(ctx, q, r.Identity, nowMs); err != nil {
		return nil, err
	}
	vis := min(max(r.Visibility, MinVisibility), MaxVisibility)
	if r.Visibility == 0 {
		vis = DefaultVisibility
	}
	claimed, err := q.ClaimItems(ctx, db.ClaimItemsParams{
		SessionID: nullInt(r.Session), Now: nowMs, VisibilityMs: sql.NullInt64{Int64: vis.Milliseconds(), Valid: true}, IdentityID: r.Identity, NLeft: int64(n - len(out)),
	})
	if err != nil {
		return nil, err
	}
	for _, c := range claimed {
		out = append(out, Item{ID: c.ID, ConversationID: c.ConversationID.Int64, FirstMessageID: c.FirstMessageID.Int64, MessageID: c.MessageID.Int64,
			Count: c.Count, Reason: c.Reason, State: c.State, ClaimToken: c.ClaimToken, ClaimSession: r.Session})
	}
	return out, nil
}

// mergeExpiredClaims is §3.8 (3): each expired claim, in id order, merges into the ready item of its conversation
// (and is deleted) or becomes ready itself.
func mergeExpiredClaims(ctx context.Context, q *db.Queries, identityID, nowMs int64) error {
	ids, err := q.ExpiredClaimIDs(ctx, db.ExpiredClaimIDsParams{IdentityID: identityID, Now: sql.NullInt64{Int64: nowMs, Valid: true}})
	if err != nil {
		return err
	}
	for _, id := range ids {
		x, err := q.ExpiredClaim(ctx, id)
		merged := int64(0)
		if err == nil {
			merged, err = q.MergeIntoReady(ctx, db.MergeIntoReadyParams{
				FirstMessageID: x.FirstMessageID.Int64, Count: x.Count, MentionCount: x.MentionCount, MergedReason: x.Reason, Deliveries: x.Deliveries,
				Now: nowMs, IdentityID: x.IdentityID, ConversationID: x.ConversationID,
			})
		}
		if err != nil && !errors.Is(err, sql.ErrNoRows) { // no row: a voice or ask item, which never merges
			return err
		}
		if merged > 0 {
			err = q.DeleteItem(ctx, id)
		} else {
			err = q.MakeItemReady(ctx, db.MakeItemReadyParams{Now: nowMs, ID: id})
		}
		if err != nil {
			return err
		}
	}
	return nil
}

// Ack removes an item the session holds under token. It reports false (claim lost) for a wrong or old token, an
// expired claim, another session's item, or an item that was acked already. conversation is the item's conversation.
func Ack(ctx context.Context, d pdb.DBTX, now time.Time, identityID, sessionID, id int64, token []byte) (ok bool, conversation int64, err error) {
	q := db.New(d)
	conv, err := q.ItemConversation(ctx, db.ItemConversationParams{ID: id, IdentityID: identityID})
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return false, 0, err
	}
	n, err := q.AckItem(ctx, db.AckItemParams{Now: sql.NullInt64{Int64: now.UnixMilli(), Valid: true}, SessionID: nullInt(sessionID), ID: id, IdentityID: identityID, Token: token})
	return n > 0, conv.Int64, err
}

// Peek lists the identity's ready and claimed items without changing any. The token is set only on items the
// asking session holds.
func Peek(ctx context.Context, d pdb.DBTX, now time.Time, identityID, sessionID int64) ([]Item, error) {
	rows, err := db.New(d).PeekItems(ctx, identityID)
	if err != nil {
		return nil, err
	}
	out := make([]Item, 0, len(rows))
	for _, r := range rows {
		it := Item{ID: r.ID, ConversationID: r.ConversationID.Int64, FirstMessageID: r.FirstMessageID.Int64, MessageID: r.MessageID.Int64, Count: r.Count, Reason: r.Reason, State: "ready"}
		if r.State == "claimed" && r.ClaimUntil.Int64 >= now.UnixMilli() {
			it.State, it.ClaimSession = "claimed", r.ClaimSessionID.Int64
			if r.ClaimSessionID.Int64 == sessionID {
				it.ClaimToken = r.ClaimToken
			}
		}
		out = append(out, it)
	}
	return out, nil
}

// Extend lengthens the claims of a session whose lease was renewed, up to the lease's own end (M8).
func Extend(ctx context.Context, d pdb.DBTX, now time.Time, sessionID, leaseExpiresAt int64) error {
	return db.New(d).ExtendClaims(ctx, db.ExtendClaimsParams{Now: now.UnixMilli(), LeaseExpiresAt: leaseExpiresAt, SessionID: nullInt(sessionID)})
}

// Release lets the claims of an ending session run out at once; the next claim of the identity merges them back.
func Release(ctx context.Context, d pdb.DBTX, now time.Time, sessionID int64) error {
	return db.New(d).ReleaseClaims(ctx, db.ReleaseClaimsParams{Now: sql.NullInt64{Int64: now.UnixMilli(), Valid: true}, SessionID: nullInt(sessionID)})
}

// ExpireNotVisible takes an item out of the queue because its message can no longer be shown to the agent.
func ExpireNotVisible(ctx context.Context, d pdb.DBTX, now time.Time, id int64) error {
	return db.New(d).ExpireNotVisible(ctx, db.ExpireNotVisibleParams{Now: now.UnixMilli(), ID: id})
}
