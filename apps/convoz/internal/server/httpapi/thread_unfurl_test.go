package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"

	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// replies reads GET /api/messages/:id/replies as the rig's owner and decodes the thread as a map.
func (r *streamRig) replies(t *testing.T, root int64) map[string]any {
	t.Helper()
	id := strconv.FormatInt(root, 10)
	req := httptest.NewRequest(http.MethodGet, "/api/messages/"+id+"/replies", nil)
	req.SetPathValue("id", id)
	rec := httptest.NewRecorder()
	r.s.listReplies(rec, req, r.c)
	if rec.Code != http.StatusOK {
		t.Fatalf("replies: %d %s", rec.Code, rec.Body.String())
	}
	var out map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	return out
}

// A thread read carries the card of each link message in it, the root included, as the list does, so the web does not ask per
// message (issue 92).
func TestRepliesCarryTheCardOfEachLinkMessage(t *testing.T) {
	rig := openRig(t, "owner")
	post := func(i int, body string, root int64) int64 {
		payload := `{"client_id":"thr-unfurl-` + strconv.Itoa(i) + `","body":` + strconv.Quote(body)
		if root != 0 {
			payload += `,"thread_root_id":` + strconv.FormatInt(root, 10)
		}
		code, out := rig.postAs(t, rig.c, payload+`}`)
		if code != http.StatusCreated {
			t.Fatalf("post %d: %d %v", i, code, out)
		}
		return int64(out["id"].(float64))
	}
	root := post(1, "see https://example.com/root", 0)
	post(2, "and https://example.com/reply", root)
	rig.inTx(t, func(ctx context.Context, d pdb.DBTX) error {
		_, err := d.ExecContext(ctx, `UPDATE unfurls SET status='ok', title='Settled', kind='generic', site='example.com' WHERE url IN ('https://example.com/root','https://example.com/reply')`)
		return err
	})

	out := rig.replies(t, root)
	msgs, _ := out["messages"].([]any)
	if len(msgs) != 1 {
		t.Fatalf("replies: %d messages, want 1", len(msgs))
	}
	if card, _ := msgs[0].(map[string]any)["unfurl"].(map[string]any); card["status"] != "ok" || card["title"] != "Settled" {
		t.Errorf("reply card: %v, want ok / Settled", card)
	}
	head, _ := out["root"].(map[string]any)
	if card, _ := head["unfurl"].(map[string]any); card["status"] != "ok" {
		t.Errorf("root card: %v, want ok", card)
	}
}
