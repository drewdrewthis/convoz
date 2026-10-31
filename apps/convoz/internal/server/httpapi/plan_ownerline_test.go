package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/plan"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"

	"context"
)

// badLines is one text for each reason ownerline refuses, with the field word the 400 must carry.
var badLines = map[string]string{
	"has fewer than 3 words":    "Approve it",
	"has a line break":          "Approve the deploy\nand the tag",
	"is more than one sentence": "Approve the deploy. Then tag the release.",
	"uses markdown":             "Approve the **prod** deploy",
	"starts with a status word": "Waiting for you to approve the deploy",
}

// send runs one handler as the rig's agent and returns the status and the error body.
func (r *freshRig) send(t *testing.T, h func(http.ResponseWriter, *http.Request, *call), method, body string, path map[string]string) (int, wire.ErrorDetail) {
	t.Helper()
	req := httptest.NewRequest(method, "/", strings.NewReader(body))
	for k, v := range path {
		req.SetPathValue(k, v)
	}
	rec := httptest.NewRecorder()
	h(rec, req, r.agent)
	var e wire.Error
	_ = json.Unmarshal(rec.Body.Bytes(), &e)
	return rec.Code, e.Error
}

func (r *freshRig) putWaiting(t *testing.T, text string) (int, wire.ErrorDetail) {
	t.Helper()
	b, _ := json.Marshal(map[string]any{"waiting": []string{text}})
	return r.send(t, r.s.putPlan, "PUT", string(b), map[string]string{"id": strconv.FormatInt(r.conv, 10)})
}

func (r *freshRig) storedWaiting(t *testing.T) (n int) {
	t.Helper()
	r.tx(t, func(ctx context.Context, d pdb.DBTX) error {
		p, err := plan.Get(ctx, d, 901, r.conv)
		n = len(p.Waiting)
		if err == plan.ErrNotFound {
			return nil
		}
		return err
	})
	return n
}

func TestAPlanWaitThatIsNotOnePlainSentenceIs400AndStoresNothing(t *testing.T) {
	for why, text := range badLines {
		t.Run(why, func(t *testing.T) {
			r := newFreshRig(t)
			code, e := r.putWaiting(t, text)
			if code != http.StatusBadRequest || e.Code != "invalid_request" || e.Field != "waiting" || !strings.Contains(e.Message, "This one "+why+`: "`) {
				t.Fatalf("%d %+v, want 400 invalid_request on waiting with %q", code, e, why)
			}
			if n := r.storedWaiting(t); n != 0 {
				t.Fatalf("%d waits stored, want 0", n)
			}
		})
	}
}

func TestAPlanWaitOfOnePlainSentenceIs200(t *testing.T) {
	for _, text := range []string{"Approve the prod deploy of PR 240.", "Pick a color, e.g. blue or green, for the button.", "Upgrade the agent to v1.2 before Friday."} {
		r := newFreshRig(t)
		if code, e := r.putWaiting(t, text); code != http.StatusOK {
			t.Fatalf("%q: %d %+v, want 200", text, code, e)
		}
	}
}

func TestAWaitAlreadyInTheStoredPlanPassesWhenThePlanIsSentAgain(t *testing.T) {
	r := newFreshRig(t)
	r.setPlan(t, plan.Input{Waiting: []string{"Approve it"}}) // stored before the check existed
	if code, e := r.putWaiting(t, "Approve it"); code != http.StatusOK {
		t.Fatalf("%d %+v, want 200", code, e)
	}
	if code, _ := r.putWaiting(t, "Approve that"); code != http.StatusBadRequest {
		t.Fatalf("a new short wait: %d, want 400", code)
	}
}
