package httpapi

import (
	"context"
	"errors"
	"math"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/appkit"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/ask"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/audit"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/auth"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/conversation"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/event"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/message"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/upload"
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
	if !wire.ValidClientID(in.ClientID) {
		writeFieldErr(w, http.StatusBadRequest, "invalid_request", "client_id", "The client id must be 8 to 64 characters without spaces.")
		return
	}
	who, now := c.p.Identity(), s.Clock.Now()
	isAgent := c.p.SessionID != 0
	app := []byte(in.App)
	if string(app) == "null" {
		app = nil
	}
	if len(app) > 0 && !isAgent {
		writeFieldErr(w, http.StatusForbidden, "forbidden", "app", "Only an agent posts an app.")
		return
	}
	if in.ViaApp != nil && (isAgent || len(app) > 0) {
		writeFieldErr(w, http.StatusForbidden, "forbidden", "via_app", "Only the owner sends a result through an app.")
		return
	}
	if isAgent && !s.withinBudgets(w, c, now) {
		return
	}
	uploadIDs := in.UploadIDs
	if len(app) > 0 {
		checked, err := appkit.Check(r.Context(), s.reader(), uploadFiles{}, who, app)
		if appRefused(w, err) {
			return
		}
		if err != nil {
			s.internalError(w, r, err)
			return
		}
		app = checked.Canonical()
		uploadIDs = append(uploadIDs, appkit.UploadIDs(checked)...) // the app's files join its message, once (I-31)
	}
	draft := message.Draft{
		Conversation: convID, Author: who, Session: c.p.SessionID, Device: c.dev.ID, ClientID: in.ClientID, Body: in.Body, Format: in.Format,
		ThreadRoot: in.ThreadRoot, Broadcast: in.Broadcast, App: app, UploadIDs: uploadIDs,
	}
	if in.ViaApp != nil {
		via, ok := s.viaApp(w, r, c, convID, *in.ViaApp)
		if !ok {
			return
		}
		draft.ViaApp, draft.Body, draft.Format = &message.ViaApp{Message: via.Message, Agent: via.Agent, Result: via.Result}, via.Summary, "plain"
	}
	if isAgent {
		draft.Origin = message.Origin{Label: c.lease.Label, Machine: c.lease.Machine}
	}
	var posted message.Posted
	err := s.Store.Writer.Tx(r.Context(), func(ctx context.Context, tx *pdb.Tx) (err error) {
		posted, err = message.Post(ctx, tx.DBTX(), messagePorts(c.p), now, draft)
		return err
	})
	if s.messageRefused(w, err) {
		return
	}
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	status := http.StatusCreated
	if posted.Replayed {
		status = http.StatusOK
	} else {
		s.Bus.Notify(posted.Wake...)
		if isAgent {
			s.countDailyPost(c, now)
			s.publishWorking(r.Context(), who, convID, false, 0)
		}
	}
	writeJSON(w, status, wire.PostResponse{ID: posted.Message.ID, ConversationID: convID, CreatedAt: posted.Message.CreatedAt})
}

// withinBudgets applies the three rate limits of an agent that writes to a conversation (a message or an ask). It writes the 429 itself.
// It only reads the daily caps; countDailyPost spends them once the message is stored.
func (s *Server) withinBudgets(w http.ResponseWriter, c *call, now time.Time) bool {
	identityKey, machineKey := capKeys(c)
	if !s.postLimit.Allow(identityKey, now) {
		tooMany(w, s.postLimit.RetryAfter(identityKey, now), "Too many messages. Slow down.")
		return false
	}
	if wait := max(s.dayIdentityLimit.RetryAfter(identityKey, now), s.dayMachineLimit.RetryAfter(machineKey, now)); wait > 0 {
		tooMany(w, wait, "The daily message limit is reached.")
		return false
	}
	return true
}

// countDailyPost counts one stored message against the daily caps. A refused or replayed post is not counted,
// so a bad request or a retry cannot use up an agent's day.
func (s *Server) countDailyPost(c *call, now time.Time) {
	identityKey, machineKey := capKeys(c)
	s.dayIdentityLimit.Allow(identityKey, now)
	s.dayMachineLimit.Allow(machineKey, now)
}

// capKeys are the rate-limit keys of the calling agent: its identity and its machine.
func capKeys(c *call) (identityKey, machineKey string) {
	return strconv.FormatInt(c.lease.IdentityID, 10), strconv.FormatInt(c.lease.MachineID, 10)
}

// tooMany answers 429 with the wait in the Retry-After header and in the body, whole seconds, at least 1.
func tooMany(w http.ResponseWriter, wait time.Duration, text string) {
	secs := max(int(math.Ceil(wait.Seconds())), 1)
	w.Header().Set("Retry-After", strconv.Itoa(secs))
	writeJSON(w, http.StatusTooManyRequests, wire.Error{Error: wire.ErrorDetail{Code: "rate_limited", Message: text, RetryAfter: secs}})
}

// messageRefused answers an error of the message module and reports whether it was one it knows.
func (s *Server) messageRefused(w http.ResponseWriter, err error) bool {
	switch {
	case err == nil:
		return false
	case errors.Is(err, message.ErrTooLarge):
		writeFieldErr(w, http.StatusBadRequest, "too_large", "body", "A message body has at most 16384 bytes.")
	case appRefused(w, err):
	case errors.Is(err, message.ErrAppTooLarge):
		writeFieldErr(w, http.StatusBadRequest, "too_large", "app", "An app has at most 65536 bytes.")
	case errors.Is(err, message.ErrTooManyUploads):
		writeFieldErr(w, http.StatusBadRequest, "invalid_request", "upload_ids", "A message carries at most 10 attachments.")
	case errors.Is(err, message.ErrTooManyURLs):
		writeFieldErr(w, http.StatusBadRequest, "invalid_request", "body", "A message has at most 5 links.")
	case errors.Is(err, message.ErrFormat):
		writeFieldErr(w, http.StatusBadRequest, "invalid_request", "format", "The format is markdown, markdownv2 or plain.")
	case errors.Is(err, message.ErrNUL):
		writeFieldErr(w, http.StatusBadRequest, "invalid_request", "body", "The message has a NUL character.")
	case errors.Is(err, message.ErrEmpty):
		writeFieldErr(w, http.StatusBadRequest, "invalid_request", "body", "The message is empty.")
	case errors.Is(err, message.ErrSystemRoot):
		writeFieldErr(w, http.StatusBadRequest, "system_line_no_replies", "thread_root_id", "A system line cannot have replies.")
	case errors.Is(err, message.ErrBadRoot):
		writeFieldErr(w, http.StatusBadRequest, "invalid_request", "thread_root_id", "A reply goes under a top-level message of the same conversation.")
	case errors.Is(err, message.ErrClientIDConflict):
		writeFieldErr(w, http.StatusConflict, "client_id_conflict", "client_id", "That client id was used for a different message.")
	case errors.Is(err, upload.ErrBound), errors.Is(err, upload.ErrUnfinished):
		writeFieldErr(w, http.StatusConflict, "upload_unavailable", "upload_ids", "An upload joins one message, and only when it is finished.")
	case errors.Is(err, upload.ErrNotYours), errors.Is(err, upload.ErrAudioAlone):
		writeFieldErr(w, http.StatusBadRequest, "invalid_request", "upload_ids", "An upload must be yours, from this conversation. A voice note goes alone.")
	case errors.Is(err, message.ErrPaused):
		writeErr(w, http.StatusTooManyRequests, "conversation_paused", "This conversation is paused after 20 agent messages in a row. A person must write or resume it.")
	case errors.Is(err, message.ErrDenied):
		writeErr(w, http.StatusForbidden, "forbidden", "You are not a participant of that conversation.")
	case errors.Is(err, message.ErrMissing), errors.Is(err, message.ErrNotFound):
		writeErr(w, http.StatusNotFound, "not_found", "No such message or conversation.")
	case errors.Is(err, message.ErrNotAuthor):
		writeErr(w, http.StatusForbidden, "forbidden", "Only the author may do that.")
	case errors.Is(err, message.ErrNotEditable):
		writeErr(w, http.StatusBadRequest, "not_editable", "This kind of message cannot be changed.")
	case errors.Is(err, message.ErrTooOld):
		writeErr(w, http.StatusForbidden, "too_old", "An agent may edit a message for 24 hours.")
	default:
		return false
	}
	return true
}

// ---- reading ------------------------------------------------------------------------------------------

// viewMessages turns stored messages into what a reader gets: names looked up now, a tombstone for a deleted one, the words of
// a system line, and for an agent's message the session and machine it came from (I-40).
func viewMessages(dir directory, list []message.Message) []wire.Message {
	out := make([]wire.Message, 0, len(list))
	for _, m := range list {
		out = append(out, viewMessage(dir, m))
	}
	return out
}

func viewMessage(dir directory, m message.Message) wire.Message {
	v := dir.message(m)
	if m.Kind != "text" {
		v.Kind = m.Kind
	}
	v.ThreadRootID, v.Broadcast, v.ReplyCount, v.LastReplyAt, v.EditedAt = m.ThreadRootID, m.Broadcast, m.ReplyCount, m.LastReplyAt, m.EditedAt
	v.Deleted, v.Purged, v.AnswersAsk = m.Deleted, m.Purged, m.AnswersAskID
	v.SessionLabel, v.Machine = m.OriginLabel, m.OriginMachine
	return v
}

// systemView reads a system line's ids back into people and its words.
func systemView(dir directory, m message.Message) (*wire.System, string) {
	line, ok := message.ParseSystem(m.System)
	if !ok {
		return nil, ""
	}
	sys := &wire.System{T: line.T, Via: line.Via, History: line.History, Streak: line.Streak, From: line.From, To: line.To}
	proj := message.ProjectSystem{T: line.T, History: line.History, Streak: line.Streak, From: line.From, To: line.To}
	if line.Identity != 0 {
		p := dir.person(line.Identity)
		sys.Identity, proj.Identity = &p, message.Person{Handle: p.Handle, Name: p.DisplayName}
	}
	if line.By != 0 {
		p := dir.person(line.By)
		sys.By, proj.By = &p, message.Person{Handle: p.Handle, Name: p.DisplayName}
	}
	return sys, message.Project(message.Projectable{System: &proj}, message.Long)
}

// listMessages is GET /api/conversations/:id/messages: oldest first. after=N the oldest page past N, before=N the
// newest page before N, neither the newest page. Messages from before the caller joined are never shown. A deleted
// message is a tombstone in its place; a system line has no author. thread=ID reads one thread instead: its root (a stub
// when the caller joined after it) and the replies the caller may see.
func (s *Server) listMessages(w http.ResponseWriter, r *http.Request, c *call) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	before, hasBefore, ok1 := intParam(w, r, "before")
	after, hasAfter, ok2 := intParam(w, r, "after")
	limit, _, ok3 := intParam(w, r, "limit")
	root, hasThread, ok4 := intParam(w, r, "thread")
	if !ok1 || !ok2 || !ok3 || !ok4 {
		return
	}
	ctx, d := r.Context(), s.reader()
	_, found, err := conversation.Get(ctx, d, id)
	var floor int64
	var visible bool
	if err == nil && found {
		floor, visible, err = canSee(ctx, d, c.p, id)
	}
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	if !found || !visible {
		notVisible(w, c)
		return
	}
	if hasThread {
		if m, ok, err := message.Get(ctx, d, root); err != nil {
			s.internalError(w, r, err)
			return
		} else if !ok || m.ConversationID != id {
			writeErr(w, http.StatusNotFound, "not_found", "No such thread.")
			return
		}
	}
	seq, err := event.MaxSeq(ctx, d)
	var page []message.Message
	if err == nil {
		switch {
		case hasThread:
			page, err = message.Thread(ctx, d, id, root, floor, int(limit))
		case hasAfter:
			page, err = message.After(ctx, d, id, after, floor, int(limit))
		case hasBefore:
			page, err = message.Before(ctx, d, id, before, floor, int(limit))
		default:
			page, err = message.Newest(ctx, d, id, floor, int(limit))
		}
	}
	var dir directory
	if err == nil {
		dir, err = loadDirectory(ctx, d)
	}
	var asks map[int64]wire.AskView
	if err == nil {
		asks, err = askViewsOf(ctx, d, dir, page)
	}
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	out := viewMessages(dir, page)
	for i, m := range page {
		if v, ok := asks[m.ID]; ok {
			v.App = out[i].App
			out[i].Ask = &v
		}
	}
	if err := attachSlice(ctx, d, out); err != nil {
		s.internalError(w, r, err)
		return
	}
	if hasThread {
		out = threadWithStub(out, root, floor)
	}
	writeJSON(w, http.StatusOK, wire.MessagesResponse{Messages: out, AsOfSeq: seq})
}

// threadStubWords stands in for a thread root the caller may not see (I-7).
const threadStubWords = "earlier message not shown"

// threadWithStub puts a stub for the root in front of the replies when the root is older than the caller's floor.
func threadWithStub(replies []wire.Message, root, floor int64) []wire.Message {
	if root > floor {
		return replies
	}
	stub := wire.Message{ID: root, Author: systemAuthor, Body: threadStubWords, Format: "plain"}
	return append([]wire.Message{stub}, replies...)
}

// askViewsOf reads the asks that the messages of a page carry, by message id: each with its options and history.
func askViewsOf(ctx context.Context, d pdb.DBTX, dir directory, page []message.Message) (map[int64]wire.AskView, error) {
	var ids []int64
	for _, m := range page {
		if m.Kind == "ask" {
			ids = append(ids, m.ID)
		}
	}
	asks, err := ask.Views(ctx, d, ids)
	out := make(map[int64]wire.AskView, len(asks))
	for id, a := range asks {
		out[id] = dir.askBase(a)
	}
	return out, err
}

// listEdits is GET /api/messages/:id/edits: the earlier texts of a message, for anyone who can see it (M-13).
func (s *Server) listEdits(w http.ResponseWriter, r *http.Request, c *call) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	ctx, d := r.Context(), s.reader()
	list, err := message.History(ctx, d, messagePorts(c.p), id)
	var dir directory
	if err == nil {
		dir, err = loadDirectory(ctx, d)
	}
	if s.messageRefused(w, err) {
		return
	}
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	out := wire.HistoryResponse{Edits: make([]wire.PastEdit, 0, len(list))}
	for _, e := range list {
		out.Edits = append(out.Edits, wire.PastEdit{Body: e.Body, Format: e.Format, EditedAt: e.At, By: dir.person(e.By)})
	}
	writeJSON(w, http.StatusOK, out)
}

// ---- edit, delete, purge ------------------------------------------------------------------------------

// Agents may edit 30 times an hour (design §13.1): edits bypass the loop breaker, so they have a budget of their own.
const agentEditsPerHour = 30

// messageBudgets are the rate budgets of this module that the shared Server struct does not carry. One set per server.
type messageBudgets struct{ edits auth.Limiter }

var budgetsOf sync.Map // *Server -> *messageBudgets

func (s *Server) budgets() *messageBudgets {
	b, _ := budgetsOf.LoadOrStore(s, &messageBudgets{edits: auth.Limiter{Window: time.Hour, Max: agentEditsPerHour}})
	return b.(*messageBudgets)
}

func actorOf(c *call) message.Actor {
	return message.Actor{Identity: c.p.Identity(), Agent: c.p.SessionID != 0, Owner: c.p.SessionID == 0 && c.p.Role == "owner"}
}

// editMessage is PATCH /api/messages/:id: the author changes the text. Any other field is a 400 (I-8). The same client id
// again answers 200 with the message as it reads now.
func (s *Server) editMessage(w http.ResponseWriter, r *http.Request, c *call) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	var in wire.EditRequest
	if !decode(w, r, &in) {
		return
	}
	if !wire.ValidClientID(in.ClientID) {
		writeFieldErr(w, http.StatusBadRequest, "invalid_request", "client_id", "The client id must be 8 to 64 characters without spaces.")
		return
	}
	who, now := actorOf(c), s.Clock.Now()
	if who.Agent {
		if key := strconv.FormatInt(who.Identity, 10); !s.budgets().edits.Allow(key, now) {
			tooMany(w, s.budgets().edits.RetryAfter(key, now), "Too many edits. Slow down.")
			return
		}
	}
	var m message.Message
	err := s.Store.Writer.Tx(r.Context(), func(ctx context.Context, tx *pdb.Tx) (err error) {
		d := tx.DBTX()
		if _, replay, err := event.FindIdem(ctx, d, who.Identity, "message.edit:"+in.ClientID); err != nil || replay {
			if err != nil {
				return err
			}
			m, _, err = message.GetAny(ctx, d, id)
			return err
		}
		m, _, err = message.Edit(ctx, d, messagePorts(c.p), now, who, id, in.Body, in.Format, in.ClientID)
		return err
	})
	if s.messageRefused(w, err) {
		return
	}
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	s.Bus.Notify()
	s.writeEdited(w, r, m)
}

// writeEdited answers an edit, delete or purge with the message as it reads now.
func (s *Server) writeEdited(w http.ResponseWriter, r *http.Request, m message.Message) {
	dir, err := loadDirectory(r.Context(), s.reader())
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	v := viewMessage(dir, m)
	if err := attachUploads(r.Context(), s.reader(), []*wire.Message{&v}); err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, wire.EditResponse{Message: v})
}

// deleteMessage is DELETE /api/messages/:id: the author deletes their own, the owner any. It leaves a tombstone and hides
// every copy at once (E-16).
func (s *Server) deleteMessage(w http.ResponseWriter, r *http.Request, c *call) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	who, now := actorOf(c), s.Clock.Now()
	var m message.Message
	err := s.Store.Writer.Tx(r.Context(), func(ctx context.Context, tx *pdb.Tx) (err error) {
		m, err = message.Delete(ctx, tx.DBTX(), messagePorts(c.p), now, who, id)
		return err
	})
	if s.messageRefused(w, err) {
		return
	}
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	if m.Kind == "ask" {
		s.Bus.Notify(m.AuthorID) // the asking agent's inbox got a "resolved" item
	} else {
		s.Bus.Notify()
	}
	s.writeEdited(w, r, m)
}

// purgeMessage is POST /api/messages/:id/purge: the owner scrubs a message for good, with a fresh passkey check (I-49).
func (s *Server) purgeMessage(w http.ResponseWriter, r *http.Request, c *call) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	who, now := actorOf(c), s.Clock.Now()
	var m message.Message
	err := s.Store.Writer.Tx(r.Context(), func(ctx context.Context, tx *pdb.Tx) (err error) {
		d := tx.DBTX()
		if err := auth.ConsumeStepUp(ctx, d, c.stepUp, c.dev.ID, "message.purge", &id, now); err != nil {
			return err
		}
		if m, err = message.Purge(ctx, d, messagePorts(c.p), now, who, id); err != nil {
			return err
		}
		return audit.Write(ctx, d, now, audit.Entry{Actor: who.Identity, Device: c.dev.ID, Action: "message.purge", TargetKind: "message", TargetID: id,
			Detail: map[string]any{"conversation_id": m.ConversationID}})
	})
	if errors.Is(err, auth.ErrStepUp) {
		stepUpInvalid(w)
		return
	}
	if s.messageRefused(w, err) {
		return
	}
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	s.Bus.Notify()
	s.writeEdited(w, r, m)
}

// resumeConversation is POST /api/conversations/:id/resume: a person lets agents post again after the loop breaker
// paused the conversation (I-16). A conversation that is not paused is left as it is.
func (s *Server) resumeConversation(w http.ResponseWriter, r *http.Request, c *call) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	var in struct{}
	if !decode(w, r, &in) {
		return
	}
	var lifted bool
	err := s.Store.Writer.Tx(r.Context(), func(ctx context.Context, tx *pdb.Tx) (err error) {
		d := tx.DBTX()
		if _, found, err := conversation.Get(ctx, d, id); err != nil {
			return err
		} else if !found {
			return message.ErrMissing
		}
		now := s.Clock.Now()
		if lifted, err = message.Resume(ctx, d, messagePorts(c.p), now, id, c.p.Identity()); err != nil || !lifted {
			return err
		}
		return conversation.Touch(ctx, d, now, id) // the resume line moves the conversation up the list
	})
	if s.messageRefused(w, err) {
		return
	}
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	s.Bus.Notify()
	writeJSON(w, http.StatusOK, map[string]bool{"resumed": lifted})
}
