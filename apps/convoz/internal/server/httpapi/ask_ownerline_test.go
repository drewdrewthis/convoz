package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"testing"

	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/dbtest"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

func (r *freshRig) postQuestion(t *testing.T, question string) (int, wire.ErrorDetail) {
	t.Helper()
	b, _ := json.Marshal(wire.AskRequest{ConversationID: r.conv, ClientID: "client-" + strconv.Itoa(r.n), Question: question,
		Recommended: wire.AskOptionRequest{Label: "Yes", Why: "It is green"}, Alternatives: []wire.AskOptionRequest{{Label: "No", Why: "Wait"}},
		OwnersCall: wire.OwnersCall{Kind: "taste", Reason: "Your voice"}})
	r.n++
	return r.send(t, r.s.postAsk, "POST", string(b), nil)
}

func (r *freshRig) askCount(t *testing.T) (n int) {
	t.Helper()
	r.tx(t, func(ctx context.Context, d pdb.DBTX) error {
		return d.QueryRowContext(ctx, `SELECT count(*) FROM asks`).Scan(&n)
	})
	return n
}

func TestAnAskQuestionThatIsNotOnePlainSentenceIs400AndStoresNothing(t *testing.T) {
	for why, text := range badLines {
		t.Run(why, func(t *testing.T) {
			r := newFreshRig(t)
			code, e := r.postQuestion(t, text)
			if code != http.StatusBadRequest || e.Code != "invalid_request" || e.Field != "question" || !strings.Contains(e.Message, "This one "+why+`: "`) {
				t.Fatalf("%d %+v, want 400 invalid_request on question with %q", code, e, why)
			}
			if n := r.askCount(t); n != 0 {
				t.Fatalf("%d asks stored, want 0", n)
			}
		})
	}
}

func TestAnAskQuestionOfOnePlainSentenceIs201AndAnUnchangedQuestionIsNotJudgedAgain(t *testing.T) {
	r := newFreshRig(t)
	for _, q := range []string{"Which color, e.g. blue or green, do you want?", "Upgrade to v1.2 before Friday?"} {
		if code, e := r.postQuestion(t, q); code != http.StatusCreated {
			t.Fatalf("%q: %d %+v, want 201", q, code, e)
		}
	}
	// An ask stored before the check existed keeps its short question; an update that leaves the question alone passes.
	dbtest.Exec(t, r.s.Store, `UPDATE asks SET question = 'Merge it', version = version + 1 WHERE message_id = (SELECT min(message_id) FROM asks)`)
	var id int64
	r.tx(t, func(ctx context.Context, d pdb.DBTX) error {
		return d.QueryRowContext(ctx, `SELECT min(message_id) FROM asks`).Scan(&id)
	})
	path := map[string]string{"id": strconv.FormatInt(id, 10)}
	if code, e := r.send(t, r.s.askUpdate, "PATCH", `{"question":"Merge it","answers":"Behind a flag."}`, path); code != http.StatusOK {
		t.Fatalf("unchanged question: %d %+v, want 200", code, e)
	}
	if code, e := r.send(t, r.s.askUpdate, "PATCH", `{"question":"Merge now"}`, path); code != http.StatusBadRequest || e.Field != "question" {
		t.Fatalf("changed to a short question: %d %+v, want 400 on question", code, e)
	}
}
