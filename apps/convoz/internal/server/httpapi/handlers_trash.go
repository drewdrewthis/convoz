package httpapi

import (
	"context"
	"io/fs"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/audit"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/conversation"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/event"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/inbox"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/message"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/prefs"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/upload"
)

// answerChange ends a route that changes a conversation: 200 {}, or the "not there" answer when the transaction
// found nothing.
func (s *Server) answerChange(w http.ResponseWriter, r *http.Request, c *call, err error, found bool) {
	switch {
	case err != nil:
		s.internalError(w, r, err)
	case !found:
		notVisible(w, c)
	default:
		s.Bus.Notify()
		writeJSON(w, http.StatusOK, map[string]any{})
	}
}

// patchConversation is PATCH /api/conversations/:id: the owner renames it or links its pull request. A chosen title is
// never changed by a later message. An agent that is a participant may rename it too (see renameAsAgent), but only that.
func (s *Server) patchConversation(w http.ResponseWriter, r *http.Request, c *call) {
	convID, ok := pathID(w, r)
	if !ok {
		return
	}
	var in struct {
		Title   *string `json:"title"`
		LinkURL *string `json:"link_url"`
	}
	if !decode(w, r, &in) {
		return
	}
	isAgent := c.p.SessionID != 0
	var title string
	if in.Title != nil {
		title = strings.TrimSpace(*in.Title)
		if isAgent { // an agent's title is untrusted text: control and bidi characters go, the rest is checked as usual
			title = conversation.CleanTitle(title)
		}
		if !conversation.ValidTitle(title) {
			writeFieldErr(w, http.StatusBadRequest, "invalid_request", "title", "A title has 1 to 120 characters.")
			return
		}
	}
	if in.LinkURL != nil && *in.LinkURL != "" && !conversation.ValidLink(*in.LinkURL) {
		writeFieldErr(w, http.StatusBadRequest, "invalid_request", "link_url", "A link starts with https:// and has at most 500 characters.")
		return
	}
	if isAgent {
		switch {
		case in.LinkURL != nil:
			writeErr(w, http.StatusForbidden, "forbidden", "An agent may only rename a conversation.")
		case in.Title == nil:
			writeFieldErr(w, http.StatusBadRequest, "invalid_request", "title", "Say the new title.")
		default:
			s.renameAsAgent(w, r, c, convID, title)
		}
		return
	}
	var found bool
	err := s.Store.Writer.Tx(r.Context(), func(ctx context.Context, tx *pdb.Tx) (err error) {
		d := tx.DBTX()
		if _, found, err = conversation.Get(ctx, d, convID); err != nil || !found {
			return err
		}
		if _, found, err = canSee(ctx, d, c.p, convID); err != nil || !found {
			return err
		}
		if in.Title != nil {
			if err := conversation.Rename(ctx, d, convID, title, conversation.TitleHuman); err != nil {
				return err
			}
		}
		if in.LinkURL != nil {
			if err := conversation.SetLink(ctx, d, convID, *in.LinkURL); err != nil {
				return err
			}
		}
		_, err = event.Write(ctx, d, s.Clock.Now(), event.Entry{Type: eventConversationChanged, Actor: c.p.Identity(), Conversation: convID, Payload: map[string]any{"conversation_id": convID}})
		return err
	})
	if err == nil && found {
		s.writeDetail(w, r, c, convID)
		return
	}
	s.answerChange(w, r, c, err, found)
}

// writeDetail answers a change with the conversation as the caller now sees it.
func (s *Server) writeDetail(w http.ResponseWriter, r *http.Request, c *call, convID int64) {
	v, _, err := s.visibleDetail(r.Context(), s.reader(), c.p, convID)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	s.Bus.Notify()
	writeJSON(w, http.StatusOK, map[string]any{"conversation": v})
}

// agentRenamesPerHour is how often one agent may rename one conversation within an hour.
const agentRenamesPerHour = 3

// renameAsAgent is the agent's PATCH: a participant renames a title that is automatic or an agent's own; a title a person
// set is theirs (409 title_owner_set, with no timer). The rename says so in a system line that quotes the new title, and
// the event and the audit line name the agent, not a person. A non-participant is told what any read would tell it.
func (s *Server) renameAsAgent(w http.ResponseWriter, r *http.Request, c *call, convID int64, title string) {
	who, now := c.p.Identity(), s.Clock.Now()
	key := strconv.FormatInt(who, 10) + "|" + strconv.FormatInt(convID, 10)
	var visible, ownerSet bool
	var wait time.Duration
	err := s.Store.Writer.Tx(r.Context(), func(ctx context.Context, tx *pdb.Tx) error {
		d := tx.DBTX()
		cv, found, err := conversation.Get(ctx, d, convID)
		if err != nil || !found {
			return err
		}
		if _, visible, err = canSee(ctx, d, c.p, convID); err != nil || !visible {
			return err
		}
		switch {
		case cv.TitleSetBy == conversation.TitleHuman:
			ownerSet = true
			return nil
		case cv.Title == title && cv.TitleSetBy == conversation.TitleAgent:
			return nil // nothing to change, so no line and no spent rename
		}
		if wait = s.budgets().renames.RetryAfter(key, now); wait > 0 {
			return nil
		}
		s.budgets().renames.Allow(key, now)
		if err := conversation.Rename(ctx, d, convID, title, conversation.TitleAgent); err != nil {
			return err
		}
		if _, _, err := sayLine(ctx, d, now, who, convID, message.SystemLine{T: "conversation.renamed", By: who, Title: title}); err != nil {
			return err
		}
		if _, err := event.Write(ctx, d, now, event.Entry{Type: eventConversationChanged, Actor: who, Session: c.p.SessionID, Conversation: convID, Payload: map[string]any{"conversation_id": convID}}); err != nil {
			return err
		}
		return audit.Write(ctx, d, now, audit.Entry{
			Actor: who, Machine: c.p.LeaseMachine, Session: c.p.SessionID,
			Action: "conversation.rename", TargetKind: "conversation", TargetID: convID,
		})
	})
	switch {
	case err != nil:
		s.internalError(w, r, err)
	case !visible:
		notVisible(w, c)
	case ownerSet:
		writeErr(w, http.StatusConflict, "title_owner_set", "A person chose this title. Only a person can change it.")
	case wait > 0:
		tooMany(w, wait, "Too many renames of this conversation. Slow down.")
	default:
		s.writeDetail(w, r, c, convID)
	}
}

// deleteConversation is DELETE /api/conversations/:id: the owner moves it to the trash for 30 days (I-49). Agents lose
// sight of it at once.
func (s *Server) deleteConversation(w http.ResponseWriter, r *http.Request, c *call) {
	convID, ok := pathID(w, r)
	if !ok {
		return
	}
	now := s.Clock.Now()
	var found bool
	err := s.Store.Writer.Tx(r.Context(), func(ctx context.Context, tx *pdb.Tx) (err error) {
		d := tx.DBTX()
		if found, err = conversation.Delete(ctx, d, now, convID, c.p.HumanID); err != nil || !found {
			return err
		}
		_, err = event.Write(ctx, d, now, event.Entry{Type: "conversation.deleted.v1", Actor: c.p.HumanID, Conversation: convID, Payload: map[string]any{"conversation_id": convID}})
		return err
	})
	s.answerChange(w, r, c, err, found)
}

// restoreConversation is POST /api/conversations/:id/restore: it comes back from the trash with all its messages.
func (s *Server) restoreConversation(w http.ResponseWriter, r *http.Request, c *call) {
	convID, ok := pathID(w, r)
	if !ok {
		return
	}
	now := s.Clock.Now()
	var found bool
	err := s.Store.Writer.Tx(r.Context(), func(ctx context.Context, tx *pdb.Tx) (err error) {
		d := tx.DBTX()
		if found, err = conversation.Restore(ctx, d, convID); err != nil || !found {
			return err
		}
		_, err = event.Write(ctx, d, now, event.Entry{Type: "conversation.restored.v1", Actor: c.p.HumanID, Conversation: convID, Payload: map[string]any{"conversation_id": convID}})
		return err
	})
	if err == nil && found {
		s.writeDetail(w, r, c, convID)
		return
	}
	s.answerChange(w, r, c, err, found)
}

// maintainEvery is how often a read of the list runs the clean-up jobs when no nightly run did.
const maintainEvery = time.Minute

// maintainSoon runs Maintain when a minute of server time passed since the last run, so the empty-conversation
// clean-up (24 h) and the trash purge (30 d) happen even if nothing else triggers them. A failure is logged only.
func (s *Server) maintainSoon(ctx context.Context) {
	// Serialised on purpose: a reader that lost a race for the run must not list before the winner's clean-up commits.
	s.maintaining.Lock()
	defer s.maintaining.Unlock()
	now := s.Clock.Now().UnixMilli()
	if now-s.maintainedAt.Load() < maintainEvery.Milliseconds() {
		return
	}
	// The run outlives the request: a page that reloads aborts its list read, and an interrupted clean-up must not make the next
	// reader skip it. The stamp is set only after a run succeeded, so a failed run is tried again by the next list read.
	if err := s.Maintain(context.WithoutCancel(ctx)); err != nil {
		s.Log.Printf("maintenance: %v", err)
		return
	}
	s.maintainedAt.Store(now)
}

// Maintain runs the nightly jobs of conversations (and wakes the snoozes whose time has come): it removes empty untitled conversations older than 24 hours (unless
// starred, I-20) and purges what has been in the trash for over 30 days (I-49). After a purge it empties the log, so
// no readable trace of the purged rows stays in the data files.
func (s *Server) Maintain(ctx context.Context) error {
	if err := s.wakeSnoozes(ctx); err != nil {
		return err
	}
	now := s.Clock.Now()
	var purged int64
	var expired []string
	err := s.Store.Writer.Tx(ctx, func(ctx context.Context, tx *pdb.Tx) (err error) {
		d := tx.DBTX()
		starred := func(conv int64) (bool, error) { return prefs.StarredByAnyone(ctx, d, conv) }
		if _, err = conversation.CleanEmpty(ctx, d, now, starred); err != nil {
			return err
		}
		if purged, err = conversation.PurgeTrash(ctx, d, now); err != nil {
			return err
		}
		if expired, err = upload.Expire(ctx, d, now); err != nil { // an upload nobody bound within 24 hours (a cancelled recording) goes
			return err
		}
		return inbox.Sweep(ctx, d, now)
	})
	if err == nil {
		err = s.sweepFiles(ctx, now, expired)
	}
	if err == nil && purged > 0 {
		s.Bus.Notify()
		err = s.Store.Writer.CheckpointTruncate(ctx)
	}
	return err
}

// sweepFiles unlinks the sealed files of expired uploads, and any file in the blob directory that no row names and that is over an
// hour old (a crash between a delete and its unlink).
func (s *Server) sweepFiles(ctx context.Context, now time.Time, expired []string) error {
	svc := files.Load()
	if svc == nil {
		return nil
	}
	svc.Remove(expired...)
	known, err := upload.KnownFiles(ctx, s.reader())
	if err != nil {
		return err
	}
	svc.Blobs.Sweep(known, func(info fs.FileInfo) bool { return now.Sub(info.ModTime()) > time.Hour })
	return nil
}
