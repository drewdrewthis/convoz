package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/authz"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/identity"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// postAs calls POST /api/conversations/:id/messages as c with the given body.
func (r *streamRig) postAs(t *testing.T, c *call, body string) (int, map[string]any) {
	t.Helper()
	id := strconv.FormatInt(r.conv, 10)
	req := httptest.NewRequest(http.MethodPost, "/api/conversations/"+id+"/messages", strings.NewReader(body))
	req.SetPathValue("id", id)
	rec := httptest.NewRecorder()
	r.s.postMessage(rec, req, c)
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out
}

// authorOf reads who wrote the posted message, and whether it carries the "via voice call" mark.
func (r *streamRig) authorOf(t *testing.T, posted map[string]any) (author int64, handle, kind string, viaVoice bool) {
	t.Helper()
	id, _ := posted["id"].(float64)
	r.inTx(t, func(ctx context.Context, d pdb.DBTX) error {
		return d.QueryRowContext(ctx, `SELECT m.author_id, i.handle, i.kind, m.via_voice FROM messages m JOIN identities i ON i.id = m.author_id WHERE m.id = ?`, int64(id)).
			Scan(&author, &handle, &kind, &viaVoice)
	})
	return
}

// The owner's voice call writes as @voice, not as the owner "via voice" (owner, 2026-10-22). @voice is made once and reused, and
// nobody else writes as it: not a member, not an agent's lease. Turned off, it writes nothing.
func TestTheVoiceCallWritesAsVoiceAndNobodyElseDoes(t *testing.T) {
	rig := openRig(t, "owner")

	code, first := rig.postAs(t, rig.c, `{"client_id":"voice-post-1","body":"Ship it","as_voice":true}`)
	if code != http.StatusCreated {
		t.Fatalf("the owner's call posts as @voice: %d %v", code, first)
	}
	voice, handle, kind, via := rig.authorOf(t, first)
	if handle != identity.VoiceHandle || kind != "agent" || voice == rig.c.human.ID || via {
		t.Errorf("author %d @%s (%s), via_voice %v: want the agent @voice and no mark", voice, handle, kind, via)
	}
	_, second := rig.postAs(t, rig.c, `{"client_id":"voice-post-2","body":"And merge it","as_voice":true}`)
	if again, _, _, _ := rig.authorOf(t, second); again != voice {
		t.Errorf("a second post made another @voice: %d, want %d", again, voice)
	}

	// @voice speaks for the owner: the conversation still waits on the agents, so it cannot go stale (#42).
	cv := rig.conversationNow(t)
	rig.inTx(t, func(ctx context.Context, d pdb.DBTX) error {
		dir, err := loadDirectory(ctx, d)
		if err != nil {
			return err
		}
		if last, err := ownerWroteLast(ctx, d, dir, cv); err != nil || !last {
			t.Errorf("after a post as @voice the owner wrote last: %v %v, want true", last, err)
		}
		return nil
	})

	member := *rig.c
	member.p.Role = "member"
	lease := &call{p: authz.Principal{Authenticated: true, SessionID: 1, IdentityID: voice}}
	for name, c := range map[string]*call{"a member": &member, "an agent's lease": lease} {
		if code, body := rig.postAs(t, c, `{"client_id":"voice-post-3","body":"hi","as_voice":true}`); code != http.StatusForbidden || errField(body) != "as_voice" {
			t.Errorf("%s posts as @voice: %d %v, want 403 naming as_voice", name, code, body)
		}
	}

	rig.inTx(t, func(ctx context.Context, d pdb.DBTX) error {
		_, err := identity.DisableAgent(ctx, d, voice, platform.SystemClock{}.Now())
		return err
	})
	if code, body := rig.postAs(t, rig.c, `{"client_id":"voice-post-4","body":"hi","as_voice":true}`); code != http.StatusConflict {
		t.Errorf("a post as @voice turned off: %d %v, want 409", code, body)
	}
}

// errField is the field an error answer names.
func errField(body map[string]any) any {
	e, _ := body["error"].(map[string]any)
	return e["field"]
}
