package httpapi

import (
	"context"
	"errors"
	"maps"
	"math"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/appkit"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/ask"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/audit"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/auth"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/authz"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/conversation"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/event"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/identity"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/message"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/unfurl"
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
	if in.ViaVoice && isAgent {
		writeFieldErr(w, http.StatusForbidden, "forbidden", "via_voice", "Only the owner's voice call sends a message by voice.")
		return
	}
	if in.Quiet && (!in.ViaVoice || isAgent) {
		writeFieldErr(w, http.StatusForbidden, "forbidden", "quiet", "Only the owner's voice call posts a quiet message.")
		return
	}
	if in.AsVoice && (isAgent || c.p.Role != "owner" || in.ViaApp != nil) {
		writeFieldErr(w, http.StatusForbidden, "forbidden", "as_voice", "Only the owner's voice call writes as @voice.")
		return
	}
	if isAgent && !needsYouAllowed(w, in) {
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
		ThreadRoot: in.ThreadRoot, Broadcast: in.Broadcast, App: app, UploadIDs: uploadIDs, ViaVoice: in.ViaVoice, Quiet: in.Quiet,
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
		if in.AsVoice {
			if draft.Author, err = voiceAuthor(ctx, tx.DBTX(), who, now); err != nil {
				return err
			}
		}
		posted, err = message.Post(ctx, tx.DBTX(), triagePorts(c.p), now, draft)
		return err
	})
	if errors.Is(err, errVoiceOff) {
		writeFieldErr(w, http.StatusConflict, "voice_unavailable", "as_voice", "@voice is turned off, or another identity holds its name.")
		return
	}
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
			s.askIfBehind(r.Context(), who, convID)
		}
	}
	writeJSON(w, status, wire.PostResponse{ID: posted.Message.ID, ConversationID: convID, CreatedAt: posted.Message.CreatedAt})
}

// errVoiceOff is a post as @voice when @voice cannot write: the owner turned it off, or an identity made before the handle was
// reserved holds its handle or name.
var errVoiceOff = errors.New("@voice cannot write")

// voiceAuthor is @voice, made the first time the owner's call writes (identity.Voice). The post keeps the owner's own access and side
// effects (his reminders, his answers on a thread's asks); only the author is @voice.
func voiceAuthor(ctx context.Context, d pdb.DBTX, owner int64, now time.Time) (int64, error) {
	v, err := identity.Voice(ctx, d, owner, now)
	if errors.Is(err, identity.ErrHandleTaken) || (err == nil && v.Disabled) {
		return 0, errVoiceOff
	}
	return v.ID, err
}

// needsYouWarning is the Convoz-Warning header of an agent post that leaves needs_you out. A later release refuses such a post.
const needsYouWarning = "needs_you will be required; send needs_you:false for news, or use an ask"

// needsYouAllowed applies the needs_you rule to an agent's plain post and writes the 422 itself. It runs before the rate limits, so a
// refused post costs no budget. A message that needs the owner is an ask, so true is never valid here.
func needsYouAllowed(w http.ResponseWriter, in wire.PostRequest) bool {
	switch {
	case in.NeedsYou == nil:
		w.Header().Set("Convoz-Warning", needsYouWarning)
	case *in.NeedsYou:
		writeFieldErr(w, http.StatusUnprocessableEntity, "needs_you_is_an_ask", "needs_you", askPointer(in.Body))
		return false
	}
	return true
}

// askPointer tells an agent how to send what it wrote as an ask, with its own text as the question.
func askPointer(body string) string {
	q := strings.Join(strings.Fields(body), " ")
	if r := []rune(q); len(r) > 200 {
		q = string(r[:200])
	}
	return "A message that needs the owner is an ask (it shows in Now and pushes them): convoz ask --question " + strconv.Quote(q) +
		" --recommend LABEL --why WHY --alt LABEL --alt-why WHY --owners-call one-way|taste|values|scope --owners-call-why WHY <conv>. " +
		"If it does not need the owner, send needs_you false."
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
	sys := &wire.System{T: line.T, Via: line.Via, History: line.History, Streak: line.Streak, Title: line.Title, From: line.From, To: line.To,
		Done: line.Done, Now: line.Now, Next: line.Next, Waiting: line.Waiting, Liveness: line.Liveness}
	proj := message.ProjectSystem{T: line.T, Via: line.Via, History: line.History, Streak: line.Streak, Title: line.Title, From: line.From, To: line.To,
		Done: line.Done, Now: line.Now, Waiting: line.Waiting, Liveness: line.Liveness}
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
// newest page before N, neither the newest page. A deleted
// message is a tombstone in its place; a system line has no author. thread=ID reads the replies of one thread instead.
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
		floor, visible, err = canRead(ctx, d, c.p, id)
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
			out[i].AttachAsk(v)
		}
	}
	if err := attachSlice(ctx, d, out); err != nil {
		s.internalError(w, r, err)
		return
	}
	if err := attachLastRepliesSlice(ctx, d, dir, c.p, id, out); err != nil {
		s.internalError(w, r, err)
		return
	}
	if err := attachUnfurls(ctx, d, c.p, page, out); err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, wire.MessagesResponse{Messages: out, AsOfSeq: seq})
}

// askViewsOf reads the asks that the messages of a page carry, by message id: each with its options, history and app (every page
// that shows an ask card, a thread's root included, shows the app under it).
func askViewsOf(ctx context.Context, d pdb.DBTX, dir directory, page []message.Message) (map[int64]wire.AskView, error) {
	var ids []int64
	apps := map[int64][]byte{}
	for _, m := range page {
		if m.Kind == "ask" {
			ids = append(ids, m.ID)
			apps[m.ID] = m.App
		}
	}
	asks, err := ask.Views(ctx, d, ids)
	out := make(map[int64]wire.AskView, len(asks))
	if err != nil {
		return nil, err
	}
	list := slices.Collect(maps.Values(asks))
	if err := ask.MarkReplyAnswered(ctx, d, askThreads{}, list); err != nil {
		return nil, err
	}
	for _, a := range list {
		v, err := dir.askWithReply(ctx, d, a)
		if err != nil {
			return nil, err
		}
		v.App = appView(apps[a.ID])
		out[a.ID] = v
	}
	return out, nil
}

// listEdits is GET /api/messages/:id/edits: the earlier texts of a message, for anyone who can see it (M-13).
func (s *Server) listEdits(w http.ResponseWriter, r *http.Request, c *call) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	ctx, d := r.Context(), s.reader()
	list, err := message.History(ctx, d, triagePorts(c.p), id)
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

// Agents may edit 30 times an hour (design §13.1): an edit is not a new message, so edits have a budget of their own.
const agentEditsPerHour = 30

// messageBudgets are the rate budgets of this module (and the agent rename budget) that the shared Server struct does not carry. One set per server.
type messageBudgets struct{ edits, renames auth.Limiter }

var budgetsOf sync.Map // *Server -> *messageBudgets

func (s *Server) budgets() *messageBudgets {
	b, _ := budgetsOf.LoadOrStore(s, &messageBudgets{edits: auth.Limiter{Window: time.Hour, Max: agentEditsPerHour}, renames: auth.Limiter{Window: time.Hour, Max: agentRenamesPerHour}})
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

// attachUnfurls puts the card of each link message on the page, from one query, so the web does not ask per message (issue 92). An
// agent gets none: it gets the address and never the fetched page (invariant 24, as getUnfurl).
func attachUnfurls(ctx context.Context, d pdb.DBTX, p authz.Principal, page []message.Message, out []wire.Message) error {
	if p.SessionID != 0 {
		return nil
	}
	var bodies []string
	for _, m := range page {
		if hasCard(m) {
			bodies = append(bodies, m.Body)
		}
	}
	cards, err := unfurl.FindMany(ctx, d, bodies)
	if err != nil {
		return err
	}
	for i, m := range page {
		if c, ok := cards[m.Body]; ok && hasCard(m) {
			out[i].Unfurl = &wire.UnfurlCard{Status: c.Status, URL: c.URL, Kind: c.Kind, Site: c.Site, Title: c.Title, Description: c.Description, Meta: c.Meta}
		}
	}
	return nil
}

// hasCard says whether a message can carry a card: getUnfurl answers 404 for a tombstone and a system line.
func hasCard(m message.Message) bool { return !m.Deleted && !m.Purged && m.Kind != "system" }
