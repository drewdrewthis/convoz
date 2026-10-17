package httpapi

import (
	"context"
	"encoding/hex"
	"net/http"
	"strconv"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/auth"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/authz"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/conversation"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/inbox"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/message"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

// inboxPoll is GET /api/inbox?wait=&claim=&visibility=&peek=&held=&conv=.
//
// Without peek it answers the items this session holds, then claims ready ones, and when there are none and wait
// is above 0 it holds the request until an item for the identity arrives or wait runs out. held=0 leaves the
// already-held items out: `convoz watch` prints each claim once, so it asks only for new ones and the poll does not
// return at once for an item the agent has not acked yet. conv=C claims only the items of conversation C.
func (s *Server) inboxPoll(w http.ResponseWriter, r *http.Request, c *call) {
	q := r.URL.Query()
	wait, ok := waitParam(w, q.Get("wait"))
	if !ok {
		return
	}
	n, vis, ok := claimLimits(w, q.Get("claim"), q.Get("visibility"))
	if !ok {
		return
	}
	conv, ok := convParam(w, q.Get("conv"))
	if !ok {
		return
	}
	if q.Get("peek") == "1" {
		s.inboxPeek(w, r, c)
		return
	}
	req := inbox.Request{Identity: c.lease.IdentityID, Session: c.lease.SessionID, N: n, Visibility: vis, IncludeHeld: q.Get("held") != "0", Conv: conv}

	hold := time.NewTimer(wait)
	defer hold.Stop()
	for {
		changed := s.Bus.ChangedFor(req.Identity) // before the claim, so an item that lands meanwhile wakes the next wait
		anyChange := s.Bus.Changed()
		if s.answerIfEnded(w, r, c) {
			return
		}
		items, fresh, err := s.claimOnce(r.Context(), c, req)
		if err != nil {
			if r.Context().Err() == nil {
				s.internalError(w, r, err)
			}
			return
		}
		if len(items) > 0 || wait == 0 {
			s.publishFresh(r.Context(), req.Identity, fresh)
			writeJSON(w, http.StatusOK, wire.InboxResponse{Items: append([]wire.InboxItem{}, items...)})
			return
		}
		for waiting := true; waiting; {
			select {
			case <-changed:
				waiting = false
			case <-anyChange: // something changed somewhere, maybe this lease (a key was regenerated): look at the lease only
				anyChange = s.Bus.Changed()
				if s.answerIfEnded(w, r, c) {
					return
				}
			case <-hold.C:
				writeJSON(w, http.StatusOK, wire.InboxResponse{Items: []wire.InboxItem{}})
				return
			case <-r.Context().Done():
				return
			}
		}
	}
}

// claimInbox is POST /api/inbox/claim {n, visibility, conv}: the same claim as the poll, without waiting.
func (s *Server) claimInbox(w http.ResponseWriter, r *http.Request, c *call) {
	var in wire.ClaimRequest
	if !decode(w, r, &in) {
		return
	}
	rawN := ""
	if in.N != 0 {
		rawN = strconv.Itoa(in.N)
	}
	n, vis, ok := claimLimits(w, rawN, in.Visibility)
	if !ok {
		return
	}
	if in.Conv < 0 {
		writeFieldErr(w, http.StatusBadRequest, "invalid_request", "conv", "conv is a conversation id.")
		return
	}
	req := inbox.Request{Identity: c.lease.IdentityID, Session: c.lease.SessionID, N: n, Visibility: vis, IncludeHeld: true, Conv: in.Conv}
	items, fresh, err := s.claimOnce(r.Context(), c, req)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	s.publishFresh(r.Context(), req.Identity, fresh)
	writeJSON(w, http.StatusOK, wire.InboxResponse{Items: append([]wire.InboxItem{}, items...)})
}

// publishFresh tells the owner's screen that the agent started working on each conversation it just claimed.
func (s *Server) publishFresh(ctx context.Context, identity int64, fresh []inbox.Hold) {
	for _, h := range fresh {
		s.publishWorking(ctx, identity, h.Conversation, true, h.Until)
	}
}

// claimLimits reads claim= (1 to 20, default 20) and visibility= (30s to 30m, default 5m). It answers 400 itself.
func claimLimits(w http.ResponseWriter, rawN, rawVis string) (n int, vis time.Duration, ok bool) {
	n, vis = inbox.MaxClaim, inbox.DefaultVisibility
	if rawN != "" {
		v, err := strconv.Atoi(rawN)
		if err != nil || v < 1 || v > inbox.MaxClaim {
			writeFieldErr(w, http.StatusBadRequest, "invalid_request", "claim", "claim is 1 to 20.")
			return 0, 0, false
		}
		n = v
	}
	if rawVis != "" {
		v, err := time.ParseDuration(rawVis)
		if err != nil || v < inbox.MinVisibility || v > inbox.MaxVisibility {
			writeFieldErr(w, http.StatusBadRequest, "invalid_request", "visibility", "visibility is a duration from 30s to 30m.")
			return 0, 0, false
		}
		vis = v
	}
	return n, vis, true
}

// convParam reads conv=: a conversation id, or 0 for every conversation.
func convParam(w http.ResponseWriter, raw string) (int64, bool) {
	if raw == "" {
		return 0, true
	}
	v, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || v < 1 {
		writeFieldErr(w, http.StatusBadRequest, "invalid_request", "conv", "conv is a conversation id.")
		return 0, false
	}
	return v, true
}

// answerIfEnded answers 401 session_ended when the lease behind the call no longer works. It reports whether it did,
// or failed (then it wrote the error).
func (s *Server) answerIfEnded(w http.ResponseWriter, r *http.Request, c *call) bool {
	msg, ended, err := s.leaseEnded(r.Context(), c.token)
	switch {
	case err != nil:
		s.internalError(w, r, err)
		return true
	case ended:
		writeErr(w, http.StatusUnauthorized, wire.CodeSessionEnded, msg)
		return true
	}
	return false
}

// waitParam reads wait= as whole seconds, capped at the longest hold.
func waitParam(w http.ResponseWriter, raw string) (time.Duration, bool) {
	if raw == "" {
		return 0, true
	}
	secs, err := strconv.Atoi(raw)
	if err != nil || secs < 0 {
		writeFieldErr(w, http.StatusBadRequest, "invalid_request", "wait", "wait is a number of seconds, 0 or more.")
		return 0, false
	}
	return min(time.Duration(secs), wire.MaxHoldSeconds) * time.Second, true
}

// leaseEnded reports whether the lease behind token no longer works, and why in words for the person running the agent.
func (s *Server) leaseEnded(ctx context.Context, token string) (msg string, ended bool, err error) {
	_, dead, ok, err := auth.LookupLease(ctx, s.reader(), token, s.Clock.Now())
	switch {
	case err != nil:
		return "", false, err
	case dead != nil:
		return sessionEndedMessage(dead.Reason), true, nil
	case !ok:
		return sessionEndedMessage(""), true, nil
	}
	return "", false, nil
}

// claimOnce is one claim call in one transaction. fresh lists the claims made just now (not held before).
func (s *Server) claimOnce(ctx context.Context, c *call, req inbox.Request) (items []wire.InboxItem, fresh []inbox.Hold, err error) {
	now := s.Clock.Now()
	err = s.Store.Writer.Tx(ctx, func(ctx context.Context, tx *pdb.Tx) error {
		d := tx.DBTX()
		claimed, err := inbox.Claim(ctx, d, now, req)
		if err != nil {
			return err
		}
		if items, err = s.deliver(ctx, d, now, c.p, claimed, true); err != nil {
			return err
		}
		delivered := map[int64]bool{}
		for _, it := range items {
			delivered[it.ID] = true
		}
		for _, it := range claimed {
			if !it.Held && delivered[it.ID] {
				fresh = append(fresh, inbox.Hold{Conversation: it.ConversationID, Until: it.ClaimUntil})
			}
		}
		return nil
	})
	return items, fresh, err
}

// inboxPeek lists the identity's ready and claimed items and claims none. Claims that ran out are merged back first,
// so what it shows keeps the one-ready-item rule.
func (s *Server) inboxPeek(w http.ResponseWriter, r *http.Request, c *call) {
	ctx, d, now := r.Context(), s.reader(), s.Clock.Now()
	err := s.mergeExpired(ctx, c.lease.IdentityID, now)
	var peeked []inbox.Item
	if err == nil {
		peeked, err = inbox.Peek(ctx, d, now, c.lease.IdentityID, c.lease.SessionID)
	}
	var items []wire.InboxItem
	if err == nil {
		items, err = s.deliver(ctx, d, now, c.p, peeked, false)
	}
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, wire.InboxResponse{Items: append([]wire.InboxItem{}, items...)})
}

// mergeExpired writes only when a claim has run out, so a peek that finds none stays a read.
func (s *Server) mergeExpired(ctx context.Context, identity int64, now time.Time) error {
	has, err := inbox.HasExpiredClaims(ctx, s.reader(), now, identity)
	if err != nil || !has {
		return err
	}
	return s.Store.Writer.Tx(ctx, func(ctx context.Context, tx *pdb.Tx) error {
		return inbox.MergeExpired(ctx, tx.DBTX(), now, identity)
	})
}

// touchClaims is M8: any call of a session that holds claims extends them (up to the end of its lease), so a session
// that is alive and busy does not lose its items to another session. Called for every lease call.
func (s *Server) touchClaims(ctx context.Context, l auth.Lease, now time.Time) error {
	holds, err := inbox.HoldsLiveClaim(ctx, s.reader(), now, l.SessionID)
	if err != nil || !holds {
		return err
	}
	var extended []inbox.Hold
	err = s.Store.Writer.Tx(ctx, func(ctx context.Context, tx *pdb.Tx) error {
		var err error
		extended, err = inbox.Extend(ctx, tx.DBTX(), now, l.SessionID, l.ExpiresAt)
		return err
	})
	for _, h := range extended {
		s.publishWorking(ctx, l.IdentityID, h.Conversation, true, h.Until)
	}
	return err
}

// deliver reads each item's newest message through canSee and builds the wire items. An item whose message the agent
// can no longer see is dropped, and with expire set it also leaves the queue (design §3.8).
func (s *Server) deliver(ctx context.Context, d pdb.DBTX, now time.Time, p authz.Principal, items []inbox.Item, expire bool) ([]wire.InboxItem, error) {
	dir, err := loadDirectory(ctx, d)
	if err != nil {
		return nil, err
	}
	out := make([]wire.InboxItem, 0, len(items))
	for _, it := range items {
		cv, found, err := conversation.Get(ctx, d, it.ConversationID)
		if err != nil {
			return nil, err
		}
		floor, visible, err := canSee(ctx, d, p, it.ConversationID)
		if err != nil {
			return nil, err
		}
		m, have, err := message.Get(ctx, d, it.MessageID)
		if err != nil {
			return nil, err
		}
		if !found || !visible || !have || m.ID <= floor {
			if expire {
				if err := inbox.ExpireNotVisible(ctx, d, now, it.ID); err != nil {
					return nil, err
				}
			}
			continue
		}
		wi := wire.InboxItem{ID: it.ID, State: it.State, Reason: it.Reason, Count: it.Count, MentionCount: it.MentionCount, Deliveries: it.Deliveries, Conversation: wire.InboxConversation{ID: cv.ID}, Message: dir.message(m)}
		if cv.Title != "" {
			title := cv.Title
			wi.Conversation.Title = &title
		}
		if it.ClaimToken != nil {
			wi.ClaimToken = hex.EncodeToString(it.ClaimToken)
		}
		out = append(out, wi)
	}
	return out, nil
}

// maxAckItems bounds one ack call to what one claim can return.
const maxAckItems = inbox.MaxClaim

// ackInbox is POST /api/inbox/ack: per item "ok", or "claim_lost" for a wrong or old token, an expired claim, another
// session's item or an item acked already. An item without a well-formed token is a 400. When any claim was lost the
// answer is 409 with code claim_lost, and the body still lists the result of every item.
func (s *Server) ackInbox(w http.ResponseWriter, r *http.Request, c *call) {
	var in wire.AckRequest
	if !decode(w, r, &in) {
		return
	}
	if len(in.Items) == 0 || len(in.Items) > maxAckItems {
		writeFieldErr(w, http.StatusBadRequest, "invalid_request", "items", "Send 1 to 20 items.")
		return
	}
	tokens := make([][]byte, len(in.Items))
	for i, ref := range in.Items {
		token, err := hex.DecodeString(ref.ClaimToken)
		if err != nil || len(token) != 16 {
			writeFieldErr(w, http.StatusBadRequest, "invalid_request", "claim_token", "Every item needs the claim token its claim returned.")
			return
		}
		tokens[i] = token
	}
	now := s.Clock.Now()
	results := make([]wire.AckResult, 0, len(in.Items))
	var done []int64 // conversations whose item was acked
	lost := false
	err := s.Store.Writer.Tx(r.Context(), func(ctx context.Context, tx *pdb.Tx) error {
		for i, ref := range in.Items {
			ok, conv, err := inbox.Ack(ctx, tx.DBTX(), now, c.lease.IdentityID, c.lease.SessionID, ref.ID, tokens[i])
			if err != nil {
				return err
			}
			result := wire.AckClaimLost
			if ok {
				result = wire.AckOK
				done = append(done, conv)
			}
			lost = lost || !ok
			results = append(results, wire.AckResult{ID: ref.ID, Result: result})
		}
		return nil
	})
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	for _, conv := range done {
		s.publishWorking(r.Context(), c.lease.IdentityID, conv, false, 0)
	}
	if lost {
		writeJSON(w, http.StatusConflict, wire.AckResponse{Results: results, Error: &wire.ErrorDetail{Code: wire.AckClaimLost, Message: "A claim ran out or belongs to another session."}})
		return
	}
	writeJSON(w, http.StatusOK, wire.AckResponse{Results: results})
}
