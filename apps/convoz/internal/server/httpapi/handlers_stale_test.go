package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/authz"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/conversation"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/dbtest"
)

// staleAs calls POST /api/conversations/:id/stale as the agent identity with the given body.
func (r *streamRig) staleAs(t *testing.T, agent int64, body string) (int, map[string]any) {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/conversations/"+strconv.FormatInt(r.conv, 10)+"/stale", strings.NewReader(body))
	req.SetPathValue("id", strconv.FormatInt(r.conv, 10))
	rec := httptest.NewRecorder()
	r.s.markStale(rec, req, &call{p: authz.Principal{SessionID: 1, IdentityID: agent}})
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out
}

func (r *streamRig) conversationNow(t *testing.T) conversation.Conversation {
	t.Helper()
	var cv conversation.Conversation
	r.inTx(t, func(ctx context.Context, d pdb.DBTX) (err error) {
		cv, _, err = conversation.Get(ctx, d, r.conv)
		return err
	})
	return cv
}

// An agent in the conversation marks it stale: the owner's stream hears at once, the reason shows with it, and the next
// message brings it back. An agent outside it is refused, and so is a mark while the owner wrote the last message.
func TestAMemberAgentMarksAConversationStaleUntilTheNextMessage(t *testing.T) {
	rig := openRig(t, "owner")
	dbtest.Exec(t, rig.s.Store,
		`INSERT INTO identities (id, kind, handle, display_name, display_skeleton, avatar_letter, avatar_palette, created_at) VALUES
		   (900,'agent','devtool','Devtool','devtool','D',0,1),(901,'agent','docs','Docs','docs','D',0,1)`,
		`INSERT INTO agents (identity_id, created_by_human) VALUES (900,1),(901,1)`,
		`INSERT INTO participants (conversation_id, identity_id, status, joined_seq, added_by, added_at, status_at) VALUES (`+strconv.FormatInt(rig.conv, 10)+`,900,'active',0,1,1,1)`)

	if code, _ := rig.staleAs(t, 901, `{}`); code != http.StatusForbidden {
		t.Errorf("an agent outside the conversation: %d, want 403", code)
	}
	if rig.conversationNow(t).StaleAt != 0 {
		t.Fatal("a refused mark changed the conversation")
	}
	if code, _ := rig.staleAs(t, 900, `{"reason":"`+strings.Repeat("x", 201)+`"}`); code != http.StatusBadRequest {
		t.Errorf("a reason over 200 characters: %d, want 400", code)
	}

	code, body := rig.staleAs(t, 900, `{"reason":"shipped, nothing left"}`)
	if code != http.StatusOK {
		t.Fatalf("a member agent marks it stale: %d %v", code, body)
	}
	if cv, _ := body["conversation"].(map[string]any); cv["stale"] != true || cv["stale_reason"] != "shipped, nothing left" {
		t.Errorf("the answer shows the conversation as stale: %v", body)
	}
	if !rig.conversationNow(t).Stale() {
		t.Error("the conversation is not stale after the mark")
	}
	rig.s.Bus.Notify()
	rig.waitSeen(t, "event: conversation.changed")

	time.Sleep(5 * time.Millisecond) // the next message lands after the mark, not in the same millisecond
	rig.ownerPosts(t, false)
	if rig.conversationNow(t).Stale() {
		t.Error("a message after the mark did not bring the conversation back")
	}

	// The owner spoke last: the conversation waits on the agents, so it shows as such and an agent cannot mark it (#42).
	rig.inTx(t, func(ctx context.Context, d pdb.DBTX) error {
		v, _, err := rig.s.visibleView(ctx, d, rig.c.p, rig.conv)
		if !v.OwnerLast || v.Stale {
			t.Errorf("after the owner's message: owner_last=%v stale=%v, want true false", v.OwnerLast, v.Stale)
		}
		return err
	})
	if code, body := rig.staleAs(t, 900, `{}`); code != http.StatusConflict {
		t.Errorf("a mark while the owner spoke last: %d %v, want 409", code, body)
	}
	if rig.conversationNow(t).Stale() {
		t.Error("a refused mark made the conversation stale")
	}
}

func TestStaleHoldsOnlyWhileNoMessageCameAfterTheMark(t *testing.T) {
	for _, tc := range []struct {
		name          string
		staleAt, last int64
		want          bool
	}{
		{"never marked", 0, 100, false},
		{"marked after the last message", 200, 100, true},
		{"marked in the same millisecond", 100, 100, true},
		{"a message after the mark", 100, 200, false},
		{"brought back by the owner (a negative mark)", -300, 100, false},
	} {
		if got := (conversation.Conversation{StaleAt: tc.staleAt, LastActivityAt: tc.last}).Stale(); got != tc.want {
			t.Errorf("%s: %v, want %v", tc.name, got, tc.want)
		}
	}
}

// The owner marks a conversation stale from the rail even where he wrote the last message, and brings it back with reopen:true. Bring
// back also restarts the 48 hour quiet clock (back_at), so a quiet row leaves Older too (Drew, conv 179 msg 10071).
func TestTheOwnerMarksStaleAndBringsBackEvenWhenHeWroteLast(t *testing.T) {
	rig := openRig(t, "owner")
	rig.ownerPosts(t, false)
	time.Sleep(5 * time.Millisecond)
	owner := func(body string) (int, map[string]any) {
		req := httptest.NewRequest(http.MethodPost, "/api/conversations/"+strconv.FormatInt(rig.conv, 10)+"/stale", strings.NewReader(body))
		req.SetPathValue("id", strconv.FormatInt(rig.conv, 10))
		rec := httptest.NewRecorder()
		rig.s.markStale(rec, req, rig.c)
		var out map[string]any
		_ = json.Unmarshal(rec.Body.Bytes(), &out)
		return rec.Code, out
	}
	if code, _ := owner(`{}`); code != http.StatusConflict {
		t.Fatalf("without force (the voice call) the guard holds: %d, want 409", code)
	}
	if code, _ := owner(`{"force":true}`); code != http.StatusOK || !rig.conversationNow(t).Stale() {
		t.Fatalf("the owner marks it stale after his own message: %d stale=%v", code, rig.conversationNow(t).Stale())
	}
	before := rig.s.Clock.Now().UnixMilli()
	code, body := owner(`{"reopen":true}`)
	cv := rig.conversationNow(t)
	if code != http.StatusOK || cv.Stale() || cv.BackAt() < before {
		t.Errorf("bring back: %d stale=%v back_at=%d, want 200, false and at least %d", code, cv.Stale(), cv.BackAt(), before)
	}
	if got, _ := body["conversation"].(map[string]any); got["stale"] != nil || got["back_at"] != float64(cv.BackAt()) {
		t.Errorf("the answer shows it brought back: %v", body)
	}
	time.Sleep(5 * time.Millisecond)
	if code, _ := owner(`{"force":true}`); code != http.StatusOK || !rig.conversationNow(t).Stale() || rig.conversationNow(t).BackAt() != 0 {
		t.Errorf("a new mark after bring back: %d stale=%v back_at=%d, want stale and no back_at", code, rig.conversationNow(t).Stale(), rig.conversationNow(t).BackAt())
	}
}

// Who may NOT close or reopen: an agent cannot close a chat the owner wrote last, and cannot reopen one.
func TestAnAgentCannotCloseWhereTheOwnerWroteLastNorReopen(t *testing.T) {
	rig := openRig(t, "owner")
	dbtest.Exec(t, rig.s.Store,
		`INSERT INTO identities (id, kind, handle, display_name, display_skeleton, avatar_letter, avatar_palette, created_at) VALUES (900,'agent','devtool','Devtool','devtool','D',0,1)`,
		`INSERT INTO agents (identity_id, created_by_human) VALUES (900,1)`,
		`INSERT INTO participants (conversation_id, identity_id, status, joined_seq, added_by, added_at, status_at) VALUES (`+strconv.FormatInt(rig.conv, 10)+`,900,'active',0,1,1,1)`)
	rig.ownerPosts(t, false)

	if code, body := rig.staleAs(t, 900, `{"force":true}`); code != http.StatusConflict || !strings.Contains(fmt.Sprint(body), "owner_spoke_last") {
		t.Errorf("an agent closes where the owner wrote last, even with force: %d %v, want 409 owner_spoke_last", code, body)
	}
	if rig.conversationNow(t).Stale() {
		t.Fatal("a refused close made the conversation stale")
	}

	time.Sleep(5 * time.Millisecond)
	rig.inTx(t, func(ctx context.Context, d pdb.DBTX) error {
		return conversation.MarkStale(ctx, d, rig.s.Clock.Now(), rig.conv, "")
	})
	if code, _ := rig.staleAs(t, 900, `{"reopen":true}`); code != http.StatusForbidden {
		t.Errorf("an agent reopens: %d, want 403", code)
	}
	if !rig.conversationNow(t).Stale() {
		t.Error("a refused reopen changed the conversation")
	}
}

// A human who is not the owner (a guest or member: no session either) is treated like an agent: no force, no reopen.
func TestAGuestIsTreatedLikeAnAgentWhenClosingAndReopening(t *testing.T) {
	rig := openRig(t, "owner")
	rig.ownerPosts(t, false)
	guest := func(body string) int {
		req := httptest.NewRequest(http.MethodPost, "/api/conversations/"+strconv.FormatInt(rig.conv, 10)+"/stale", strings.NewReader(body))
		req.SetPathValue("id", strconv.FormatInt(rig.conv, 10))
		rec := httptest.NewRecorder()
		p := rig.c.p
		p.Role = "member"
		rig.s.markStale(rec, req, &call{p: p})
		return rec.Code
	}
	if code := guest(`{"force":true}`); code == http.StatusOK || rig.conversationNow(t).Stale() {
		t.Errorf("a guest forces a close where the owner wrote last: %d stale=%v, want a refusal", code, rig.conversationNow(t).Stale())
	}
	if code := guest(`{"reopen":true}`); code != http.StatusForbidden {
		t.Errorf("a guest reopens: %d, want 403", code)
	}
}
