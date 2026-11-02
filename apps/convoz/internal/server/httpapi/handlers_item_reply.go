package httpapi

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/item"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/message"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

// errRootRaced: another writer made the item's root between our check and our write. The transaction rolls back and the caller reads again.
var errRootRaced = errors.New("item: the thread root changed under the write")

// replyOnItem writes the owner's text in the thread of an item. An item with no root gets one: the text becomes a new message with the item
// title quoted above it, and that message's id is kept as the root (only if still NULL). Otherwise the text is a reply in the root's thread.
// Everything is one write transaction, so two writers meet one after the other: the second reads the first's root and replies in it. The
// only-if-NULL update and the re-read are the guard behind that: if the root is not ours after the update, the transaction rolls back.
func (s *Server) replyOnItem(ctx context.Context, d pdb.DBTX, c *call, now time.Time, id int64, text string) (item.Item, []int64, error) {
	it, err := item.ByID(ctx, d, id)
	if err != nil {
		return it, nil, err
	}
	draft := message.Draft{Conversation: it.Conversation, Author: c.p.HumanID, Device: c.dev.ID, ClientID: fmt.Sprintf("item-%d-reply-%d", id, now.UnixNano())}
	draft.Body, draft.ThreadRoot = text, it.ThreadRoot
	if it.ThreadRoot == 0 {
		draft.Body = "> " + it.Title + "\n\n" + text
	}
	posted, err := message.Post(ctx, d, messagePorts(c.p), now, draft)
	if err != nil {
		return it, nil, err
	}
	if it.ThreadRoot == 0 {
		if err := item.SetThreadRoot(ctx, d, id, posted.Message.ID); err != nil {
			return it, nil, err
		}
		if it, err = item.ByID(ctx, d, id); err != nil {
			return it, nil, err
		}
		if it.ThreadRoot != posted.Message.ID {
			return it, nil, errRootRaced
		}
	}
	it, err = item.OwnerReplied(ctx, d, now, c.p.HumanID, id)
	return it, posted.Wake, err
}

// feedReply is POST /api/feed/:id/reply: the owner writes in the item's thread. Owner only; a lease is refused.
func (s *Server) feedReply(w http.ResponseWriter, r *http.Request, c *call) {
	id, ok := pathID(w, r)
	var in wire.FeedReplyRequest
	if !ok || !decode(w, r, &in) {
		return
	}
	text := strings.TrimSpace(in.Text)
	if text == "" || len(text) > 4000 {
		writeFieldErr(w, http.StatusBadRequest, "invalid_request", "text", "text is 1 to 4000 characters")
		return
	}
	var it item.Item
	var wake []int64
	now := s.Clock.Now()
	err := s.Store.Writer.Tx(r.Context(), func(ctx context.Context, tx *pdb.Tx) (err error) {
		it, wake, err = s.replyOnItem(ctx, tx.DBTX(), c, now, id, text)
		return err
	})
	if errors.Is(err, errRootRaced) {
		writeErr(w, http.StatusConflict, "conflict", "The thread was started by someone else a moment ago. Send it again.")
		return
	}
	if s.itemRefused(w, r, c, err) || s.messageRefused(w, err) {
		return
	}
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	s.Bus.Notify(wake...)
	dir, err := loadDirectory(r.Context(), s.reader())
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, feedItemView(dir, it))
}
