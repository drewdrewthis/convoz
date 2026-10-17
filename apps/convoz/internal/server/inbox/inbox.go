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
	MentionCount   int64 // how many of the item's messages mention the agent
	Deliveries     int64 // how many times a claim handed the item out
	Reason         string
	State          string // "ready" or "claimed"; a claim that has run out reads as "ready"
	ClaimToken     []byte // nil unless the item is claimed
	ClaimSession   int64
	ClaimUntil     int64 // when the claim runs out, unix ms; 0 for an item nobody holds
	Held           bool  // the session already held it: returned again with the same token, not a new delivery
}

func nullInt(v int64) sql.NullInt64 { return sql.NullInt64{Int64: v, Valid: v != 0} }

// Reasons of a conversation item. A ready item keeps the strongest one its messages gave it (C-10).
const (
	ReasonMention  = "mention"
	ReasonThread   = "thread"
	ReasonActivity = "activity"
	// ReasonAskResolved tells an agent its ask was answered, dismissed or deleted. It never merges with another item.
	ReasonAskResolved = "ask_resolved"
	// ReasonAppResult tells an agent the owner sent a result through its app. One item per result; it never merges.
	ReasonAppResult = "app_result"
)

// FanOut records one new main message for one agent participant: the ready item of that conversation takes the
// message, counts one more and keeps the strongest reason, or is made. sourceSeq is the seq of the message's event.
func FanOut(ctx context.Context, d pdb.DBTX, now time.Time, identityID, conversationID, messageID, sourceSeq int64, reason string) error {
	return db.New(d).UpsertConversationItem(ctx, db.UpsertConversationItemParams{
		IdentityID: identityID, Reason: reason, ConversationID: nullInt(conversationID), MessageID: nullInt(messageID), SourceSeq: sourceSeq, Now: now.UnixMilli(),
	})
}

// Request is a claim call. IncludeHeld asks for the items the session already holds before claiming new ones.
type Request struct {
	Identity    int64
	Session     int64
	N           int
	Visibility  time.Duration
	IncludeHeld bool
	Conv        int64 // 0 claims the items of every conversation
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
		held, err := q.HeldItems(ctx, db.HeldItemsParams{IdentityID: r.Identity, SessionID: nullInt(r.Session), Now: sql.NullInt64{Int64: nowMs, Valid: true}, Conv: r.Conv, MaxRows: int64(n)})
		if err != nil {
			return nil, err
		}
		for _, h := range held {
			out = append(out, Item{ID: h.ID, ConversationID: h.ConversationID.Int64, FirstMessageID: h.FirstMessageID.Int64, MessageID: h.MessageID.Int64,
				Count: h.Count, MentionCount: h.MentionCount, Deliveries: h.Deliveries, Reason: h.Reason, State: h.State, ClaimToken: h.ClaimToken, ClaimSession: r.Session, ClaimUntil: h.ClaimUntil.Int64, Held: true})
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
		SessionID: nullInt(r.Session), Now: nowMs, VisibilityMs: sql.NullInt64{Int64: vis.Milliseconds(), Valid: true}, IdentityID: r.Identity, Conv: r.Conv, NLeft: int64(n - len(out)),
	})
	if err != nil {
		return nil, err
	}
	for _, c := range claimed {
		out = append(out, Item{ID: c.ID, ConversationID: c.ConversationID.Int64, FirstMessageID: c.FirstMessageID.Int64, MessageID: c.MessageID.Int64,
			Count: c.Count, MentionCount: c.MentionCount, Deliveries: c.Deliveries, Reason: c.Reason, State: c.State, ClaimToken: c.ClaimToken, ClaimSession: r.Session, ClaimUntil: c.ClaimUntil.Int64})
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

// AskResolved tells an agent that its ask was resolved (answered, dismissed or deleted): one item for the ask (design §8.1).
func AskResolved(ctx context.Context, d pdb.DBTX, now time.Time, identityID, conversationID, askMessageID, sourceSeq int64) error {
	return db.New(d).InsertAskResolvedItem(ctx, db.InsertAskResolvedItemParams{
		IdentityID: identityID, ConversationID: nullInt(conversationID), AskMessageID: nullInt(askMessageID), SourceSeq: sourceSeq, Now: now.UnixMilli(),
	})
}

// AppResult tells an agent that the owner sent the result of its app (the via_app message): one item per result.
func AppResult(ctx context.Context, d pdb.DBTX, now time.Time, identityID, conversationID, messageID, sourceSeq int64) error {
	return db.New(d).InsertAppResultItem(ctx, db.InsertAppResultItemParams{
		IdentityID: identityID, ConversationID: nullInt(conversationID), MessageID: nullInt(messageID), SourceSeq: sourceSeq, Now: now.UnixMilli(),
	})
}

// AskOf is the ask an ask_resolved item of the identity is about; 0 for any other item.
func AskOf(ctx context.Context, d pdb.DBTX, identityID, id int64) (int64, error) {
	ask, err := db.New(d).AskOfItem(ctx, db.AskOfItemParams{ID: id, IdentityID: identityID})
	if errors.Is(err, sql.ErrNoRows) {
		return 0, nil
	}
	return ask.Int64, err
}

// Ack removes an item the session holds under token. It reports false (claim lost) for a wrong or old token, an
// expired claim, another session's item, or an item that was acked already (but an ask_resolved item acked again by its own session is fine). conversation is the item's conversation.
func Ack(ctx context.Context, d pdb.DBTX, now time.Time, identityID, sessionID, id int64, token []byte) (ok bool, conversation int64, err error) {
	q := db.New(d)
	conv, err := q.ItemConversation(ctx, db.ItemConversationParams{ID: id, IdentityID: identityID})
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return false, 0, err
	}
	n, err := q.AckItem(ctx, db.AckItemParams{Now: sql.NullInt64{Int64: now.UnixMilli(), Valid: true}, SessionID: nullInt(sessionID), ID: id, IdentityID: identityID, Token: token})
	if err != nil || n > 0 {
		return n > 0, conv.Int64, err
	}
	// A repeated ack of an ask_resolved item by the session that acked it is a no-op that succeeds (design §8.1): the claim token
	// is cleared by the first ack, so the session is what can be checked.
	again, err := q.AckedAskItem(ctx, db.AckedAskItemParams{ID: id, IdentityID: identityID, SessionID: nullInt(sessionID)})
	return again, conv.Int64, err
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
		it := Item{ID: r.ID, ConversationID: r.ConversationID.Int64, FirstMessageID: r.FirstMessageID.Int64, MessageID: r.MessageID.Int64, Count: r.Count, MentionCount: r.MentionCount, Deliveries: r.Deliveries, Reason: r.Reason, State: "ready"}
		if r.State == "claimed" && r.ClaimUntil.Int64 >= now.UnixMilli() {
			it.State, it.ClaimSession, it.ClaimUntil = "claimed", r.ClaimSessionID.Int64, r.ClaimUntil.Int64
			if r.ClaimSessionID.Int64 == sessionID {
				it.ClaimToken = r.ClaimToken
			}
		}
		out = append(out, it)
	}
	return out, nil
}

// Hold is a claim a session keeps on a conversation until Until (unix ms).
type Hold struct{ Conversation, Until int64 }

// Extend lengthens the claims of a session whose lease was renewed, up to the lease's own end (M8), and returns them.
func Extend(ctx context.Context, d pdb.DBTX, now time.Time, sessionID, leaseExpiresAt int64) ([]Hold, error) {
	rows, err := db.New(d).ExtendClaims(ctx, db.ExtendClaimsParams{Now: now.UnixMilli(), LeaseExpiresAt: leaseExpiresAt, SessionID: nullInt(sessionID)})
	out := make([]Hold, 0, len(rows))
	for _, r := range rows {
		out = append(out, Hold{Conversation: r.ConversationID.Int64, Until: r.ClaimUntil.Int64})
	}
	return out, err
}

// Released is a claim that was let go: whose it was and the conversation it was on.
type Released struct{ Identity, Conversation int64 }

// ReleaseSessions lets the claims of ending sessions run out at once and merges them back into the ready items
// of their conversations, so a peek right after shows one item per conversation. Every path that ends a lease calls
// it with the ended ids, in the same transaction. (A re-mint of the same client moves the claims instead: Transfer.)
func ReleaseSessions(ctx context.Context, d pdb.DBTX, now time.Time, sessionIDs []int64) ([]Released, error) {
	q := db.New(d)
	var out []Released
	seen := map[int64]bool{}
	for _, id := range sessionIDs {
		rows, err := q.ReleaseClaims(ctx, db.ReleaseClaimsParams{Now: sql.NullInt64{Int64: now.UnixMilli(), Valid: true}, SessionID: nullInt(id)})
		if err != nil {
			return nil, err
		}
		for _, r := range rows {
			out = append(out, Released{Identity: r.IdentityID, Conversation: r.ConversationID.Int64})
			seen[r.IdentityID] = true
		}
	}
	for identity := range seen {
		if err := mergeExpiredClaims(ctx, q, identity, now.UnixMilli()); err != nil {
			return nil, err
		}
	}
	return out, nil
}

// Transfer hands the live claims of the replaced sessions to the session that replaces them, tokens unchanged (M5).
func Transfer(ctx context.Context, d pdb.DBTX, now time.Time, from []int64, to int64) error {
	q := db.New(d)
	for _, id := range from {
		if err := q.TransferClaims(ctx, db.TransferClaimsParams{ToSession: nullInt(to), Now: now.UnixMilli(), FromSession: nullInt(id)}); err != nil {
			return err
		}
	}
	return nil
}

// HoldsLiveClaim reports whether the session has a claim that has not run out.
func HoldsLiveClaim(ctx context.Context, d pdb.DBTX, now time.Time, sessionID int64) (bool, error) {
	return db.New(d).HoldsLiveClaim(ctx, db.HoldsLiveClaimParams{SessionID: nullInt(sessionID), Now: sql.NullInt64{Int64: now.UnixMilli(), Valid: true}})
}

// HasExpiredClaims reports whether the identity has a claim that ran out and is not merged back yet.
func HasExpiredClaims(ctx context.Context, d pdb.DBTX, now time.Time, identityID int64) (bool, error) {
	ids, err := db.New(d).ExpiredClaimIDs(ctx, db.ExpiredClaimIDsParams{IdentityID: identityID, Now: sql.NullInt64{Int64: now.UnixMilli(), Valid: true}})
	return len(ids) > 0, err
}

// MergeExpired merges the identity's claims that ran out into the ready items of their conversations (M4). A peek
// calls it first, so the one-ready-item rule holds in what it shows.
func MergeExpired(ctx context.Context, d pdb.DBTX, now time.Time, identityID int64) error {
	return mergeExpiredClaims(ctx, db.New(d), identityID, now.UnixMilli())
}

// Release is ReleaseSessions for one session; it returns the conversations those claims were on.
func Release(ctx context.Context, d pdb.DBTX, now time.Time, sessionID int64) ([]int64, error) {
	rel, err := ReleaseSessions(ctx, d, now, []int64{sessionID})
	out := make([]int64, 0, len(rel))
	for _, r := range rel {
		out = append(out, r.Conversation)
	}
	return out, err
}

// ExpireNotVisible takes an item out of the queue because its message can no longer be shown to the agent.
func ExpireNotVisible(ctx context.Context, d pdb.DBTX, now time.Time, id int64) error {
	return db.New(d).ExpireNotVisible(ctx, db.ExpireNotVisibleParams{Now: now.UnixMilli(), ID: id})
}
