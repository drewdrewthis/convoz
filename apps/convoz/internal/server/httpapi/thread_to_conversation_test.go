package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/authz"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/conversation"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/message"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/dbtest"
)

const threadRoute = "/api/conversations/:id/threads/:root/conversation"

// threadRig is a conversation with an agent in it and one thread: a root and a reply.
type threadRig struct {
	*streamRig
	root, reply int64
}

func openThreadRig(t *testing.T) *threadRig {
	t.Helper()
	rig := openRig(t, "owner")
	dbtest.Exec(t, rig.s.Store,
		`INSERT INTO identities (id, kind, handle, display_name, display_skeleton, avatar_letter, avatar_palette, created_at) VALUES (900,'agent','devtool','Devtool','devtool','D',0,1)`,
		`INSERT INTO agents (identity_id, created_by_human) VALUES (900,1)`,
		`INSERT INTO participants (conversation_id, identity_id, status, joined_seq, added_by, added_at, status_at) VALUES (`+strconv.FormatInt(rig.conv, 10)+`,900,'active',0,1,1,1)`)
	tr := &threadRig{streamRig: rig}
	rig.inTx(t, func(ctx context.Context, d pdb.DBTX) error {
		post := func(client, body string, root int64) (message.Posted, error) {
			return message.Post(ctx, d, messagePorts(rig.c.p), rig.s.Clock.Now(), message.Draft{
				Conversation: rig.conv, Author: rig.c.human.ID, Device: rig.c.dev.ID, ClientID: client, Body: body, ThreadRoot: root,
			})
		}
		a, err := post("client-root1", "Which release window do we pick?", 0)
		if err != nil {
			return err
		}
		b, err := post("client-reply1", "The second one.", a.Message.ID)
		tr.root, tr.reply = a.Message.ID, b.Message.ID
		return err
	})
	return tr
}

func (r *threadRig) turn(t *testing.T, p authz.Principal, root int64) (int, map[string]any) {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/conversations/x/threads/y/conversation", nil)
	req.SetPathValue("id", strconv.FormatInt(r.conv, 10))
	req.SetPathValue("root", strconv.FormatInt(root, 10))
	rec := httptest.NewRecorder()
	r.s.threadToConversation(rec, req, &call{p: p, dev: r.c.dev, human: r.c.human})
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out
}

func (r *threadRig) count(t *testing.T) (n int) {
	t.Helper()
	r.inTx(t, func(ctx context.Context, d pdb.DBTX) error {
		list, err := conversation.ListAll(ctx, d)
		n = len(list)
		return err
	})
	return n
}

// The owner turns a thread into its own conversation: same people, titled by the root, linked back to the root message, and
// asking again gives the same conversation instead of a second one.
func TestTheOwnerTurnsAThreadIntoItsOwnConversation(t *testing.T) {
	rig := openThreadRig(t)
	before := rig.count(t)

	code, body := rig.turn(t, rig.c.p, rig.root)
	if code != http.StatusCreated {
		t.Fatalf("turn a thread into a conversation: %d %v", code, body)
	}
	cv, _ := body["conversation"].(map[string]any)
	id, _ := cv["id"].(float64)
	if int64(id) == rig.conv || id == 0 {
		t.Fatalf("the answer is not a new conversation: %v", cv)
	}
	if cv["title"] != "Which release window do we pick?" {
		t.Errorf("title = %v, want the root text", cv["title"])
	}
	origin, _ := cv["origin"].(map[string]any)
	if origin["conversation_id"] != float64(rig.conv) || origin["message_id"] != float64(rig.root) {
		t.Errorf("origin = %v, want conversation %d message %d", origin, rig.conv, rig.root)
	}
	parts, _ := cv["participants"].([]any)
	if len(parts) != 2 {
		t.Errorf("participants = %d, want the owner and the agent of the thread's conversation", len(parts))
	}

	var shown int64
	rig.inTx(t, func(ctx context.Context, d pdb.DBTX) error {
		v, found, err := rig.s.visibleDetail(ctx, d, rig.c.p, int64(id))
		if v.Origin != nil {
			shown = v.Origin.MessageID
		}
		if !found {
			t.Error("the new conversation is not visible to the owner")
		}
		return err
	})
	if shown != rig.root {
		t.Errorf("the detail of the new conversation shows origin message %d, want %d", shown, rig.root)
	}

	if code, again := rig.turn(t, rig.c.p, rig.root); code != http.StatusOK || again["conversation"].(map[string]any)["id"] != cv["id"] {
		t.Errorf("a second turn: %d %v, want 200 and the same conversation", code, again)
	}
	if got := rig.count(t); got != before+1 {
		t.Errorf("conversations = %d, want %d: one new one", got, before+1)
	}
}

// Only the owner can turn a thread into a conversation: the route asks for the owner, and the handler refuses anyone else too.
func TestOnlyTheOwnerTurnsAThreadIntoAConversation(t *testing.T) {
	rig := openThreadRig(t)
	before := rig.count(t)

	found := false
	for _, rt := range Routes {
		if rt.Method == "POST" && rt.Pattern == threadRoute {
			found = true
			if rt.Auth != authz.Owner || rt.Lease {
				t.Errorf("route auth = %v lease = %v, want owner and no lease", rt.Auth, rt.Lease)
			}
			if err := rt.Auth.Check(authz.Principal{Authenticated: true, HumanID: 7, Role: "member"}); err != authz.ErrForbidden {
				t.Errorf("a member meets the route: %v", err)
			}
		}
	}
	if !found {
		t.Fatalf("no route %s", threadRoute)
	}
	member := authz.Principal{Authenticated: true, HumanID: 7, Role: "member"}
	agent := authz.Principal{SessionID: 1, IdentityID: 900}
	for name, p := range map[string]authz.Principal{"member": member, "agent": agent} {
		if code, _ := rig.turn(t, p, rig.root); code != http.StatusForbidden {
			t.Errorf("%s: %d, want 403", name, code)
		}
	}
	if got := rig.count(t); got != before {
		t.Errorf("a refused turn made a conversation: %d, want %d", got, before)
	}
}

// Only a thread root can start a conversation: a reply and a message that is not there are refused.
func TestOnlyAThreadRootTurnsIntoAConversation(t *testing.T) {
	rig := openThreadRig(t)
	if code, _ := rig.turn(t, rig.c.p, rig.reply); code != http.StatusBadRequest {
		t.Errorf("a reply: %d, want 400", code)
	}
	if code, _ := rig.turn(t, rig.c.p, 999999); code != http.StatusNotFound {
		t.Errorf("a missing message: %d, want 404", code)
	}
}
