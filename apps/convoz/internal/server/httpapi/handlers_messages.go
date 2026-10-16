package httpapi

import (
	"context"
	"errors"
	"math"
	"net/http"
	"strconv"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/auth"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/message"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

// postMessage is POST /api/conversations/:id/messages. It decodes, opens the transaction, runs message.Post
// (the write of the message, counters, cursor, inbox items and events: I-4, I-43) and maps the answer.
// The author is always the caller (I-40): the body has no author field and an unknown field is a 400.
func (s *Server) postMessage(w http.ResponseWriter, r *http.Request, c *call) {
	convID, ok := pathID(w, r)
	if !ok {
		return
	}
	var in wire.PostRequest
	if !decode(w, r, &in) {
		return
	}
	if !auth.ValidClientID(in.ClientID) {
		writeFieldErr(w, http.StatusBadRequest, "invalid_request", "client_id", "The client id must be 8 to 64 characters without spaces.")
		return
	}
	who, now := c.p.Identity(), s.Clock.Now()
	isAgent := c.p.SessionID != 0
	if isAgent && !s.agentMayPost(w, c, now) {
		return
	}
	var posted message.Posted
	err := s.Store.Writer.Tx(r.Context(), func(ctx context.Context, tx *pdb.Tx) (err error) {
		posted, err = message.Post(ctx, tx.DBTX(), messagePorts(c.p), now, message.Draft{
			Conversation: convID, Author: who, Session: c.p.SessionID, Device: c.dev.ID, ClientID: in.ClientID, Body: in.Body, Format: in.Format,
		})
		return err
	})
	switch {
	case errors.Is(err, message.ErrEmpty), errors.Is(err, message.ErrTooLarge), errors.Is(err, message.ErrFormat), errors.Is(err, message.ErrNUL):
		s.messageRefused(w, err)
	case errors.Is(err, message.ErrClientIDConflict):
		writeFieldErr(w, http.StatusConflict, "client_id_conflict", "client_id", "That client id was used for a different message.")
	case errors.Is(err, message.ErrDenied):
		writeErr(w, http.StatusForbidden, "forbidden", "You are not a participant of that conversation.")
	case errors.Is(err, message.ErrMissing):
		writeErr(w, http.StatusNotFound, "not_found", "No such conversation.")
	case err != nil:
		s.internalError(w, r, err)
	default:
		status := http.StatusCreated
		if posted.Replayed {
			status = http.StatusOK
		} else {
			s.Bus.Notify(posted.Wake...)
			if isAgent {
				s.publishWorking(r.Context(), who, convID, false, 0)
			}
		}
		writeJSON(w, status, wire.PostResponse{ID: posted.Message.ID, ConversationID: convID, CreatedAt: posted.Message.CreatedAt})
	}
}

// agentMayPost applies the post scope and the three rate limits to an agent's post. It writes the refusal itself.
func (s *Server) agentMayPost(w http.ResponseWriter, c *call, now time.Time) bool {
	if c.lease.Scopes&auth.ScopePost == 0 {
		writeErr(w, http.StatusForbidden, "forbidden", "This machine may not post.")
		return false
	}
	identityKey, machineKey := strconv.FormatInt(c.lease.IdentityID, 10), strconv.FormatInt(c.lease.MachineID, 10)
	if !s.postLimit.Allow(identityKey, now) {
		tooMany(w, time.Second, "Too many messages. Slow down.")
		return false
	}
	if wait := max(s.dayIdentityLimit.RetryAfter(identityKey, now), s.dayMachineLimit.RetryAfter(machineKey, now)); wait > 0 {
		tooMany(w, wait, "The daily message limit is reached.")
		return false
	}
	s.dayIdentityLimit.Allow(identityKey, now)
	s.dayMachineLimit.Allow(machineKey, now)
	return true
}

// tooMany answers 429 with the wait in the Retry-After header and in the body, whole seconds, at least 1.
func tooMany(w http.ResponseWriter, wait time.Duration, message string) {
	secs := max(int(math.Ceil(wait.Seconds())), 1)
	w.Header().Set("Retry-After", strconv.Itoa(secs))
	writeJSON(w, http.StatusTooManyRequests, wire.Error{Error: wire.ErrorDetail{Code: "rate_limited", Message: message, RetryAfter: secs}})
}

// messageRefused answers a message the module refused.
func (s *Server) messageRefused(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, message.ErrTooLarge):
		writeFieldErr(w, http.StatusBadRequest, "too_large", "body", "A message body has at most 16384 bytes.")
	case errors.Is(err, message.ErrFormat):
		writeFieldErr(w, http.StatusBadRequest, "invalid_request", "format", "The format is markdown, markdownv2 or plain.")
	case errors.Is(err, message.ErrNUL):
		writeFieldErr(w, http.StatusBadRequest, "invalid_request", "body", "The message has a NUL character.")
	default:
		writeFieldErr(w, http.StatusBadRequest, "invalid_request", "body", "The message is empty.")
	}
}
