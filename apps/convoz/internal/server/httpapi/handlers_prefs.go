package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/ask"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/auth"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/conversation"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/event"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/identity"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/message"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/prefs"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

// mutedUntil reads the muted_until of a prefs request: a time in the future, or null to unmute (0).
func mutedUntil(raw json.RawMessage) (until int64, ok bool) {
	if string(raw) == "null" {
		return 0, true
	}
	return until, json.Unmarshal(raw, &until) == nil && until > 0
}

// patchPrefs is PATCH /api/conversations/:id/prefs: star, mute or move one conversation in the caller's own rail (I-21, I-22).
// The server picks the new rank, so two devices dragging at once cannot write keys that disagree.
func (s *Server) patchPrefs(w http.ResponseWriter, r *http.Request, c *call) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	var in wire.PrefsRequest
	if !decode(w, r, &in) {
		return
	}
	mute, muteSent := int64(0), len(in.MutedUntil) > 0
	if muteSent {
		if mute, ok = mutedUntil(in.MutedUntil); !ok {
			writeFieldErr(w, http.StatusBadRequest, "invalid_request", "muted_until", "muted_until is a time in milliseconds, or null.")
			return
		}
	}
	if in.Starred == nil && !muteSent && in.Place == nil {
		writeErr(w, http.StatusBadRequest, "invalid_request", "Send starred, muted_until or place.")
		return
	}
	who, now := c.p.Identity(), s.Clock.Now()
	var (
		out      wire.PrefsResult
		visible  bool
		badPlace bool
	)
	err := s.Store.Writer.Tx(r.Context(), func(ctx context.Context, tx *pdb.Tx) error {
		d := tx.DBTX()
		if _, found, err := conversation.Get(ctx, d, id); err != nil || !found {
			return err
		}
		if _, visible2, err := canSee(ctx, d, c.p, id); err != nil || !visible2 {
			return err
		}
		visible = true
		list, err := railList(ctx, d, c.p)
		if err != nil {
			return err
		}
		all, err := prefs.All(ctx, d, who)
		if err != nil {
			return err
		}
		cur := all[id]
		starred, keys, changed := cur.Starred, []string{}, map[int64]float64{}
		if in.Starred != nil && *in.Starred != cur.Starred {
			starred = *in.Starred
			rank := prefs.TopRank(railSection(list, all, starred), now)
			if err := prefs.SetStarred(ctx, d, now, who, id, starred, rank); err != nil {
				return err
			}
			cur.Starred, cur.Rank = starred, &rank
			all[id] = cur
			changed[id] = rank
			keys = append(keys, "starred")
		}
		if in.Place != nil {
			moved, err := prefs.Place(railSection(list, all, starred), id, in.Place.After, now)
			if errors.Is(err, prefs.ErrNotInSection) {
				badPlace = true
				return nil
			}
			if err != nil {
				return err
			}
			if err := prefs.SetRanks(ctx, d, now, who, moved); err != nil {
				return err
			}
			for _, m := range moved {
				changed[m.ID] = m.Rank
			}
			keys = append(keys, "rank")
		}
		if muteSent {
			if err := prefs.SetMuted(ctx, d, now, who, id, mute); err != nil {
				return err
			}
			cur.MutedUntil = mute
			keys = append(keys, "muted")
		}
		out = wire.PrefsResult{ConversationID: id, Starred: starred, Ranks: []wire.Rail{}}
		if cur.MutedUntil != 0 {
			out.MutedUntil = ptr(cur.MutedUntil)
		}
		for rid, rank := range changed {
			out.Ranks = append(out.Ranks, wire.Rail{ID: rid, Rank: rank})
		}
		if len(keys) == 0 {
			return nil
		}
		_, err = event.Write(ctx, d, now, event.Entry{Type: eventPrefsChanged, Actor: who, Conversation: id, Audience: who, Payload: map[string]any{"starred": starred, "keys": keys}})
		return err
	})
	switch {
	case err != nil:
		s.internalError(w, r, err)
	case !visible:
		notVisible(w, c)
	case badPlace:
		writeFieldErr(w, http.StatusBadRequest, "invalid_request", "place", "That conversation is not in this section.")
	default:
		s.Bus.Notify()
		writeJSON(w, http.StatusOK, out)
	}
}

// pinHandler is PUT (pin) or DELETE (unpin) of /api/messages/:id/pin. Both are idempotent, and a message the caller cannot see is 404.
func pinHandler(pin bool) handler {
	return func(s *Server, w http.ResponseWriter, r *http.Request, c *call) {
		id, ok := pathID(w, r)
		if !ok {
			return
		}
		who, now := c.p.Identity(), s.Clock.Now()
		found := false
		err := s.Store.Writer.Tx(r.Context(), func(ctx context.Context, tx *pdb.Tx) error {
			d := tx.DBTX()
			m, ok, err := message.Get(ctx, d, id)
			if err != nil || !ok {
				return err
			}
			floor, visible, err := canSee(ctx, d, c.p, m.ConversationID)
			if err != nil || !visible || m.ID <= floor {
				return err
			}
			found = true
			var changed bool
			if pin {
				changed, err = prefs.Pin(ctx, d, now, who, id)
			} else {
				changed, err = prefs.Unpin(ctx, d, who, id)
			}
			if err != nil || !changed {
				return err
			}
			_, err = event.Write(ctx, d, now, event.Entry{Type: eventPinChanged, Actor: who, Conversation: m.ConversationID, Audience: who, Message: id, Payload: map[string]any{"pinned": pin}})
			return err
		})
		switch {
		case err != nil:
			s.internalError(w, r, err)
		case !found:
			writeErr(w, http.StatusNotFound, "not_found", "No such message.")
		default:
			s.Bus.Notify()
			writeJSON(w, http.StatusOK, map[string]any{})
		}
	}
}

// pinnedIn is the messages the person pinned in one conversation, newest pin first, as the details show them.
func pinnedIn(ctx context.Context, d pdb.DBTX, who, conv, floor int64, dir directory) ([]wire.Message, error) {
	ids, err := prefs.PinnedIDs(ctx, d, who)
	if err != nil {
		return nil, err
	}
	out := []wire.Message{}
	for _, id := range ids {
		m, ok, err := message.Get(ctx, d, id)
		if err != nil {
			return nil, err
		}
		if ok && m.ConversationID == conv && m.ID > floor {
			out = append(out, dir.message(m))
		}
	}
	return out, nil
}

// putStatus is PUT /api/status: the agent says what it is doing, for Crew.
func (s *Server) putStatus(w http.ResponseWriter, r *http.Request, c *call) {
	if c.lease.Scopes&auth.ScopeStatus == 0 {
		writeErr(w, http.StatusForbidden, "forbidden", "This machine may not report a status.")
		return
	}
	var in wire.StatusRequest
	if !decode(w, r, &in) {
		return
	}
	if field, ok := identity.ValidStatus(in.State, in.Doing, in.Next); !ok {
		writeFieldErr(w, http.StatusBadRequest, "invalid_request", field, "The state is idle, working, blocked or waiting; doing and next are at most 200 characters.")
		return
	}
	who, now := c.p.Identity(), s.Clock.Now()
	var st identity.Status
	err := s.Store.Writer.Tx(r.Context(), func(ctx context.Context, tx *pdb.Tx) error {
		var err error
		if st, err = identity.SetStatus(ctx, tx.DBTX(), now, who, in.State, in.Doing, in.Next); err != nil {
			return err
		}
		_, err = event.Write(ctx, tx.DBTX(), now, event.Entry{Type: eventStatusChanged, Actor: who, Session: c.p.SessionID, Payload: map[string]any{"state": st.State}})
		return err
	})
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	s.Bus.Notify()
	writeJSON(w, http.StatusOK, agentStatus(st))
}

func agentStatus(st identity.Status) wire.AgentStatus {
	return wire.AgentStatus{State: st.State, Doing: st.Doing, Next: st.Next, Since: st.Since, UpdatedAt: st.UpdatedAt}
}

// maxOpenAsksShown bounds the asks listed per agent in Crew.
const maxOpenAsksShown = 50

// getStatus is GET /api/status: the owner reads every agent, an agent only itself.
func (s *Server) getStatus(w http.ResponseWriter, r *http.Request, c *call) {
	ctx, d, now := r.Context(), s.reader(), s.Clock.Now()
	list, err := identity.List(ctx, d)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	stored, err := identity.Statuses(ctx, d)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	out := wire.StatusList{Statuses: []wire.CrewStatus{}}
	for _, e := range list {
		id := e.ID
		if e.Kind != "agent" || (c.p.SessionID != 0 && id != c.p.Identity()) {
			continue
		}
		st, ok := stored[id]
		if !ok {
			st = identity.Idle()
		}
		live, err := auth.LiveSessionCount(ctx, d, id, now)
		if err != nil {
			s.internalError(w, r, err)
			return
		}
		row := wire.CrewStatus{AgentStatus: agentStatus(st), IdentityID: id, Handle: e.Handle, Online: live > 0, OpenAsks: []wire.OpenAsk{}}
		if c.p.SessionID == 0 {
			asks, err := ask.OpenOf(ctx, d, now, id, maxOpenAsksShown)
			if err != nil {
				s.internalError(w, r, err)
				return
			}
			for _, a := range asks {
				row.OpenAsks = append(row.OpenAsks, wire.OpenAsk{ID: a.ID, ConversationID: a.ConversationID, Question: a.Question, Urgent: a.Urgent})
			}
		}
		out.Statuses = append(out.Statuses, row)
	}
	writeJSON(w, http.StatusOK, out)
}
