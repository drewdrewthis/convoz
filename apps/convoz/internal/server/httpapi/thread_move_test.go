package httpapi

import (
	"context"
	"net/http"
	"testing"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/authz"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/conversation"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/message"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// agentReplies is the agent 900 answering in the thread of the root.
func (r *threadRig) agentReplies(t *testing.T, body string) (id int64) {
	t.Helper()
	r.inTx(t, func(ctx context.Context, d pdb.DBTX) error {
		p, err := message.Post(ctx, d, messagePorts(r.c.p), r.s.Clock.Now(), message.Draft{
			Conversation: r.conv, Author: 900, ClientID: "client-agent1", Body: body, ThreadRoot: r.root,
		})
		id = p.Message.ID
		return err
	})
	return id
}

// A thread that becomes a conversation takes its replies along: ids, authors and order kept, top level in the new conversation, none
// left under the root, the counters of both conversations right, search finding them in the new one, and the owner's unread count
// being what it was in the thread.
func TestTurningAThreadIntoAConversationMovesItsReplies(t *testing.T) {
	rig := openThreadRig(t)
	second := rig.agentReplies(t, "Not alone, it needs the API.")

	code, body := rig.turn(t, rig.c.p, rig.root)
	if code != http.StatusCreated {
		t.Fatalf("turn: %d %v", code, body)
	}
	cv := body["conversation"].(map[string]any)
	made := int64(cv["id"].(float64))
	if cv["unread"] != float64(1) {
		t.Errorf("unread = %v, want 1: the owner had read its own reply, not the agent's", cv["unread"])
	}

	rig.inTx(t, func(ctx context.Context, d pdb.DBTX) error {
		list, err := message.Newest(ctx, d, made, 0, 50)
		if err != nil {
			return err
		}
		if len(list) != 2 || list[0].ID != rig.reply || list[1].ID != second {
			t.Fatalf("new conversation holds %+v, want replies %d then %d", list, rig.reply, second)
		}
		if list[0].AuthorID != rig.c.human.ID || list[1].AuthorID != 900 || list[0].ThreadRootID != 0 || list[1].ThreadRootID != 0 {
			t.Errorf("authors or roots changed: %+v", list)
		}
		return nil
	})
	rig.inTx(t, func(ctx context.Context, d pdb.DBTX) error {
		oldList, err := message.Newest(ctx, d, rig.conv, 0, 50)
		if err != nil {
			return err
		}
		if len(oldList) != 1 || oldList[0].ID != rig.root || oldList[0].ReplyCount != 0 {
			t.Errorf("old conversation = %+v, want only the root with no replies", oldList)
		}
		newer, _, _ := conversation.Get(ctx, d, made)
		older, _, _ := conversation.Get(ctx, d, rig.conv)
		if newer.MessageCount != 2 || newer.LastMessageID != second || newer.LastMainID != second {
			t.Errorf("new counters = %+v", newer)
		}
		if older.MessageCount != 1 || older.LastMessageID != rig.root {
			t.Errorf("old counters = %+v", older)
		}
		var inNew int
		err = d.QueryRowContext(ctx, `SELECT count(*) FROM search_entries WHERE conversation_id = ?1 AND message_id IN (?2, ?3)`, made, rig.reply, second).Scan(&inNew)
		if inNew != 2 {
			t.Errorf("search entries in the new conversation = %d, want 2", inNew)
		}
		return err
	})

	if code, again := rig.turn(t, rig.c.p, rig.root); code != http.StatusOK || again["conversation"].(map[string]any)["id"] != cv["id"] {
		t.Errorf("second turn: %d, want 200 and the same conversation", code)
	}
	rig.inTx(t, func(ctx context.Context, d pdb.DBTX) error {
		list, err := message.Newest(ctx, d, made, 0, 50)
		if len(list) != 2 {
			t.Errorf("second turn changed the new conversation: %d messages", len(list))
		}
		return err
	})
}

// A refused turn moves nothing.
func TestARefusedTurnLeavesTheRepliesWhereTheyAre(t *testing.T) {
	rig := openThreadRig(t)
	rig.turn(t, authz.Principal{Authenticated: true, HumanID: 7, Role: "member"}, rig.root)
	rig.inTx(t, func(ctx context.Context, d pdb.DBTX) error {
		m, _, err := message.Get(ctx, d, rig.reply)
		if m.ThreadRootID != rig.root || m.ConversationID != rig.conv {
			t.Errorf("reply moved by a refused turn: %+v", m)
		}
		return err
	})
}
