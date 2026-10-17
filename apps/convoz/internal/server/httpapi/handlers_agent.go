package httpapi

import (
	"context"
	"errors"
	"net/http"
	"slices"
	"sort"
	"strconv"
	"time"
	"unicode/utf8"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/ask"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/auth"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/conversation"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/identity"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/inbox"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/message"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/settings"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

// briefListCap bounds each list the brief reads before it lays them out within its budgets.
const briefListCap = 200

// decisionWindow is how far back section 7 of the brief looks for answered asks.
const decisionWindow = 7 * 24 * time.Hour

// briefBytes is the size the caller asked for (max_bytes=), else the workspace setting brief.max_bytes. A size outside 4 to 64 KB
// is brought inside; an unreadable one is a 400, written here.
func (s *Server) briefBytes(w http.ResponseWriter, r *http.Request, identityID int64) (int, bool) {
	if raw := r.URL.Query().Get("max_bytes"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil {
			writeFieldErr(w, http.StatusBadRequest, "invalid_request", "max_bytes", "max_bytes is a number of bytes.")
			return 0, false
		}
		return inbox.ClampBriefBytes(n), true
	}
	all, err := settings.All(r.Context(), s.reader(), identityID)
	if err != nil {
		s.internalError(w, r, err)
		return 0, false
	}
	for _, e := range all {
		if n, ok := e.Value.(int64); ok && e.Key == "brief.max_bytes" {
			return inbox.ClampBriefBytes(int(n)), true
		}
	}
	return inbox.DefaultBriefBytes, true
}

// brief is GET /api/brief?max_bytes=&page=: who the agent is, its last handoff note, its asks, its inbox and the conversations
// with unread messages, within a fixed budget (design §3.8, M7). It changes nothing: no claim, no ack, no marker. Two sessions of one
// identity get the same conversations, and a conversation the page cut stays listed until the agent reads it.
func (s *Server) brief(w http.ResponseWriter, r *http.Request, c *call) {
	maxBytes, ok := s.briefBytes(w, r, c.lease.IdentityID)
	if !ok {
		return
	}
	page := int64(1)
	if p, present, ok := intParam(w, r, "page"); !ok {
		return
	} else if present {
		page = max(p, 1)
	}
	in, err := s.briefInput(r.Context(), c)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	in.MaxBytes, in.Page = maxBytes, int(page)
	b := inbox.Render(in)
	out := wire.BriefResponse{Text: b.Text, Bytes: len(b.Text), Page: int(page), Sections: make([]wire.BriefSection, len(b.Sections))}
	for i, sec := range b.Sections {
		out.Sections[i] = wire.BriefSection{Key: sec.Key, Title: sec.Title, Text: sec.Text}
	}
	writeJSON(w, http.StatusOK, out)
}

// briefInput gathers what the brief says from the modules. Everything passes canSee (I-6): a conversation the agent is not in
// shows nowhere in it, neither by title nor by count.
func (s *Server) briefInput(ctx context.Context, c *call) (inbox.BriefInput, error) {
	d, now, id := s.reader(), s.Clock.Now(), c.lease.IdentityID
	in := inbox.BriefInput{Session: c.lease.Label, Machine: c.lease.Machine, InboxByReason: map[string]int64{}}
	who, found, err := identity.ByID(ctx, d, id)
	if err != nil || !found {
		return in, errors.Join(err, errors.New("lease without identity"))
	}
	in.Handle, in.DisplayName = who.Handle, who.DisplayName
	if p, found, err := identity.ProfileOf(ctx, d, id); err != nil {
		return in, err
	} else if found {
		in.Description, in.Capabilities = p.Description, p.Capabilities
	}
	if in.LiveSessions, err = auth.LiveSessionCount(ctx, d, id, now); err != nil {
		return in, err
	}
	if err = s.briefHandoff(ctx, d, id, &in); err != nil {
		return in, err
	}
	dir, err := loadDirectory(ctx, d)
	if err != nil {
		return in, err
	}
	titles, err := s.briefConversations(ctx, d, c, dir, &in)
	if err != nil {
		return in, err
	}
	return in, s.briefAsksAndInbox(ctx, d, c, titles, &in)
}

func (s *Server) briefHandoff(ctx context.Context, d pdb.DBTX, id int64, in *inbox.BriefInput) error {
	notes, err := inbox.Handoffs(ctx, d, id, 1)
	if err != nil || len(notes) == 0 {
		return err
	}
	total, err := inbox.HandoffCount(ctx, d, id)
	if err != nil {
		return err
	}
	origins, err := auth.SessionOrigins(ctx, d, []int64{notes[0].SessionID})
	if err != nil {
		return err
	}
	o := origins[notes[0].SessionID]
	in.Handoff = &inbox.BriefHandoff{At: notes[0].CreatedAt, Session: o.Label, Machine: o.Machine, Body: notes[0].Body}
	in.OlderHandoffs = total - 1
	return nil
}

// briefConversations lists the conversations with unread messages, newest activity first, and returns the titles of every
// conversation the agent may see.
func (s *Server) briefConversations(ctx context.Context, d pdb.DBTX, c *call, dir directory, in *inbox.BriefInput) (map[int64]string, error) {
	list, err := conversation.ListOf(ctx, d, c.lease.IdentityID)
	if err != nil {
		return nil, err
	}
	sort.SliceStable(list, func(i, j int) bool {
		if list[i].LastActivityAt != list[j].LastActivityAt {
			return list[i].LastActivityAt > list[j].LastActivityAt
		}
		return list[i].ID > list[j].ID
	})
	titles := make(map[int64]string, len(list))
	for _, cv := range list {
		floor, visible, err := canSee(ctx, d, c.p, cv.ID)
		if err != nil {
			return nil, err
		}
		if !visible {
			continue
		}
		titles[cv.ID] = cv.Title
		unread, err := unreadOf(ctx, d, c.lease.IdentityID, cv, floor)
		if err != nil {
			return nil, err
		}
		if unread == 0 {
			continue
		}
		row := inbox.BriefConversation{ID: cv.ID, Title: cv.Title, Unread: unread, Capped: unread >= message.MaxUnread}
		if cv.LastMessageID > floor {
			if m, found, err := message.Get(ctx, d, cv.LastMessageID); err != nil {
				return nil, err
			} else if found {
				row.LastBy, row.Last = dir[m.AuthorID].Handle, message.Preview(dir.message(m).Body)
			}
		}
		in.Conversations = append(in.Conversations, row)
	}
	return titles, nil
}

func (s *Server) briefAsksAndInbox(ctx context.Context, d pdb.DBTX, c *call, titles map[int64]string, in *inbox.BriefInput) error {
	id, now := c.lease.IdentityID, s.Clock.Now()
	keep := func(list []ask.BriefAsk) []inbox.BriefAsk {
		var out []inbox.BriefAsk
		for _, a := range list {
			if title, visible := titles[a.ConversationID]; visible {
				out = append(out, inbox.BriefAsk{ID: a.ID, Conversation: a.ConversationID, Title: title, Question: a.Question, Answer: a.Answer, State: a.State, Urgent: a.Urgent, At: a.ResolvedAt, SnoozedUntil: a.SnoozedUntil})
			}
		}
		return out
	}
	open, err := ask.OpenOf(ctx, d, now, id, briefListCap)
	if err != nil {
		return err
	}
	answers, err := ask.UnackedOf(ctx, d, id, briefListCap)
	if err != nil {
		return err
	}
	decisions, err := ask.AnsweredSince(ctx, d, now.Add(-decisionWindow), briefListCap)
	if err != nil {
		return err
	}
	in.Asks, in.Answers, in.Decisions = keep(open), keep(answers), keep(decisions)

	items, err := inbox.Peek(ctx, d, now, id, c.lease.SessionID)
	if err != nil {
		return err
	}
	var waiting []inbox.BriefItem
	for _, it := range items {
		title, visible := titles[it.ConversationID]
		if it.ConversationID != 0 && !visible && it.Reason != "membership" {
			continue
		}
		in.InboxByReason[it.Reason]++
		in.InboxTotal++
		waiting = append(waiting, inbox.BriefItem{Reason: it.Reason, Conversation: it.ConversationID, Title: title, Count: it.Count, ID: it.ID})
	}
	sort.SliceStable(waiting, func(i, j int) bool {
		a, b := waiting[i], waiting[j]
		if ra, rb := inbox.ReasonRank(a.Reason), inbox.ReasonRank(b.Reason); ra != rb {
			return ra < rb
		}
		return a.ID > b.ID
	})
	in.InboxTop = waiting

	groups, err := inbox.ExpiredUnread(ctx, d, id)
	if err != nil {
		return err
	}
	for _, g := range groups {
		if title, visible := titles[g.Conversation]; visible {
			in.Expired = append(in.Expired, inbox.BriefExpired{Conversation: g.Conversation, Title: title, Count: g.Count, Since: g.Since})
		}
	}
	return nil
}

// createHandoff is POST /api/handoffs {client_id, body}: a note for the next session of this identity. The identity and the
// session come from the lease (I-40). The same client id stores one note (I-24). The identity keeps its newest 50.
func (s *Server) createHandoff(w http.ResponseWriter, r *http.Request, c *call) {
	var in wire.HandoffRequest
	if !decode(w, r, &in) {
		return
	}
	if !wire.ValidClientID(in.ClientID) {
		writeFieldErr(w, http.StatusBadRequest, "invalid_request", "client_id", "The client id must be 8 to 64 characters without spaces.")
		return
	}
	if len(in.Body) < 1 || len(in.Body) > inbox.MaxHandoffBytes || !utf8.ValidString(in.Body) {
		writeFieldErr(w, http.StatusBadRequest, "invalid_request", "body", "A handoff note is 1 to 4096 bytes of text.")
		return
	}
	var note inbox.Handoff
	var created bool
	err := s.Store.Writer.Tx(r.Context(), func(ctx context.Context, tx *pdb.Tx) (err error) {
		note, created, err = inbox.AddHandoff(ctx, tx.DBTX(), s.Clock.Now(), c.lease.IdentityID, c.lease.SessionID, in.Body, in.ClientID)
		return err
	})
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	status := http.StatusCreated
	if !created {
		status = http.StatusOK
	}
	origins, err := auth.SessionOrigins(r.Context(), s.reader(), []int64{note.SessionID})
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, status, handoffView(note, origins))
}

func handoffView(h inbox.Handoff, origins map[int64]auth.Origin) wire.Handoff {
	o := origins[h.SessionID]
	return wire.Handoff{ID: h.ID, Body: h.Body, CreatedAt: h.CreatedAt, Session: o.Label, Machine: o.Machine}
}

// listHandoffs is GET /api/handoffs?identity=: the notes of an identity, newest first. The owner names the agent (a handle); a lease
// reads its own identity's and no other's.
func (s *Server) listHandoffs(w http.ResponseWriter, r *http.Request, c *call) {
	ctx, d := r.Context(), s.reader()
	target := c.lease.IdentityID
	handle := r.URL.Query().Get("identity")
	switch {
	case c.p.SessionID != 0:
		if handle != "" && !s.isHandleOf(ctx, d, handle, target) {
			writeErr(w, http.StatusForbidden, "forbidden", "You may read only your own handoff notes.")
			return
		}
	default:
		who, found, err := identity.Lookup(ctx, d, handle)
		switch {
		case err != nil:
			s.internalError(w, r, err)
			return
		case handle == "" || !found || who.Kind != "agent":
			writeErr(w, http.StatusNotFound, "not_found", "No such agent.")
			return
		}
		target = who.ID
	}
	notes, err := inbox.Handoffs(ctx, d, target, inbox.KeepHandoffs)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	ids := make([]int64, len(notes))
	for i, n := range notes {
		ids[i] = n.SessionID
	}
	origins, err := auth.SessionOrigins(ctx, d, slices.Compact(slices.Sorted(slices.Values(ids))))
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	out := wire.HandoffsResponse{Handoffs: make([]wire.Handoff, len(notes))}
	for i, n := range notes {
		out.Handoffs[i] = handoffView(n, origins)
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) isHandleOf(ctx context.Context, d pdb.DBTX, handle string, id int64) bool {
	who, found, err := identity.Lookup(ctx, d, handle)
	return err == nil && found && who.ID == id
}

// patchProfile is PATCH /api/me/profile {display_name?, description?, capabilities?}: an agent changes its own profile, once an
// hour. The handle is not a field (I-3, I-40), so naming it is a 400.
func (s *Server) patchProfile(w http.ResponseWriter, r *http.Request, c *call) {
	var in wire.ProfileRequest
	if !decode(w, r, &in) {
		return
	}
	if in.DisplayName == nil && in.Description == nil && in.Capabilities == nil {
		writeErr(w, http.StatusBadRequest, "invalid_request", "Send display_name, description or capabilities.")
		return
	}
	who, found, err := identity.ByID(r.Context(), s.reader(), c.lease.IdentityID)
	if err != nil || !found {
		s.internalError(w, r, errors.Join(err, errors.New("lease without identity")))
		return
	}
	var out identity.Profile
	err = s.Store.Writer.Tx(r.Context(), func(ctx context.Context, tx *pdb.Tx) (err error) {
		out, err = identity.SetProfile(ctx, tx.DBTX(), c.lease.IdentityID, identity.ProfileChange{DisplayName: in.DisplayName, Description: in.Description, Capabilities: in.Capabilities}, s.Clock.Now())
		return err
	})
	var limited *identity.ProfileRateLimited
	switch {
	case errors.As(err, &limited):
		retryAfter(w, limited.RetryAfter)
		writeErr(w, http.StatusTooManyRequests, "rate_limited", "A profile changes once an hour.")
	case errors.Is(err, identity.ErrInvalidDisplayName):
		writeFieldErr(w, http.StatusBadRequest, "invalid_request", "display_name", "A display name is 1 to 80 characters without control characters.")
	case errors.Is(err, identity.ErrConfusableName):
		writeFieldErr(w, http.StatusConflict, "name_taken", "display_name", "That name looks like another identity.")
	case errors.Is(err, identity.ErrInvalidDescription):
		writeFieldErr(w, http.StatusBadRequest, "invalid_request", "description", "A description is at most 80 characters.")
	case errors.Is(err, identity.ErrInvalidCapabilities):
		writeFieldErr(w, http.StatusBadRequest, "invalid_request", "capabilities", "At most 20 capabilities of 1 to 40 characters each.")
	case err != nil:
		s.internalError(w, r, err)
	default:
		writeJSON(w, http.StatusOK, wire.ProfileResponse{Handle: who.Handle, DisplayName: out.DisplayName, Description: out.Description, Capabilities: append([]string{}, out.Capabilities...)})
	}
}
