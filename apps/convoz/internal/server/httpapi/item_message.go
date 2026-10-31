package httpapi

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/appkit"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/item"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/message"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// itemBudget keeps a new item inside the agent's post budgets, as its message counts like any post. An item that exists is an edit: no message.
func (s *Server) itemBudget(w http.ResponseWriter, r *http.Request, c *call, conv int64, key, event string) bool {
	if event == "answer" {
		return s.withinBudgets(w, c, s.Clock.Now()) // the answer is a message
	}
	if event != "start" && event != "block" {
		return true
	}
	if _, err := item.ByKey(r.Context(), s.reader(), c.p.Identity(), conv, key); !errors.Is(err, item.ErrNotFound) {
		return true
	}
	return s.withinBudgets(w, c, s.Clock.Now())
}

// itemBody is what the item's message says: the title, the context and the recommendation, plain text.
func itemBody(f item.Fields) string {
	body := f.Title + "\n\n" + f.Context
	if f.Recommend != "" {
		body += "\n\nRecommended: " + f.Recommend
	}
	return body
}

// itemWithMessage is a start or a block (owner, conv 179 msg 12363, 12444: an item is a message with state). A new item posts the
// agent's own message and is rooted on it, in the caller's transaction; an item that exists is edited and posts nothing. The context
// is never empty (msg 12448). It returns the agents to wake after the commit.
func (s *Server) itemWithMessage(ctx context.Context, d pdb.DBTX, c *call, now time.Time, conv int64, key, event string, f item.Fields, app []byte) (item.Item, []int64, error) {
	agent := c.p.Identity()
	if event == "block" {
		if err := item.CheckBlockTitle(f.Title); err != nil {
			return item.Item{}, nil, err
		}
	}
	f, err := item.NeedContext(f)
	if err != nil {
		return item.Item{}, nil, err
	}
	move := item.Start
	if event == "block" {
		move = item.Block
	}
	if _, err := item.ByKey(ctx, d, agent, conv, key); !errors.Is(err, item.ErrNotFound) {
		it, err := move(ctx, d, now, agent, conv, key, f)
		return it, nil, err
	}
	sum := sha256.Sum256([]byte(fmt.Sprintf("item\x00%d\x00%d\x00%s", agent, conv, key)))
	draft := message.Draft{Conversation: conv, Author: agent, Session: c.p.SessionID, Device: c.dev.ID, ClientID: "item-" + hex.EncodeToString(sum[:16]), Body: itemBody(f)}
	draft.Origin = message.Origin{Label: c.lease.Label, Machine: c.lease.Machine}
	if len(app) > 0 {
		checked, err := appkit.Check(ctx, d, uploadFiles{}, agent, app)
		if err != nil {
			return item.Item{}, nil, err
		}
		draft.App, draft.UploadIDs = checked.Canonical(), appkit.UploadIDs(checked)
	}
	posted, err := message.Post(ctx, d, triagePorts(c.p), now, draft)
	if err != nil {
		return item.Item{}, nil, err
	}
	f.Root = posted.Message.ID
	it, err := move(ctx, d, now, agent, conv, key, f)
	return it, posted.Wake, err
}
