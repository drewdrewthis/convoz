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

// inboxPoll is GET /api/inbox?wait=&claim=&visibility=&peek=&held=.
//
// Without peek it answers the items this session holds, then claims ready ones, and when there are none and wait
// is above 0 it holds the request until an item for the identity arrives or wait runs out. held=0 leaves the
// already-held items out: `convoz watch` prints each claim once, so it asks only for new ones and the poll does not
// return at once for an item the agent has not acked yet.
func (s *Server) inboxPoll(w http.ResponseWriter, r *http.Request, c *call) {
	q := r.URL.Query()
	wait, ok := waitParam(w, q.Get("wait"))
	if !ok {
		return
	}
	n := inbox.MaxClaim
	if raw := q.Get("claim"); raw != "" {
		v, err := strconv.Atoi(raw)
		if err != nil || v < 1 || v > inbox.MaxClaim {
			writeFieldErr(w, http.StatusBadRequest, "invalid_request", "claim", "claim is 1 to 20.")
			return
		}
		n = v
	}
	vis := inbox.DefaultVisibility
	if raw := q.Get("visibility"); raw != "" {
		v, err := time.ParseDuration(raw)
		if err != nil || v < inbox.MinVisibility || v > inbox.MaxVisibility {
			writeFieldErr(w, http.StatusBadRequest, "invalid_request", "visibility", "visibility is a duration from 30s to 30m.")
			return
		}
		vis = v
	}
	if q.Get("peek") == "1" {
		s.inboxPeek(w, r, c)
		return
	}
	req := inbox.Request{Identity: c.lease.IdentityID, Session: c.lease.SessionID, N: n, Visibility: vis, IncludeHeld: q.Get("held") != "0"}

	hold := time.NewTimer(wait)
	defer hold.Stop()
	for {
		changed := s.Bus.ChangedFor(req.Identity) // before the claim, so an item that lands meanwhile wakes the next wait
		if msg, ended, err := s.leaseEnded(r.Context(), c.token); err != nil {
			s.internalError(w, r, err)
			return
		} else if ended {
			writeErr(w, http.StatusUnauthorized, wire.CodeSessionEnded, msg)
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
			for _, h := range fresh {
				s.publishWorking(r.Context(), req.Identity, h.Conversation, true, h.Until)
			}
			writeJSON(w, http.StatusOK, wire.InboxResponse{Items: append([]wire.InboxItem{}, items...)})
			return
		}
		select {
		case <-changed:
		case <-hold.C:
			writeJSON(w, http.StatusOK, wire.InboxResponse{Items: []wire.InboxItem{}})
			return
		case <-r.Context().Done():
			return
		}
	}
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

// inboxPeek lists the identity's ready and claimed items and changes nothing.
func (s *Server) inboxPeek(w http.ResponseWriter, r *http.Request, c *call) {
	ctx, d, now := r.Context(), s.reader(), s.Clock.Now()
	peeked, err := inbox.Peek(ctx, d, now, c.lease.IdentityID, c.lease.SessionID)
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

// deliver reads each item's newest message through canSee and builds the wire items. An item whose message the agent
// can no longer see is dropped, and with expire set it also leaves the queue (design §3.8).
func (s *Server) deliver(ctx context.Context, d pdb.DBTX, now time.Time, p authz.Principal, items []inbox.Item, expire bool) ([]wire.InboxItem, error) {
	dir, err := loadDirectory(ctx, d)
	if err != nil {
		return nil, err
	}
	out := make([]wire.InboxItem, 0, len(items))
	for _, it := range items {
		if it.Reason == "membership" {
			// The removal notice is exempt from the can-see check: the agent can no longer see the conversation (C-1).
			wi, ok, err := s.membershipNotice(ctx, d, dir, it)
			if err != nil {
				return nil, err
			}
			if ok {
				out = append(out, wi)
			}
			continue
		}
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
		wi := wire.InboxItem{ID: it.ID, State: it.State, Reason: it.Reason, Count: it.Count, Conversation: wire.InboxConversation{ID: cv.ID}, Message: dir.message(m)}
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
// session's item or an item acked already.
func (s *Server) ackInbox(w http.ResponseWriter, r *http.Request, c *call) {
	var in wire.AckRequest
	if !decode(w, r, &in) {
		return
	}
	if len(in.Items) == 0 || len(in.Items) > maxAckItems {
		writeFieldErr(w, http.StatusBadRequest, "invalid_request", "items", "Send 1 to 20 items.")
		return
	}
	now := s.Clock.Now()
	results := make([]wire.AckResult, 0, len(in.Items))
	var done []int64 // conversations whose item was acked
	err := s.Store.Writer.Tx(r.Context(), func(ctx context.Context, tx *pdb.Tx) error {
		for _, ref := range in.Items {
			result := wire.AckClaimLost
			if token, err := hex.DecodeString(ref.ClaimToken); err == nil && len(token) == 16 {
				ok, conv, err := inbox.Ack(ctx, tx.DBTX(), now, c.lease.IdentityID, c.lease.SessionID, ref.ID, token)
				if err != nil {
					return err
				}
				if ok {
					result = wire.AckOK
					done = append(done, conv)
				}
			}
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
	writeJSON(w, http.StatusOK, wire.AckResponse{Results: results})
}

// membershipNotice builds the wire item of a membership notice: the system line that says the agent was removed, with
// the conversation's title. ok is false when the line is gone (the conversation was purged).
func (s *Server) membershipNotice(ctx context.Context, d pdb.DBTX, dir directory, it inbox.Item) (wire.InboxItem, bool, error) {
	m, have, err := message.Get(ctx, d, it.MessageID)
	if err != nil || !have {
		return wire.InboxItem{}, false, err
	}
	wi := wire.InboxItem{ID: it.ID, State: it.State, Reason: it.Reason, Count: it.Count, Conversation: wire.InboxConversation{ID: it.ConversationID}, Message: dir.message(m)}
	if cv, found, err := conversation.GetAny(ctx, d, it.ConversationID); err != nil {
		return wire.InboxItem{}, false, err
	} else if found && cv.Title != "" {
		title := cv.Title
		wi.Conversation.Title = &title
	}
	if it.ClaimToken != nil {
		wi.ClaimToken = hex.EncodeToString(it.ClaimToken)
	}
	return wi, true, nil
}
