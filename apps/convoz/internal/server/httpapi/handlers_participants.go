package httpapi

import (
	"context"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/ask"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/conversation"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/event"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/identity"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/inbox"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/message"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/readstate"
)

// History choices when an agent is added (I-15): everything said so far, or only what comes after the add.
const (
	historySinceNow = "since_now"
	historyFull     = "full"
)

// handle prefix of a participant in a system line.
func at(handle string) string { return "@" + handle }

// pathIID reads the :iid segment (an identity id).
func pathIID(w http.ResponseWriter, r *http.Request) (int64, bool) {
	n, err := strconv.ParseInt(r.PathValue("iid"), 10, 64)
	if err != nil || n <= 0 {
		writeErr(w, http.StatusNotFound, "not_found", "No such participant.")
		return 0, false
	}
	return n, true
}

// addParticipant is POST /api/conversations/:id/participants. A person adds an agent at once and says what history it
// sees; an agent can only ask, and the add waits for a human (I-17, I-18).
func (s *Server) addParticipant(w http.ResponseWriter, r *http.Request, c *call) {
	convID, ok := pathID(w, r)
	if !ok {
		return
	}
	var in struct {
		IdentityID int64  `json:"identity_id"`
		Handle     string `json:"handle"`
		History    string `json:"history"`
	}
	if !decode(w, r, &in) {
		return
	}
	switch in.History {
	case "":
		in.History = historySinceNow
	case historySinceNow, historyFull:
	default:
		writeFieldErr(w, http.StatusBadRequest, "invalid_request", "history", "History is since_now or full.")
		return
	}
	if in.IdentityID == 0 && in.Handle == "" {
		writeFieldErr(w, http.StatusBadRequest, "invalid_request", "identity_id", "Name the agent by identity_id or handle.")
		return
	}
	asAgent, now := c.p.SessionID != 0, s.Clock.Now()
	var (
		status  string
		changed bool
		bad     bool
		full    bool
		visible bool
		target  identity.Principal
	)
	err := s.Store.Writer.Tx(r.Context(), func(ctx context.Context, tx *pdb.Tx) error {
		d := tx.DBTX()
		cv, found, err := conversation.Get(ctx, d, convID)
		if err != nil || !found {
			return err
		}
		if _, visible, err = canSee(ctx, d, c.p, convID); err != nil || !visible {
			return err
		}
		if in.IdentityID != 0 {
			target, found, err = identity.ByID(ctx, d, in.IdentityID)
		} else {
			target, found, err = identity.Lookup(ctx, d, strings.ToLower(strings.TrimPrefix(in.Handle, "@")))
		}
		if err != nil {
			return err
		}
		if !found || target.Kind != "agent" || target.Disabled {
			bad = true
			return nil
		}
		cur, seated, err := conversation.SeatOf(ctx, d, convID, target.ID)
		if err != nil {
			return err
		}
		if seated && (cur.Status == conversation.StatusActive || (asAgent && cur.Status == conversation.StatusPending)) {
			status = cur.Status
			return nil
		}
		status = conversation.StatusActive
		line := message.SystemLine{T: "member.added", Identity: target.ID, By: c.p.Identity(), Via: "add", History: in.History}
		if asAgent {
			status = conversation.StatusPending
			line = message.SystemLine{T: "member.requested", Identity: target.ID, By: c.p.Identity()}
		}
		lineID, seq, err := sayLine(ctx, d, now, c.p.Identity(), convID, line)
		if err != nil {
			return err
		}
		join := conversation.Join{Conversation: convID, Identity: target.ID, By: c.p.Identity(), Status: status, Seq: seq}
		switch {
		case asAgent:
			join.FloorID, join.RequestedBy = lineID, c.p.Identity()
		case in.History == historySinceNow:
			join.FloorID = lineID // the line that says the add is not for the newcomer
		}
		if changed, err = conversation.Add(ctx, d, now, join); err != nil {
			full = err == conversation.ErrFull
			if full {
				return nil
			}
			return err
		}
		if status == conversation.StatusActive {
			if err := readstate.Create(ctx, d, now, target.ID, convID, cv.LastMessageID); err != nil {
				return err
			}
		}
		_, err = journalChange(ctx, d, now, c.p.Identity(), convID, target.ID, status)
		return err
	})
	switch {
	case err != nil:
		s.internalError(w, r, err)
	case !visible:
		notVisible(w, c)
	case bad:
		writeFieldErr(w, http.StatusBadRequest, "invalid_request", "identity_id", "Only an agent that is not disabled can be added.")
	case full:
		writeErr(w, http.StatusConflict, "participants_full", "A conversation has at most 20 participants.")
	default:
		if changed {
			s.Bus.Notify(target.ID)
		}
		code := http.StatusOK
		if changed {
			code = http.StatusCreated
		}
		writeJSON(w, code, map[string]any{"participant": map[string]any{"identity_id": target.ID, "handle": target.Handle, "status": status}})
	}
}

// dirHandle is the handle of an identity, "" when unknown.
func dirHandle(ctx context.Context, d pdb.DBTX, id int64) string {
	p, ok, err := identity.ByID(ctx, d, id)
	if err != nil || !ok {
		return ""
	}
	return p.Handle
}

// decideParticipant is POST …/participants/:iid/approve and …/decline: a person settles an add an agent asked for.
func decideParticipant(approve bool) handler {
	return func(s *Server, w http.ResponseWriter, r *http.Request, c *call) {
		convID, ok := pathID(w, r)
		if !ok {
			return
		}
		iid, ok := pathIID(w, r)
		if !ok {
			return
		}
		var in struct{}
		if !decode(w, r, &in) {
			return
		}
		now := s.Clock.Now()
		var done bool
		err := s.Store.Writer.Tx(r.Context(), func(ctx context.Context, tx *pdb.Tx) error {
			d := tx.DBTX()
			cv, found, err := conversation.Get(ctx, d, convID)
			if err != nil || !found {
				return err
			}
			seat, seated, err := conversation.SeatOf(ctx, d, convID, iid)
			if err != nil || !seated || seat.Status != conversation.StatusPending {
				return err
			}
			status := conversation.StatusDeclined
			if approve {
				status = conversation.StatusActive
			}
			// The conversation says how the request ended: "Approved · @docs added" or "Declined · @docs not added".
			line := message.SystemLine{T: "member.declined", Identity: iid, By: c.p.HumanID}
			if approve {
				line.T = "member.approved"
			}
			if _, _, err := sayLine(ctx, d, now, c.p.HumanID, convID, line); err != nil {
				return err
			}
			if done, err = conversation.Decide(ctx, d, now, convID, iid, c.p.HumanID, approve, seat.JoinedMessageID, seat.JoinedSeq); err != nil || !done {
				return err
			}
			if approve {
				if err := readstate.Create(ctx, d, now, iid, convID, cv.LastMessageID); err != nil {
					return err
				}
			}
			_, err = journalChange(ctx, d, now, c.p.HumanID, convID, iid, status)
			return err
		})
		switch {
		case err != nil:
			s.internalError(w, r, err)
		case !done:
			writeErr(w, http.StatusNotFound, "not_found", "No such pending add.")
		default:
			s.Bus.Notify(iid)
			writeJSON(w, http.StatusOK, map[string]any{})
		}
	}
}

// removeParticipant is DELETE /api/conversations/:id/participants/:iid: a person takes an agent out.
func (s *Server) removeParticipant(w http.ResponseWriter, r *http.Request, c *call) {
	convID, ok := pathID(w, r)
	if !ok {
		return
	}
	iid, ok := pathIID(w, r)
	if !ok {
		return
	}
	s.endSeat(w, r, c, convID, iid, conversation.StatusRemoved)
}

// leaveConversation is POST /api/conversations/:id/leave: an agent leaves by itself. The owner has no seat to leave.
func (s *Server) leaveConversation(w http.ResponseWriter, r *http.Request, c *call) {
	convID, ok := pathID(w, r)
	if !ok {
		return
	}
	if c.p.SessionID == 0 {
		writeErr(w, http.StatusBadRequest, "invalid_request", "The owner does not leave a conversation; delete it instead.")
		return
	}
	s.endSeat(w, r, c, convID, c.p.Identity(), conversation.StatusLeft)
}

// endSeat takes one active agent out of a conversation, for the routes that remove and leave. One transaction (I-19):
// the seat ends, the pickup is released, the agent's open and dismissed asks close, its other inbox items expire, a
// removal leaves ONE notice for it, and the conversation says so.
func (s *Server) endSeat(w http.ResponseWriter, r *http.Request, c *call, convID, who int64, status string) {
	now := s.Clock.Now()
	var visible, ended, human bool
	err := s.Store.Writer.Tx(r.Context(), func(ctx context.Context, tx *pdb.Tx) error {
		d := tx.DBTX()
		_, found, err := conversation.Get(ctx, d, convID)
		if err != nil || !found {
			return err
		}
		if _, visible, err = canSee(ctx, d, c.p, convID); err != nil || !visible {
			return err
		}
		target, found, err := identity.ByID(ctx, d, who)
		if err != nil || !found {
			return err
		}
		if target.Kind != "agent" {
			human = true
			return nil
		}
		if ended, err = conversation.End(ctx, d, now, convID, who, status); err != nil || !ended {
			return err
		}
		if _, err := conversation.ReleaseOf(ctx, d, convID, who); err != nil {
			return err
		}
		if err := ask.CloseForRemoval(ctx, d, askPorts(c.p, &askEffects{}), now, convID, who); err != nil {
			return err
		}
		line := message.SystemLine{T: "member.removed", Identity: who, By: c.p.Identity()}
		if status == conversation.StatusLeft {
			line = message.SystemLine{T: "member.left", Identity: who}
		}
		lineID, seq, err := sayLine(ctx, d, now, c.p.Identity(), convID, line)
		if err != nil {
			return err
		}
		if status == conversation.StatusRemoved {
			err = inbox.Removed(ctx, d, now, who, convID, lineID, seq)
		} else {
			err = inbox.Left(ctx, d, now, who, convID)
		}
		if err != nil {
			return err
		}
		_, err = journalChange(ctx, d, now, c.p.Identity(), convID, who, status)
		return err
	})
	switch {
	case err != nil:
		s.internalError(w, r, err)
	case !visible:
		notVisible(w, c)
	case human:
		writeErr(w, http.StatusBadRequest, "invalid_request", "Only an agent can be removed from a conversation.")
	case !ended:
		writeErr(w, http.StatusNotFound, "not_found", "That agent is not in the conversation.")
	default:
		s.Bus.Notify(who)
		writeJSON(w, http.StatusOK, map[string]any{})
	}
}

// addMentioned brings in the agents a person's message @mentions, at once (I-18): each sees the message itself and
// what follows, and its inbox gets a mention. It runs inside the post's transaction, after the message is stored.
// An agent that cannot be added (unknown, disabled, a full conversation) is skipped; the message is still sent.
func addMentioned(ctx context.Context, d pdb.DBTX, now time.Time, conv, author, messageID int64, handles []string) error {
	if len(handles) == 0 {
		return nil
	}
	seq, err := event.MaxSeq(ctx, d)
	if err != nil {
		return err
	}
	seq++ // the event of this very message is the next one
	for _, h := range handles {
		target, found, err := identity.Lookup(ctx, d, h)
		if err != nil {
			return err
		}
		if !found || target.Kind != "agent" || target.Disabled {
			continue
		}
		changed, err := conversation.Add(ctx, d, now, conversation.Join{
			Conversation: conv, Identity: target.ID, By: author, Status: conversation.StatusActive, FloorID: messageID - 1, Seq: seq,
		})
		if err == conversation.ErrFull {
			continue
		}
		if err != nil {
			return err
		}
		if changed {
			if err := readstate.Create(ctx, d, now, target.ID, conv, messageID); err != nil {
				return err
			}
			if _, err := journalChange(ctx, d, now, author, conv, target.ID, conversation.StatusActive); err != nil {
				return err
			}
		}
		if err := inbox.Mention(ctx, d, now, target.ID, conv, messageID, seq); err != nil {
			return err
		}
	}
	return nil
}
