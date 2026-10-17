package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// syncGet calls GET /api/sync?<query> as the rig's owner.
func (r *streamRig) syncGet(t *testing.T, query string) (int, map[string]any) {
	t.Helper()
	rec := httptest.NewRecorder()
	r.s.syncDelta(rec, httptest.NewRequest(http.MethodGet, "/api/sync?"+query, nil), r.c)
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("answer is not JSON: %q", rec.Body.String())
	}
	return rec.Code, body
}

func TestSyncDeltaAnswersAnotherEpochOrAFutureCursorWithAReset(t *testing.T) {
	rig := openRig(t, "owner")
	for _, cursor := range []string{"0:1", "1:99999"} {
		code, body := rig.syncGet(t, "cursor="+cursor)
		if code != http.StatusOK || body["reset"] != true || body["reason"] != "epoch" {
			t.Errorf("cursor %s: %d %v, want a reset", cursor, code, body)
		}
	}
	if code, _ := rig.syncGet(t, "cursor=nonsense"); code != http.StatusBadRequest {
		t.Errorf("a cursor that is not epoch:seq got %d, want 400", code)
	}
	if code, _ := rig.syncGet(t, "cursor=1:0&wait=26"); code != http.StatusBadRequest {
		t.Errorf("a wait over 25 s got %d, want 400", code)
	}
}

func TestSyncDeltaReturnsThinEventsAndMovesTheCursorPastWhatItScanned(t *testing.T) {
	rig := openRig(t, "owner")
	rig.ownerPosts(t, false)
	_, body := rig.syncGet(t, "cursor=1:0")
	events, _ := body["events"].([]any)
	var sawMessage bool
	for _, e := range events {
		row := e.(map[string]any)
		if row["type"] == "message.created.v1" {
			sawMessage = true
		}
		if raw, _ := json.Marshal(row["payload"]); len(raw) > 1024 || strings.Contains(string(raw), "secret-body") {
			t.Errorf("event %v is not thin: %s", row["seq"], raw)
		}
	}
	if !sawMessage {
		t.Errorf("the owner's own message event is missing: %v", body)
	}
	// Asking again from the returned cursor gives nothing new.
	_, again := rig.syncGet(t, "cursor="+body["cursor"].(string))
	if got, _ := again["events"].([]any); len(got) != 0 {
		t.Errorf("a second read from the returned cursor found %v", got)
	}
}

func TestStreamFramesNameTheFrameBeforeThem(t *testing.T) {
	rig := openRig(t, "owner")
	rig.ownerPosts(t, true)
	rig.waitSeen(t, "event: message.created")
	if !strings.Contains(rig.text(), `"prev_seq_for_you":`) || !strings.Contains(rig.text(), "retry: ") {
		t.Errorf("a frame names the one before it and the stream asks for a retry time: %q", rig.text())
	}
}
