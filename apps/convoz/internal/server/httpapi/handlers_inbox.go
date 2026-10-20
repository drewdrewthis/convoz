package httpapi

import (
	"context"
	"encoding/hex"
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/ask"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/auth"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/authz"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/conversation"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/inbox"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/message"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/plan"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/settings"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/transcript"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

// preferenceRecheck is how often a waiting poll looks again for an item whose preferred session did not take it.
const preferenceRecheck = 5 * time.Second

// inboxPoll is GET /api/inbox?wait=&claim=&visibility=&peek=&held=&after=&conv=.
//
// Without peek it answers the items this session holds, then claims ready ones, and when there are none and wait
// is above 0 it holds the request until an item for the identity arrives or wait runs out. held=0 leaves the
// already-held items out. after=K (`convoz watch`) first finishes the items claimed up to K (the watch got them: no ack needed, no redelivery), then answers only the held items claimed after the cursor K, and the answer
// carries the new cursor: the watch prints each claim once, but a claim whose answer was lost, or that another loop of the session made, comes back at once. after
// overrides held. conv=C claims only the items of conversation C.
func (s *Server) inboxPoll(w http.ResponseWriter, r *http.Request, c *call) {
	q := r.URL.Query()
	wait, ok := waitParam(w, q.Get("wait"))
	if !ok {
		return
	}
	n, vis, ok := s.claimLimits(w, r, q.Get("claim"), q.Get("visibility"))
	if !ok {
		return
	}
	conv, ok := convParam(w, q.Get("conv"))
	if !ok {
		return
	}
	after, byCursor, ok := afterParam(w, q)
	if !ok {
		return
	}
	leave, ok := s.admitPoll(w, r, c, wait > 0, q.Get("runner") == "1") // one runner serves an agent (handlers_runner.go)
	if !ok {
		return
	}
	defer leave()
	if q.Get("peek") == "1" {
		s.inboxPeek(w, r, c)
		return
	}
	req := inbox.Request{Identity: c.lease.IdentityID, Session: c.lease.SessionID, N: n, Visibility: vis, IncludeHeld: byCursor || q.Get("held") != "0", Conv: conv,
		ByCursor: byCursor, After: after}
	if wait > 0 { // a watch: the agent counts as connected while it holds the poll (plan liveness, msg 281)
		s.agentCalled(r.Context(), req.Identity, 1)
		defer s.agentCalled(context.WithoutCancel(r.Context()), req.Identity, -1)
	} else {
		s.agentCalled(r.Context(), req.Identity, 0)
	}
	s.sweepNow(r.Context())
	answer := func(items []wire.InboxItem, cursor int64) {
		res := wire.InboxResponse{Items: append([]wire.InboxItem{}, items...)}
		if byCursor {
			res.Cursor = cursor
		}
		writeJSON(w, http.StatusOK, res)
	}

	hold := time.NewTimer(wait)
	defer hold.Stop()
	// An item kept for another session (AC-28) opens to this one after 30 s, with no event to say so: look again now and then.
	recheck := time.NewTicker(preferenceRecheck)
	defer recheck.Stop()
	cursor := after
	for {
		changed := s.Bus.ChangedFor(req.Identity) // before the claim, so an item that lands meanwhile wakes the next wait
		anyChange := s.Bus.Changed()
		if s.answerIfEnded(w, r, c) {
			return
		}
		items, fresh, newest, err := s.claimOnce(r.Context(), c, req)
		if err != nil {
			if r.Context().Err() == nil {
				s.internalError(w, r, err)
			}
			return
		}
		cursor = newest // no claim of this session lies between after and newest, so an empty answer may carry it too
		if len(items) > 0 || wait == 0 {
			s.publishFresh(r.Context(), req.Identity, fresh)
			answer(items, cursor)
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
			case <-recheck.C:
				waiting = false
			case <-hold.C:
				answer(nil, cursor)
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
	n, vis, ok := s.claimLimits(w, r, rawN, in.Visibility)
	if !ok {
		return
	}
	if in.Conv < 0 {
		writeFieldErr(w, http.StatusBadRequest, "invalid_request", "conv", "conv is a conversation id.")
		return
	}
	req := inbox.Request{Identity: c.lease.IdentityID, Session: c.lease.SessionID, N: n, Visibility: vis, IncludeHeld: true, Conv: in.Conv}
	s.agentCalled(r.Context(), req.Identity, 0)
	s.sweepNow(r.Context())
	items, fresh, _, err := s.claimOnce(r.Context(), c, req)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	s.publishFresh(r.Context(), req.Identity, fresh)
	writeJSON(w, http.StatusOK, wire.InboxResponse{Items: append([]wire.InboxItem{}, items...)})
}

// publishFresh tells the owner's screen that the agent started working on each conversation it just claimed, and that it
// has seen what the owner wrote there.
func (s *Server) publishFresh(ctx context.Context, identity int64, fresh []inbox.Hold) {
	for _, h := range fresh {
		s.publishHold(ctx, identity, h)
		s.publishSeen(ctx, identity, h)
	}
}

// claimLimits reads claim= (1 to 20, default 20) and visibility= (30s to 30m, default: the workspace setting inbox.visibility_default).
// It answers 400 itself.
func (s *Server) claimLimits(w http.ResponseWriter, r *http.Request, rawN, rawVis string) (n int, vis time.Duration, ok bool) {
	n = inbox.MaxClaim
	if rawN != "" {
		v, err := strconv.Atoi(rawN)
		if err != nil || v < 1 || v > inbox.MaxClaim {
			writeFieldErr(w, http.StatusBadRequest, "invalid_request", "claim", "claim is 1 to 20.")
			return 0, 0, false
		}
		n = v
	}
	if rawVis == "" {
		var err error
		if vis, err = s.visibilityDefault(r.Context()); err != nil {
			s.internalError(w, r, err)
			return 0, 0, false
		}
		return n, vis, true
	}
	v, err := time.ParseDuration(rawVis)
	if err != nil || v < inbox.MinVisibility || v > inbox.MaxVisibility {
		writeFieldErr(w, http.StatusBadRequest, "invalid_request", "visibility", "visibility is a duration from 30s to 30m.")
		return 0, 0, false
	}
	return n, v, true
}

// visibilityDefault is how long a claim holds its items when the caller names no visibility: the workspace setting, else 5 minutes.
func (s *Server) visibilityDefault(ctx context.Context) (time.Duration, error) {
	all, err := settings.All(ctx, s.reader(), 0)
	if err != nil {
		return 0, err
	}
	for _, e := range all {
		if text, ok := e.Value.(string); ok && e.Key == "inbox.visibility_default" {
			if d, err := time.ParseDuration(text); err == nil {
				return d, nil
			}
		}
	}
	return inbox.DefaultVisibility, nil
}

// afterParam reads after=: the cursor of the last answer a watch got, 0 or more. byCursor is false when it is absent.
func afterParam(w http.ResponseWriter, q url.Values) (after int64, byCursor bool, ok bool) {
	if !q.Has("after") {
		return 0, false, true
	}
	v, err := strconv.ParseInt(q.Get("after"), 10, 64)
	if err != nil || v < 0 {
		writeFieldErr(w, http.StatusBadRequest, "invalid_request", "after", "after is the cursor of the last answer, 0 or more.")
		return 0, false, false
	}
	return v, true, true
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

// claimOnce is one claim call in one transaction. fresh lists the claims made just now (not held before); cursor is the
// identity's newest claim number as this transaction saw it (inbox.Cursor). Fresh claims wake the other waiting polls of the
// identity, so another loop of the same session (a second watch, a poll whose answer was lost) gets them at once.
func (s *Server) claimOnce(ctx context.Context, c *call, req inbox.Request) (items []wire.InboxItem, fresh []inbox.Hold, cursor int64, err error) {
	now := s.Clock.Now()
	err = s.Store.Writer.Tx(ctx, func(ctx context.Context, tx *pdb.Tx) error {
		d := tx.DBTX()
		if req.ByCursor { // a watch needs no ack: asking after=K proves it got the answers up to K, so those items are done
			done, err := inbox.AckThrough(ctx, d, now, req.Identity, req.Session, req.After)
			if err != nil {
				return err
			}
			for _, id := range done {
				if err := s.ackAsk(ctx, d, now, c, id); err != nil {
					return err
				}
			}
		}
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
			if it.Held || !delivered[it.ID] || it.Reason == inbox.ReasonStatusDue { // a nudge is no work on the conversation
				continue
			}
			fresh = append(fresh, inbox.Hold{Conversation: it.ConversationID, Message: it.MessageID, Until: it.ClaimUntil})
			if it.MessageID != 0 && it.ConversationID != 0 { // the claim is the agent seeing every message up to the item's newest
				if err := inbox.MarkSeen(ctx, d, now, c.lease.IdentityID, it.ConversationID, it.MessageID); err != nil {
					return err
				}
			}
		}
		cursor, err = inbox.Cursor(ctx, d, req.Identity)
		return err
	})
	if err == nil && len(fresh) > 0 {
		s.Bus.Notify(req.Identity)
	}
	return items, fresh, cursor, err
}

// inboxPeek lists the identity's ready and claimed items and claims none. Claims that ran out are merged back first,
// so what it shows keeps the one-ready-item rule.
func (s *Server) inboxPeek(w http.ResponseWriter, r *http.Request, c *call) {
	s.agentCalled(r.Context(), c.lease.IdentityID, 0)
	s.sweepNow(r.Context())
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
		s.publishHold(ctx, l.IdentityID, h)
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
	var placed []placedItem // the items that name a message of a place, for withContext
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
		if it.Reason == inbox.ReasonStatusDue {
			wi, ok, err := s.statusDueItem(ctx, d, now, p, it, expire)
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
		get := message.Get
		if it.Reason == inbox.ReasonAskResolved {
			get = message.GetAny // the ask message may be the very thing that was deleted
		}
		m, have, err := get(ctx, d, it.MessageID)
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
		wi := wire.InboxItem{ID: it.ID, State: it.State, Reason: it.Reason, Count: it.Count, MentionCount: it.MentionCount, Deliveries: it.Deliveries, Conversation: wire.InboxConversation{ID: cv.ID}, Message: inboxMessage(dir, m)}
		if err := attachUploads(ctx, d, []*wire.Message{&wi.Message}); err != nil {
			return nil, err
		}
		if cv.Title != "" {
			title := cv.Title
			wi.Conversation.Title = &title
		}
		if wi.TranscriptState, err = transcriptStateOf(ctx, d, m.ID); err != nil {
			return nil, err
		}
		if it.Reason == inbox.ReasonAskResolved {
			if wi.Message, err = s.askMessageView(ctx, d, dir, m); err != nil {
				return nil, err
			}
		}
		if it.Reason == inbox.ReasonAppResult {
			wi.Message = viewMessage(dir, m)
		}
		if it.ClaimToken != nil {
			wi.ClaimToken = hex.EncodeToString(it.ClaimToken)
		}
		placed = append(placed, placedItem{at: len(out), messageID: m.ID, floor: floor})
		out = append(out, wi)
	}
	return out, withContext(ctx, d, dir, out, placed)
}

// placedItem is an item in the deliver result and what withContext needs to say where its message sits.
type placedItem struct {
	at        int
	messageID int64
	floor     int64
}

// withContext sets ThreadTopic and Before on the items in placed, from one query for the whole batch. What the reader may not see
// (a message at or under their floor) is left out, so the context never shows more than `convoz read` would.
func withContext(ctx context.Context, d pdb.DBTX, dir directory, out []wire.InboxItem, placed []placedItem) error {
	ids := make([]int64, len(placed))
	for i, p := range placed {
		ids[i] = p.messageID
	}
	around, err := message.AroundMessages(ctx, d, ids)
	if err != nil {
		return err
	}
	for _, p := range placed {
		a := around[p.messageID]
		if a.RootID > p.floor {
			out[p.at].ThreadTopic = message.Excerpt(a.RootBody)
		}
		if text := message.Excerpt(a.BeforeBody); a.BeforeID > p.floor && text != "" {
			out[p.at].Before = &wire.Before{Author: dir.person(a.BeforeAuthorID).Handle, Text: text}
		}
	}
	return nil
}

// transcriptStateOf is the transcript state an item carries, a snapshot taken when it is delivered; "" for a message with no voice
// note. An item is only delivered once its transcript is done or its 120 s wait is over (E-5), so a transcript still pending now has
// not made it in time: it reads "failed" when every try so far has failed, "pending" when none has finished yet. The transcript itself
// may still be retried in the background and change later.
func transcriptStateOf(ctx context.Context, d pdb.DBTX, messageID int64) (string, error) {
	by, err := attachmentsOf(ctx, d, []int64{messageID})
	if err != nil {
		return "", err
	}
	for _, a := range by[messageID] {
		t := a.Transcript
		switch {
		case t == nil:
		case t.State == transcript.Pending && t.Attempts > 0:
			return transcript.Failed, nil
		default:
			return t.State, nil
		}
	}
	return "", nil
}

// askMessageView is the ask message of an ask_resolved item with the ask as it stands now: the answer, the history.
func (s *Server) askMessageView(ctx context.Context, d pdb.DBTX, dir directory, m message.Message) (wire.Message, error) {
	v := viewMessage(dir, m)
	a, err := ask.Get(ctx, d, m.ID)
	if err == nil {
		var base wire.AskView
		if base, err = dir.askWithReply(ctx, d, a); err == nil {
			base.App = v.App
			v.AttachAsk(base)
		}
	}
	if errors.Is(err, ask.ErrNotFound) {
		err = nil
	}
	return v, err
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
				if err := s.ackAsk(ctx, tx.DBTX(), now, c, ref.ID); err != nil {
					return err
				}
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
	if len(done) > 0 {
		s.endStretch(r.Context(), c.lease.IdentityID) // an ack ends a stretch of not responding (msg 281)
	}
	if lost {
		writeJSON(w, http.StatusConflict, wire.AckResponse{Results: results, Error: &wire.ErrorDetail{Code: wire.AckClaimLost, Message: "A claim ran out or belongs to another session."}})
		return
	}
	writeJSON(w, http.StatusOK, wire.AckResponse{Results: results})
}

// ackAsk tells the ask that its agent saw the result, when the acked item was the "ask resolved" one.
func (s *Server) ackAsk(ctx context.Context, d pdb.DBTX, now time.Time, c *call, item int64) error {
	id, err := inbox.AskOf(ctx, d, c.lease.IdentityID, item)
	if err != nil || id == 0 {
		return err
	}
	return ask.Ack(ctx, d, askPorts(c.p, &askEffects{}), now, id, c.lease.IdentityID, c.lease.SessionID)
}

// membershipNotice builds the wire item of a membership notice: the system line that says the agent was removed, with
// the conversation's title. ok is false when the line is gone (the conversation was purged).
func (s *Server) membershipNotice(ctx context.Context, d pdb.DBTX, dir directory, it inbox.Item) (wire.InboxItem, bool, error) {
	m, have, err := message.Get(ctx, d, it.MessageID)
	if err != nil || !have {
		return wire.InboxItem{}, false, err
	}
	wi := wire.InboxItem{ID: it.ID, State: it.State, Reason: it.Reason, Count: it.Count, Conversation: wire.InboxConversation{ID: it.ConversationID}, Message: inboxMessage(dir, m)}
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

// inboxMessage is the newest message of an inbox item. It names its thread (when it has one) so an agent answers it with a reply.
func inboxMessage(dir directory, m message.Message) wire.Message {
	v := dir.message(m)
	v.ThreadRootID = m.ThreadRootID
	return v
}

// sweepNow runs the plan sweep for an inbox call, so an agent that polls hears of a late plan at once. A failure is logged, never
// the call's: the timers sweep again.
func (s *Server) sweepNow(ctx context.Context) {
	if err := s.sweepPlans(ctx); err != nil && ctx.Err() == nil {
		s.Log.Printf("plan sweep: %v", err)
	}
}

// statusDueItem builds the wire item of a nudge: a line from the server that asks the agent to update its plan, with the command
// to do it. ok is false when the agent can no longer see the conversation (with expire set the item then leaves the queue).
func (s *Server) statusDueItem(ctx context.Context, d pdb.DBTX, now time.Time, p authz.Principal, it inbox.Item, expire bool) (wire.InboxItem, bool, error) {
	cv, found, err := conversation.Get(ctx, d, it.ConversationID)
	if err != nil {
		return wire.InboxItem{}, false, err
	}
	_, visible, err := canSee(ctx, d, p, it.ConversationID)
	if err != nil {
		return wire.InboxItem{}, false, err
	}
	if !found || !visible {
		if expire {
			err = inbox.ExpireNotVisible(ctx, d, now, it.ID)
		}
		return wire.InboxItem{}, false, err
	}
	conv := strconv.FormatInt(it.ConversationID, 10)
	body := "Your plan in conversation " + conv + " needs an update."
	if pl, err := plan.Get(ctx, d, p.Identity(), it.ConversationID); err == nil {
		it, state := pl.MostOverdue(pl.UpdatedAt, now.UnixMilli())
		switch state {
		case "late":
			body = "Your plan in conversation " + conv + " is late: \"" + it.Text + "\" was due " + time.UnixMilli(it.ETA).UTC().Format(time.RFC3339) + "."
		case "stale":
			body = "Your plan in conversation " + conv + " has had no update for 2 h: \"" + it.Text + "\"."
		}
	}
	body += " Say where you are: convoz plan " + conv + " --doing \"…\" --eta 30m (or --done, --blocked, --waiting)."
	wi := wire.InboxItem{ID: it.ID, State: it.State, Reason: it.Reason, Count: it.Count, Deliveries: it.Deliveries, Conversation: wire.InboxConversation{ID: it.ConversationID},
		Message: wire.Message{Author: systemAuthor, Body: body, Format: "plain", Kind: "system", CreatedAt: now.UnixMilli()}}
	if cv.Title != "" {
		title := cv.Title
		wi.Conversation.Title = &title
	}
	if it.ClaimToken != nil {
		wi.ClaimToken = hex.EncodeToString(it.ClaimToken)
	}
	return wi, true, nil
}
