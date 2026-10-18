package httpapi

import (
	"context"
	"net/http"
	"time"

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
			moved, badRoot, err = readThread(ctx, d, now, who, cv, in)
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

// readThread moves the reader's position in the thread of in.RootID up to in.ReplyID, at most the thread's newest reply.
func readThread(ctx context.Context, d pdb.DBTX, now time.Time, who int64, cv conversation.Conversation, in wire.ReadRequest) (moved, badRoot bool, err error) {
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
	moved, err = readstate.ReadThread(ctx, d, who, cv.ID, in.RootID, min(in.ReplyID, newest))
	return moved, false, err
}

// listReplies is GET /api/messages/:id/replies?after=&limit=: the thread of one root, oldest first, with the root itself (a stub
// when the caller joined after it). The conversation is found from the message, so a caller needs no conversation id.
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
	ctx, d := r.Context(), s.reader()
	root, found, err := message.Get(ctx, d, rootID)
	var floor int64
	var visible bool
	if err == nil && found {
		floor, visible, err = canSee(ctx, d, c.p, root.ConversationID)
	}
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	if !found || !visible {
		writeErr(w, http.StatusNotFound, "not_found", "No such thread.")
		return
	}
	if root.Kind == "system" {
		writeFieldErr(w, http.StatusBadRequest, "invalid_request", "id", "A thread hangs off a top-level message.")
		return
	}
	if root.ThreadRootID != 0 { // a message inside a thread names its thread
		if root, found, err = message.Get(ctx, d, root.ThreadRootID); err != nil {
			s.internalError(w, r, err)
			return
		}
		if !found {
			writeErr(w, http.StatusNotFound, "not_found", "No such thread.")
			return
		}
		rootID = root.ID
	}
	seq, err := event.MaxSeq(ctx, d)
	var page []message.Message
	if err == nil {
		page, err = message.Thread(ctx, d, root.ConversationID, rootID, max(floor, after), int(limit))
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
		s.internalError(w, r, err)
		return
	}
	out := viewMessages(dir, page)
	for i, m := range page {
		if v, ok := asks[m.ID]; ok {
			out[i].Ask = &v
		}
	}
	head := viewMessage(dir, root)
	if v, ok := asks[root.ID]; ok {
		head.Ask = &v
	}
	if err := attachSlice(ctx, d, out); err != nil {
		s.internalError(w, r, err)
		return
	}
	if err := attachUploads(ctx, d, []*wire.Message{&head}); err != nil {
		s.internalError(w, r, err)
		return
	}
	if root.ID <= floor {
		head = wire.Message{ID: root.ID, Author: systemAuthor, Body: threadStubWords, Format: "plain"}
	}
	_, seen, err := seenIn(ctx, d, dir, root.ConversationID, rootID)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, wire.RepliesResponse{ConversationID: root.ConversationID, Root: head, Messages: out, AsOfSeq: seq, Seen: seen})
}
