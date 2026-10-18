package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/conversation"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/inbox"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/message"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

// typingFor is how long a "typing" call shows the agent as replying. An agent that keeps working calls again.
const typingFor = 30 * time.Second

// rootOf is the thread a message belongs to: its own root, or 0 for a message of the main list (or one that is gone).
func (s *Server) rootOf(ctx context.Context, messageID int64) int64 {
	if messageID == 0 {
		return 0
	}
	m, found, err := message.Get(ctx, s.reader(), messageID)
	if err != nil || !found {
		return 0
	}
	return m.ThreadRootID
}

// publishHold sends the working frame of a claim, in the place of the claimed item's newest message: its thread, else the main list.
func (s *Server) publishHold(ctx context.Context, agentID int64, h inbox.Hold) {
	s.publishWorkingAt(ctx, agentID, h.Conversation, s.rootOf(ctx, h.Message), true, h.Until)
}

// humansOf lists the people of a conversation: the authors whose messages an agent "sees".
func humansOf(ctx context.Context, d pdb.DBTX, dir directory, conv int64) ([]int64, error) {
	parts, err := conversation.Participants(ctx, d, conv)
	if err != nil {
		return nil, err
	}
	var out []int64
	for _, pt := range parts {
		if e, ok := dir[pt.IdentityID]; ok && e.Kind == "human" {
			out = append(out, pt.IdentityID)
		}
	}
	return out, nil
}

// seenIn lists the agents that have seen the newest message a person wrote in one place of a conversation (the main list for
// root 0). It also returns that message's id, 0 when nobody wrote one. The agents come first seen first.
func seenIn(ctx context.Context, d pdb.DBTX, dir directory, conv, root int64) (int64, []wire.Seen, error) {
	humans, err := humansOf(ctx, d, dir, conv)
	if err != nil {
		return 0, nil, err
	}
	msg, err := message.NewestOfAuthors(ctx, d, conv, root, humans)
	if err != nil || msg == 0 {
		return 0, nil, err
	}
	rows, err := inbox.SeenSince(ctx, d, conv, msg)
	if err != nil {
		return 0, nil, err
	}
	var out []wire.Seen
	for _, r := range rows {
		if e, ok := dir[r.Identity]; ok {
			out = append(out, wire.Seen{Handle: e.Handle, MessageID: msg, At: r.At})
		}
	}
	return msg, out, nil
}

// publishSeen sends the live-only "message.seen" frame for each place the claim covers: the newest message a person wrote in
// the main list, and in the thread of the item's newest message. The frame carries that message, so the page puts the line under it.
// It is a hint (the page reads the stored rows on load), so a failure to build it is dropped.
func (s *Server) publishSeen(ctx context.Context, agentID int64, h inbox.Hold) {
	if h.Message == 0 {
		return
	}
	d := s.reader()
	dir, err := loadDirectory(ctx, d)
	agent, ok := dir[agentID]
	if err != nil || !ok {
		return
	}
	places := []int64{0}
	if root := s.rootOf(ctx, h.Message); root != 0 {
		places = append(places, root)
	}
	for _, root := range places {
		humans, err := humansOf(ctx, d, dir, h.Conversation)
		if err != nil {
			return
		}
		msg, err := message.NewestOfAuthors(ctx, d, h.Conversation, root, humans)
		if err != nil || msg == 0 || h.Message < msg {
			continue
		}
		frame := map[string]any{"identity_id": agentID, "handle": agent.Handle, "conversation_id": h.Conversation, "message_id": msg, "at": s.Clock.Now().UnixMilli()}
		if root != 0 {
			frame["thread_root_id"] = root
		}
		data, _ := json.Marshal(frame)
		s.Bus.Publish(platform.Frame{Event: "message.seen", Data: data, Conversation: h.Conversation})
	}
}

// typing is POST /api/conversations/:id/typing {thread_root_id?}: an agent without a claim says it is working on a reply, for
// typingFor. A message inside a thread names that thread. Nothing is stored.
func (s *Server) typing(w http.ResponseWriter, r *http.Request, c *call) {
	conv, ok := pathID(w, r)
	if !ok {
		return
	}
	var in wire.TypingRequest
	if !decode(w, r, &in) {
		return
	}
	if c.p.SessionID == 0 {
		writeErr(w, http.StatusForbidden, "forbidden", "Only an agent says it is replying.")
		return
	}
	ctx, d := r.Context(), s.reader()
	_, visible, err := canSee(ctx, d, c.p, conv)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	if !visible {
		notVisible(w, c)
		return
	}
	root := int64(0)
	if in.ThreadRoot != 0 {
		m, found, err := message.Get(ctx, d, in.ThreadRoot)
		if err != nil {
			s.internalError(w, r, err)
			return
		}
		if !found || m.ConversationID != conv || m.Kind == "system" {
			writeFieldErr(w, http.StatusBadRequest, "invalid_request", "thread_root_id", "A thread is named by a message of this conversation.")
			return
		}
		if root = m.ThreadRootID; root == 0 {
			root = m.ID
		}
	}
	s.publishWorkingAt(ctx, c.p.Identity(), conv, root, true, s.Clock.Now().Add(typingFor).UnixMilli())
	w.WriteHeader(http.StatusNoContent)
}
