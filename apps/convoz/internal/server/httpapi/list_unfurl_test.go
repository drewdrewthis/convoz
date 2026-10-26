package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/authz"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/dbtest"
)

// list reads GET /api/conversations/:id/messages as c.
func (r *streamRig) list(t *testing.T, c *call) []map[string]any {
	t.Helper()
	id := strconv.FormatInt(r.conv, 10)
	req := httptest.NewRequest(http.MethodGet, "/api/conversations/"+id+"/messages", nil)
	req.SetPathValue("id", id)
	rec := httptest.NewRecorder()
	r.s.listMessages(rec, req, c)
	if rec.Code != http.StatusOK {
		t.Fatalf("list: %d %s", rec.Code, rec.Body.String())
	}
	var out struct {
		Messages []map[string]any `json:"messages"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	return out.Messages
}

// The page carries each link message's card, so the web draws it without one request per message (issue 92). A card the worker has
// not finished is still sent, as pending; a message without a link has none; an agent never gets one (invariant 24).
func TestListMessagesCarriesTheCardOfEachLinkMessage(t *testing.T) {
	rig := openRig(t, "owner")
	dbtest.Exec(t, rig.s.Store,
		`INSERT INTO identities (id, kind, handle, display_name, display_skeleton, avatar_letter, avatar_palette, created_at) VALUES (901,'agent','docs','Docs','docs','D',0,1)`,
		`INSERT INTO agents (identity_id, created_by_human) VALUES (901,1)`)
	for i, body := range []string{"see https://example.com/a", "and https://example.com/b", "no link here", "@docs look at https://example.com/a"} {
		if code, out := rig.postAs(t, rig.c, `{"client_id":"unfurl-post-`+strconv.Itoa(i)+`","body":`+strconv.Quote(body)+`}`); code != http.StatusCreated {
			t.Fatalf("post %d: %d %v", i, code, out)
		}
	}
	rig.inTx(t, func(ctx context.Context, d pdb.DBTX) error {
		_, err := d.ExecContext(ctx, `UPDATE unfurls SET status='ok', title='Example A', kind='generic', site='example.com' WHERE url='https://example.com/a'`)
		return err
	})

	byBody := map[string]map[string]any{}
	for _, m := range rig.list(t, rig.c) {
		byBody[m["body"].(string)] = m
	}
	if card, _ := byBody["see https://example.com/a"]["unfurl"].(map[string]any); card["status"] != "ok" || card["title"] != "Example A" {
		t.Errorf("settled card: %v, want ok / Example A", card)
	}
	if card, _ := byBody["and https://example.com/b"]["unfurl"].(map[string]any); card["status"] != "pending" {
		t.Errorf("unsettled card: %v, want pending", card)
	}
	if card, has := byBody["no link here"]["unfurl"]; has {
		t.Errorf("a message without a link has card %v", card)
	}

	agent := &call{p: authz.Principal{Authenticated: true, SessionID: 1, IdentityID: 901}}
	for _, m := range rig.list(t, agent) {
		if card, has := m["unfurl"]; has {
			t.Errorf("an agent got card %v on %q", card, m["body"])
		}
	}
}
