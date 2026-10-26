package httpapi

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/authz"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/conversation"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/event"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/identity"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/readstate"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

// listConversations is GET /api/conversations: latest activity first. The owner sees every conversation, an agent
// only those it takes part in, unless it is a triage agent (migrations 0038, 0040). ?deleted=1 lists the trash instead (the owner only).
func (s *Server) listConversations(w http.ResponseWriter, r *http.Request, c *call) {
	ctx, d := r.Context(), s.reader()
	trash := r.URL.Query().Get("deleted") == "1"
	if trash && c.p.Role != "owner" {
		writeErr(w, http.StatusForbidden, "forbidden", "Only the owner sees the trash.")
		return
	}
	s.maintainSoon(ctx)
	dir, err := loadDirectory(ctx, d)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	var list []conversation.Conversation
	all := c.p.Role == "owner"
	if !all && !trash {
		all, err = isTriage(ctx, d, c.p) // an agent the owner let read everything lists everything
	}
	switch {
	case err != nil:
	case trash:
		list, err = conversation.Trash(ctx, d)
	case all:
		list, err = conversation.ListAll(ctx, d)
	default:
		list, err = conversation.ListOf(ctx, d, c.p.Identity())
	}
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	out := make([]wire.Conversation, 0, len(list))
	for _, cv := range list {
		floor, ok, err := canRead(ctx, d, c.p, cv.ID)
		if err == nil && ok {
			var v wire.Conversation
			if v, err = conversationView(ctx, d, c.p, dir, cv, floor, s.Clock.Now()); err == nil {
				out = append(out, v)
			}
		}
		if err != nil {
			s.internalError(w, r, err)
			return
		}
	}
	rows := make([]*wire.Conversation, len(out))
	for i := range out {
		rows[i] = &out[i]
	}
	if err := s.withRail(ctx, d, c.p, rows...); err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"conversations": out})
}

// getConversation is GET /api/conversations/:id with the details. A conversation the caller cannot see does not exist
// for a person; an agent is told 403 whether or not it exists.
func (s *Server) getConversation(w http.ResponseWriter, r *http.Request, c *call) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	ctx, d := r.Context(), s.reader()
	v, found, err := s.visibleDetail(ctx, d, c.p, id)
	switch {
	case err != nil:
		s.internalError(w, r, err)
	case !found:
		notVisible(w, c)
	default:
		writeJSON(w, http.StatusOK, map[string]any{"conversation": v})
	}
}

// notVisible answers a conversation the caller cannot see: 404 for a person, 403 for an agent (which must not learn
// whether the conversation exists).
func notVisible(w http.ResponseWriter, c *call) {
	if c.p.SessionID != 0 {
		writeErr(w, http.StatusForbidden, "forbidden", "You are not a participant of that conversation.")
		return
	}
	writeErr(w, http.StatusNotFound, "not_found", "No such conversation.")
}

// visibleView is the list row of conversation id for p; found is false when it does not exist or p cannot see it.
func (s *Server) visibleView(ctx context.Context, d pdb.DBTX, p authz.Principal, id int64) (v wire.Conversation, found bool, err error) {
	cv, ok, err := conversation.Get(ctx, d, id)
	if err != nil || !ok {
		return wire.Conversation{}, false, err
	}
	floor, ok, err := canRead(ctx, d, p, id)
	if err != nil || !ok {
		return wire.Conversation{}, false, err
	}
	dir, err := loadDirectory(ctx, d)
	if err != nil {
		return wire.Conversation{}, false, err
	}
	if v, err = conversationView(ctx, d, p, dir, cv, floor, s.Clock.Now()); err == nil {
		err = s.withRail(ctx, d, p, &v)
	}
	return v, err == nil, err
}

// visibleDetail is the detail view of conversation id for p; found is false when it does not exist or p cannot see it.
func (s *Server) visibleDetail(ctx context.Context, d pdb.DBTX, p authz.Principal, id int64) (v wire.Conversation, found bool, err error) {
	cv, ok, err := conversation.Get(ctx, d, id)
	if err != nil || !ok {
		return wire.Conversation{}, false, err
	}
	floor, ok, err := canRead(ctx, d, p, id)
	if err != nil || !ok {
		return wire.Conversation{}, false, err
	}
	dir, err := loadDirectory(ctx, d)
	if err != nil {
		return wire.Conversation{}, false, err
	}
	v, err = detailView(ctx, d, p, dir, cv, floor, s.Clock.Now())
	if err == nil {
		err = s.withRail(ctx, d, p, &v)
	}
	if err == nil && p.SessionID == 0 {
		var pinned []wire.Message
		if pinned, err = pinnedIn(ctx, d, p.Identity(), cv.ID, floor, dir); err == nil {
			v.Pinned = &pinned
		}
	}
	return v, err == nil, err
}

// maxNewParticipants leaves a place for the creator in the 20 a conversation holds.
const maxNewParticipants = conversation.MaxParticipants - 1

// Limits on an agent that starts conversations: at most 20 an hour (a looping agent must not flood the owner's list), each
// with a title of 1 to 80 characters.
const (
	maxAgentConversationsPerHour = 20
	maxAgentTitleRunes           = 80
)

// createConversation is POST /api/conversations. The owner's participants are added at once. An agent's conversation always
// holds the owner; an agent it lists joins at once when it already shares a conversation with the creator, and otherwise
// waits for a human to approve (I-17). The owner's own handle in the list changes nothing. An agent starts at most 20 an hour.
// The same client_id again answers 200 with the conversation it made (I-24).
func (s *Server) createConversation(w http.ResponseWriter, r *http.Request, c *call) {
	var in struct {
		ClientID     string   `json:"client_id"`
		Title        string   `json:"title"`
		Participants []string `json:"participants"`
	}
	if !decode(w, r, &in) {
		return
	}
	title := strings.TrimSpace(in.Title)
	switch {
	case !wire.ValidClientID(in.ClientID):
		writeFieldErr(w, http.StatusBadRequest, "invalid_request", "client_id", "The client id must be 8 to 64 characters without spaces.")
		return
	case title != "" && !conversation.ValidTitle(title):
		writeFieldErr(w, http.StatusBadRequest, "invalid_request", "title", "A title has 1 to 120 characters.")
		return
	case c.p.SessionID != 0 && (title == "" || utf8.RuneCountInString(title) > maxAgentTitleRunes):
		writeFieldErr(w, http.StatusBadRequest, "invalid_request", "title", "An agent names its conversation with 1 to 80 characters.")
		return
	case len(in.Participants) > maxNewParticipants:
		writeFieldErr(w, http.StatusBadRequest, "invalid_request", "participants", "A conversation has at most 20 participants.")
		return
	}
	who, now := c.p.Identity(), s.Clock.Now()
	isAgent := c.p.SessionID != 0
	idemKey := "conversation.create:" + in.ClientID
	sig := createSignature(title, in.Participants)
	var (
		view     wire.Conversation
		created  bool
		badName  bool
		conflict bool
		capped   bool
	)
	err := s.Store.Writer.Tx(r.Context(), func(ctx context.Context, tx *pdb.Tx) error {
		d := tx.DBTX()
		dir, err := loadDirectory(ctx, d)
		if err != nil {
			return err
		}
		if prior, found, err := event.FindIdem(ctx, d, who, idemKey); err != nil || found {
			if err != nil {
				return err
			}
			if !strings.Contains(prior.Payload, `"sig":"`+sig+`"`) {
				conflict = true
				return nil
			}
			cv, _, err := conversation.Get(ctx, d, prior.Conversation)
			if err != nil {
				return err
			}
			if view, err = conversationView(ctx, d, c.p, dir, cv, 0, s.Clock.Now()); err != nil {
				return err
			}
			return s.withRail(ctx, d, c.p, &view)
		}
		if isAgent {
			n, err := conversation.AgentCreatedSince(ctx, d, who, now.Add(-time.Hour))
			if err != nil {
				return err
			}
			if n >= maxAgentConversationsPerHour {
				capped = true
				return nil
			}
		}
		var members, listed []int64
		if isAgent {
			owner, err := identity.Owner(ctx, d)
			if err != nil {
				return err
			}
			members = append(members, owner.ID)
		}
		for _, handle := range in.Participants {
			a, found, err := identity.Lookup(ctx, d, strings.ToLower(handle))
			if err != nil {
				return err
			}
			if found && isAgent && a.Kind == "human" { // the owner is in already
				continue
			}
			if !found || a.Kind != "agent" || a.Disabled {
				badName = true
				return nil
			}
			shared := false
			if isAgent && a.ID != who {
				if shared, err = conversation.Shares(ctx, d, who, a.ID); err != nil {
					return err
				}
			}
			switch {
			case a.ID == who:
			case isAgent && !shared:
				listed = append(listed, a.ID)
			default:
				members = append(members, a.ID)
			}
		}
		titleBy := conversation.TitleHuman
		if isAgent {
			titleBy = conversation.TitleAgent
		}
		cv, err := conversation.Create(ctx, d, now, conversation.New{By: who, Title: title, TitleBy: titleBy, Members: members, Pending: listed})
		if err != nil {
			return err
		}
		parts, err := conversation.Participants(ctx, d, cv.ID)
		if err != nil {
			return err
		}
		for _, pt := range parts {
			if err := readstate.Create(ctx, d, now, pt.IdentityID, cv.ID, cv.LastMessageID); err != nil {
				return err
			}
		}
		if _, err := event.Write(ctx, d, now, event.Entry{Type: event.ConversationCreated, Actor: who, Conversation: cv.ID, IdemKey: idemKey, Payload: map[string]any{"id": cv.ID, "sig": sig}}); err != nil {
			return err
		}
		created = true
		if view, err = conversationView(ctx, d, c.p, dir, cv, 0, s.Clock.Now()); err != nil {
			return err
		}
		return s.withRail(ctx, d, c.p, &view)
	})
	switch {
	case err != nil:
		s.internalError(w, r, err)
	case conflict:
		writeFieldErr(w, http.StatusConflict, "client_id_conflict", "client_id", "That client id was used for a different conversation.")
	case capped:
		tooMany(w, time.Hour, "An agent may start 20 conversations an hour.")
	case badName:
		writeFieldErr(w, http.StatusBadRequest, "invalid_request", "participants", "Each participant must be the handle of an agent that is not disabled.")
	case created:
		s.Bus.Notify()
		writeJSON(w, http.StatusCreated, map[string]any{"conversation": view})
	default:
		writeJSON(w, http.StatusOK, map[string]any{"conversation": view})
	}
}

// createSignature fingerprints a create request (title and the set of handles) so a replay of its client id with
// another title or other participants is a conflict (I-24). A hash keeps the event free of titles (I-23).
func createSignature(title string, handles []string) string {
	set := make([]string, 0, len(handles))
	for _, h := range handles {
		set = append(set, strings.ToLower(h))
	}
	slices.Sort(set)
	sum := sha256.Sum256([]byte(title + "\x00" + strings.Join(slices.Compact(set), "\x00")))
	return hex.EncodeToString(sum[:16])
}

// intParam reads a non-negative integer query parameter; it writes the 400 itself and reports false for junk.
func intParam(w http.ResponseWriter, r *http.Request, name string) (v int64, present, ok bool) {
	raw := r.URL.Query().Get(name)
	if raw == "" {
		return 0, false, true
	}
	n, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || n < 0 {
		writeFieldErr(w, http.StatusBadRequest, "invalid_request", name, "That must be a whole number, 0 or more.")
		return 0, true, false
	}
	return n, true, true
}
