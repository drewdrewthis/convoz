package httpapi

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/item"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/message"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

// errTakeTarget: only a person's message in the main chat can be taken (an agent's message or a reply in a thread cannot).
var errTakeTarget = errors.New("item: only a person's main-chat message can be taken")

// takeMessage makes the items of a question on the owner's message. Without a question the item is titled with the message itself, and a
// message that has an item already is a conflict. No message is posted: a quick answer stays a plain reply (msg 12557).
func (s *Server) takeMessage(ctx context.Context, d pdb.DBTX, c *call, now time.Time, msg int64, in wire.TakeRequest) ([]item.Item, error) {
	m, found, err := message.Get(ctx, d, msg)
	if err != nil {
		return nil, err
	}
	if !found || m.Deleted {
		return nil, item.ErrNotFound
	}
	dir, err := loadDirectory(ctx, d)
	if err != nil {
		return nil, err
	}
	if m.ThreadRootID != 0 || m.Kind != "text" || dir[m.AuthorID].Kind != "human" {
		return nil, errTakeTarget
	}
	title := strings.TrimSpace(in.Question)
	if title == "" {
		title = strings.Join(strings.Fields(m.Body), " ")
		if utf8.RuneCountInString(title) > item.MaxTitle {
			return nil, item.ErrText // too long to be a title: the agent names the question
		}
	}
	return item.Take(ctx, d, now, c.p.Identity(), m.ConversationID, m.ID, item.Fields{Title: title, Context: in.Context, Plan: in.Plan}, in.Steps, in.Question != "")
}

// answerItem is the answer to a taken question: the agent's reply in the message's thread, quoting the question, and done, in one
// transaction. Only the item's own thread entry is touched: the post does not reopen the other items of the message.
func (s *Server) answerItem(ctx context.Context, d pdb.DBTX, c *call, now time.Time, conv int64, key, text string) (item.Item, []int64, error) {
	text = strings.TrimSpace(text)
	if text == "" || utf8.RuneCountInString(text) > 4000 {
		return item.Item{}, nil, item.ErrText
	}
	agent := c.p.Identity()
	it, err := item.ByKey(ctx, d, agent, conv, key)
	if err != nil {
		return item.Item{}, nil, err
	}
	if it.State != item.Started || it.ThreadRoot == 0 {
		return item.Item{}, nil, item.ErrConflict
	}
	ports := triagePorts(c.p)
	ports.Items = nil
	draft := message.Draft{Conversation: conv, Author: agent, Session: c.p.SessionID, Device: c.dev.ID, ThreadRoot: it.ThreadRoot,
		ClientID: fmt.Sprintf("item-answer-%d-%d", it.ID, it.Version), Body: "> " + it.Title + "\n\n" + text, Origin: message.Origin{Label: c.lease.Label, Machine: c.lease.Machine}}
	posted, err := message.Post(ctx, d, ports, now, draft)
	if err != nil {
		return item.Item{}, nil, err
	}
	it, err = item.MarkDone(ctx, d, now, agent, conv, key, "answered")
	return it, posted.Wake, err
}

// postTake is POST /api/messages/:id/take. The agent comes from the lease and must see the conversation of the message.
func (s *Server) postTake(w http.ResponseWriter, r *http.Request, c *call) {
	msg, ok := pathID(w, r)
	var in wire.TakeRequest
	if !ok || !decode(w, r, &in) {
		return
	}
	m, found, err := message.Get(r.Context(), s.reader(), msg)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	if visible := found; found {
		_, visible, err = canSee(r.Context(), s.reader(), c.p, m.ConversationID)
		if err != nil {
			s.internalError(w, r, err)
			return
		}
		found = visible
	}
	if !found {
		notVisible(w, c)
		return
	}
	var items []item.Item
	err = s.Store.Writer.Tx(r.Context(), func(ctx context.Context, tx *pdb.Tx) (e error) {
		items, e = s.takeMessage(ctx, tx.DBTX(), c, s.Clock.Now(), msg, in)
		return e
	})
	if errors.Is(err, errTakeTarget) {
		writeFieldErr(w, http.StatusBadRequest, "invalid_request", "message", "Only a person's message in the main chat can be taken, not an agent's message or a reply in a thread.")
		return
	}
	if s.itemRefused(w, r, err) {
		return
	}
	s.Bus.Notify()
	dir, err := loadDirectory(r.Context(), s.reader())
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	out := wire.TakeResponse{Items: make([]wire.FeedItem, 0, len(items))}
	for _, it := range items {
		out.Items = append(out.Items, feedItemView(dir, it))
	}
	writeJSON(w, http.StatusOK, out)
}
