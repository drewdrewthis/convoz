package httpapi

import (
	"context"
	"encoding/hex"
	"errors"
	"strconv"
	"sync"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/authz"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/conversation"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/inbox"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/item"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

// itemStaleAfter is how long a started feed item may sit untouched before its agent is reminded (owner, conv 179 msg 12993: "why
// wouldn't we just ping the agent via the inbox?").
const itemStaleAfter = 15 * time.Minute

// staleMemo remembers, per feed item, the updated_at its agent was last reminded for: one reminder per quiet spell, because a
// say or any other move changes updated_at. It lives in memory: after a restart an item that is still quiet is reminded once more.
// The zero value is ready.
type staleMemo struct {
	mu   sync.Mutex
	seen map[int64]int64
}

func (m *staleMemo) reminded(id, updatedAt int64) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	at, ok := m.seen[id]
	return ok && at == updatedAt
}

func (m *staleMemo) remember(id, updatedAt int64) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.seen == nil {
		m.seen = map[int64]int64{}
	}
	m.seen[id] = updatedAt
}

// remindStale makes one item_stale inbox item for each started feed item quiet for itemStaleAfter that was not reminded in this
// quiet spell. The check runs again inside the one writer, so two sweeps never remind twice.
func (s *Server) remindStale(ctx context.Context) error {
	now := s.Clock.Now()
	quiet, err := item.StartedQuietSince(ctx, s.reader(), now.Add(-itemStaleAfter).UnixMilli())
	if err != nil {
		return err
	}
	for _, q := range quiet {
		if s.stale.reminded(q.ID, q.UpdatedAt) {
			continue
		}
		made := false
		err := s.Store.Writer.Tx(ctx, func(ctx context.Context, tx *pdb.Tx) error {
			d := tx.DBTX()
			it, err := item.ByID(ctx, d, q.ID)
			if err != nil || it.State != item.Started || it.UpdatedAt != q.UpdatedAt || s.stale.reminded(it.ID, it.UpdatedAt) {
				return ignoreItemGone(err)
			}
			if member, err := isMember(ctx, d, it.Conversation, it.Agent); err != nil || !member {
				return err
			}
			made = true
			return inbox.ItemStale(ctx, d, now, it.Agent, it.Conversation, it.ID)
		})
		if err != nil {
			return err
		}
		if made {
			s.stale.remember(q.ID, q.UpdatedAt)
			s.Bus.Notify(q.Agent)
		}
	}
	return nil
}

func ignoreItemGone(err error) error {
	if errors.Is(err, item.ErrNotFound) {
		return nil
	}
	return err
}

// itemStaleBody is the text of the reminder.
func itemStaleBody(it item.Item) string {
	c := strconv.FormatInt(it.Conversation, 10)
	return "Your item \"" + it.Title + "\" (" + c + " " + it.Key + ") has had no update since " + time.UnixMilli(it.UpdatedAt).UTC().Format("15:04Z") +
		": say, done, block or drop it. convoz item say " + c + " " + it.Key + " \"...\""
}

// itemStaleItem builds the wire item of a reminder, from the feed item as it is when the agent reads. ok is false when the item is
// no longer started or the agent can no longer see the conversation (with expire set the reminder then leaves the queue).
func (s *Server) itemStaleItem(ctx context.Context, d pdb.DBTX, now time.Time, p authz.Principal, in inbox.Item, expire bool) (wire.InboxItem, bool, error) {
	id, err := inbox.ItemStaleOf(ctx, d, p.Identity(), in.ID)
	if err != nil {
		return wire.InboxItem{}, false, err
	}
	it, err := item.ByID(ctx, d, id)
	if err != nil && !errors.Is(err, item.ErrNotFound) {
		return wire.InboxItem{}, false, err
	}
	cv, found, err := conversation.Get(ctx, d, in.ConversationID)
	if err != nil {
		return wire.InboxItem{}, false, err
	}
	_, visible, err := canSee(ctx, d, p, in.ConversationID)
	if err != nil {
		return wire.InboxItem{}, false, err
	}
	if it.State != item.Started || !found || !visible {
		if expire {
			err = inbox.ExpireNotVisible(ctx, d, now, in.ID)
		}
		return wire.InboxItem{}, false, err
	}
	wi := wire.InboxItem{ID: in.ID, State: in.State, Reason: in.Reason, Count: in.Count, Deliveries: in.Deliveries, Conversation: wire.InboxConversation{ID: in.ConversationID},
		Message: wire.Message{Author: systemAuthor, Body: itemStaleBody(it), Format: "plain", Kind: "system", CreatedAt: now.UnixMilli()}}
	if cv.Title != "" {
		title := cv.Title
		wi.Conversation.Title = &title
	}
	if in.ClaimToken != nil {
		wi.ClaimToken = hex.EncodeToString(in.ClaimToken)
	}
	return wi, true, nil
}
