package httpapi

import (
	"context"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/authz"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/conversation"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/event"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/message"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/readstate"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

// markRead is POST /api/conversations/:id/read. The main cursor only moves forward, and never past the newest main message;
// all=true marks the whole conversation read, threads included. With root_id and reply_id it moves one thread's position instead
// (never past its newest reply) - only a thread the reader is in has one (I-14).
func (s *Server) markRead(w http.ResponseWriter, r *http.Request, c *call) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	var in wire.ReadRequest
	if !decode(w, r, &in) {
		return
	}
	switch {
	case in.MainID < 0:
		writeFieldErr(w, http.StatusBadRequest, "invalid_request", "main_id", "main_id must be 0 or more.")
		return
	case in.RootID < 0 || in.ReplyID < 0 || (in.RootID == 0) != (in.ReplyID == 0):
		writeFieldErr(w, http.StatusBadRequest, "invalid_request", "root_id", "root_id and reply_id come together, and are 1 or more.")
		return
	}
	who, now := c.p.Identity(), s.Clock.Now()
	var visible, moved, badRoot bool
	err := s.Store.Writer.Tx(r.Context(), func(ctx context.Context, tx *pdb.Tx) error {
		d := tx.DBTX()
		cv, found, err := conversation.Get(ctx, d, id)
		if err != nil || !found {
			return err
		}
		if _, visible, err = canSee(ctx, d, c.p, id); err != nil || !visible {
			return err
		}
		if err := readstate.Create(ctx, d, now, who, id, 0); err != nil { // a viewer with no cursor yet (the owner in a chat it was not added to)
			return err
		}
		if in.RootID != 0 {
			moved, badRoot, err = readThread(ctx, d, now, who, c.p.SessionID == 0, cv, in)
			return err
		}
		target := min(in.MainID, cv.LastMainID)
		if in.All {
			target = cv.LastMainID
			newest, err := message.NewestMessageID(ctx, d, id) // a reply is not in last_message_id
			if err != nil {
				return err
			}
			if _, err := readstate.MoveFloor(ctx, d, now, who, id, max(newest, cv.LastMessageID)); err != nil {
				return err
			}
		}
		if moved, err = readstate.Move(ctx, d, now, who, id, target); err != nil || !moved {
			return err
		}
		_, err = event.Write(ctx, d, now, event.Entry{Type: event.ReadMoved, Actor: who, Conversation: id, Audience: who, Payload: map[string]any{"main_id": target}})
		return err
	})
	switch {
	case err != nil:
		s.internalError(w, r, err)
	case !visible:
		// `convoz read` moves the cursor after every read. A triage agent has no seat, so no cursor: the move is a quiet success.
		if _, reads, err := canRead(r.Context(), s.reader(), c.p, id); err == nil && reads {
			writeJSON(w, http.StatusOK, map[string]any{})
			return
		}
		notVisible(w, c)
	case badRoot:
		writeFieldErr(w, http.StatusBadRequest, "invalid_request", "root_id", "root_id is a top-level message of this conversation.")
	default:
		if moved {
			s.Bus.Notify()
		}
		writeJSON(w, http.StatusOK, map[string]any{})
	}
}

// readThread moves the reader's position in the thread of in.RootID up to in.ReplyID, at most the thread's newest reply. A person
// who opens a thread it is not in gets a read position there (owner, msg 1855: the rail shows a thread's new replies until it is
// opened, so opening must mark it read); an agent's read moves an existing position only (DA-3).
func readThread(ctx context.Context, d pdb.DBTX, now time.Time, who int64, person bool, cv conversation.Conversation, in wire.ReadRequest) (moved, badRoot bool, err error) {
	root, ok, err := message.Get(ctx, d, in.RootID)
	if err != nil {
		return false, false, err
	}
	if !ok || root.ConversationID != cv.ID || root.ThreadRootID != 0 {
		return false, true, nil
	}
	newest, err := message.NewestReplyID(ctx, d, in.RootID)
	if err != nil {
		return false, false, err
	}
	if person {
		if err := readstate.Involve(ctx, d, now, who, cv.ID, in.RootID, 0); err != nil {
			return false, false, err
		}
	}
	moved, err = readstate.ReadThread(ctx, d, who, cv.ID, in.RootID, min(in.ReplyID, newest))
	return moved, false, err
}

// listReplies is GET /api/messages/:id/replies?after=&limit=: the thread of one root, oldest first, with the root itself. The conversation is found from the message, so a caller needs no conversation id.
func (s *Server) listReplies(w http.ResponseWriter, r *http.Request, c *call) {
	rootID, ok := pathID(w, r)
	if !ok {
		return
	}
	after, _, ok1 := intParam(w, r, "after")
	limit, _, ok2 := intParam(w, r, "limit")
	if !ok1 || !ok2 {
		return
	}
	out, refused, err := s.threadOf(r.Context(), s.reader(), c.p, rootID, after, int(limit))
	switch {
	case err != nil:
		s.internalError(w, r, err)
	case refused == http.StatusBadRequest:
		writeFieldErr(w, http.StatusBadRequest, "invalid_request", "id", "A thread hangs off a top-level message.")
	case refused != 0:
		writeErr(w, http.StatusNotFound, "not_found", "No such thread.")
	default:
		writeJSON(w, http.StatusOK, out)
	}
}

// maxThreadRoots bounds one listThreads call: a page of messages is at most this many, and no chat shows more roots than that.
const maxThreadRoots = 100

// listThreads is GET /api/conversations/:id/threads?roots=1,2,3&limit=: the threads of many roots in one read, each as listReplies
// answers it, so a chat does not ask once per thread root (issue 92). A root the caller cannot read, or that is not a thread of this
// conversation, is left out.
func (s *Server) listThreads(w http.ResponseWriter, r *http.Request, c *call) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	limit, _, ok1 := intParam(w, r, "limit")
	if !ok1 {
		return
	}
	var roots []int64
	for _, raw := range strings.Split(r.URL.Query().Get("roots"), ",") {
		n, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || n <= 0 || len(roots) == maxThreadRoots {
			writeFieldErr(w, http.StatusBadRequest, "invalid_request", "roots", "That must be 1 to "+strconv.Itoa(maxThreadRoots)+" message ids, separated by commas.")
			return
		}
		roots = append(roots, n)
	}
	ctx, d := r.Context(), s.reader()
	_, visible, err := canRead(ctx, d, c.p, id)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	if !visible {
		notVisible(w, c)
		return
	}
	out := wire.ThreadsResponse{Threads: []wire.RepliesResponse{}}
	for _, root := range roots {
		t, refused, err := s.threadOf(ctx, d, c.p, root, 0, int(limit))
		if err != nil {
			s.internalError(w, r, err)
			return
		}
		if refused == 0 && t.ConversationID == id {
			out.Threads = append(out.Threads, t)
		}
	}
	writeJSON(w, http.StatusOK, out)
}

// threadOf reads the thread of a root the way listReplies answers it. refused is 0 for a thread, 404 for no such thread (the
// message is missing or the caller may not read its conversation) and 400 for a system line, which has no thread.
func (s *Server) threadOf(ctx context.Context, d pdb.DBTX, p authz.Principal, rootID, after int64, limit int) (_ wire.RepliesResponse, refused int, err error) {
	var none wire.RepliesResponse
	root, found, err := message.Get(ctx, d, rootID)
	var floor int64
	var visible bool
	if err == nil && found {
		floor, visible, err = canRead(ctx, d, p, root.ConversationID)
	}
	if err != nil {
		return none, 0, err
	}
	if !found || !visible {
		return none, http.StatusNotFound, nil
	}
	if root.Kind == "system" {
		return none, http.StatusBadRequest, nil
	}
	if root.ThreadRootID != 0 { // a message inside a thread names its thread
		if root, found, err = message.Get(ctx, d, root.ThreadRootID); err != nil {
			return none, 0, err
		}
		if !found {
			return none, http.StatusNotFound, nil
		}
		rootID = root.ID
	}
	seq, err := event.MaxSeq(ctx, d)
	var page []message.Message
	if err == nil {
		page, err = message.Thread(ctx, d, root.ConversationID, rootID, max(floor, after), limit)
	}
	var dir directory
	if err == nil {
		dir, err = loadDirectory(ctx, d)
	}
	var asks map[int64]wire.AskView
	if err == nil {
		asks, err = askViewsOf(ctx, d, dir, append([]message.Message{root}, page...))
	}
	if err != nil {
		return none, 0, err
	}
	out := viewMessages(dir, page)
	for i, m := range page {
		if v, ok := asks[m.ID]; ok {
			out[i].AttachAsk(v)
		}
	}
	head := viewMessage(dir, root)
	if v, ok := asks[root.ID]; ok {
		head.AttachAsk(v)
	}
	if err := attachSlice(ctx, d, out); err != nil {
		return none, 0, err
	}
	if err := attachUploads(ctx, d, []*wire.Message{&head}); err != nil {
		return none, 0, err
	}
	if err := attachUnfurls(ctx, d, p, page, out); err != nil {
		return none, 0, err
	}
	rootOut := []wire.Message{head}
	if err := attachUnfurls(ctx, d, p, []message.Message{root}, rootOut); err != nil {
		return none, 0, err
	}
	head = rootOut[0]
	_, seen, err := seenIn(ctx, d, dir, root.ConversationID, rootID)
	if err != nil {
		return none, 0, err
	}
	return wire.RepliesResponse{ConversationID: root.ConversationID, Root: head, Messages: out, AsOfSeq: seq, Seen: seen}, 0, nil
}
