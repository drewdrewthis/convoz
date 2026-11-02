package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
)

// threads reads GET /api/conversations/:id/threads?roots=... as the rig's owner.
func (r *streamRig) threads(t *testing.T, roots []int64) (int, []struct {
	Root     struct{ ID int64 } `json:"root"`
	Messages []struct{ Body string }
}) {
	t.Helper()
	ids := make([]string, len(roots))
	for i, n := range roots {
		ids[i] = strconv.FormatInt(n, 10)
	}
	id := strconv.FormatInt(r.conv, 10)
	req := httptest.NewRequest(http.MethodGet, "/api/conversations/"+id+"/threads?roots="+strings.Join(ids, ","), nil)
	req.SetPathValue("id", id)
	rec := httptest.NewRecorder()
	r.s.listThreads(rec, req, r.c)
	var out struct {
		Threads []struct {
			Root     struct{ ID int64 } `json:"root"`
			Messages []struct{ Body string }
		} `json:"threads"`
	}
	if rec.Code == http.StatusOK {
		if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
			t.Fatal(err)
		}
	}
	return rec.Code, out.Threads
}

// One request carries the replies of every thread root on screen, so opening a chat does not ask once per root (issue 92, part B).
// A root that is not a top-level message of this conversation is left out, not an error.
func TestListThreadsCarriesTheRepliesOfEveryRoot(t *testing.T) {
	rig := openRig(t, "owner")
	post := func(i int, body string, root int64) int64 {
		payload := `{"client_id":"thr-batch-` + strconv.Itoa(i) + `","body":` + strconv.Quote(body)
		if root != 0 {
			payload += `,"thread_root_id":` + strconv.FormatInt(root, 10)
		}
		code, out := rig.postAs(t, rig.c, payload+`}`)
		if code != http.StatusCreated {
			t.Fatalf("post %d: %d %v", i, code, out)
		}
		return int64(out["id"].(float64))
	}
	a, b, c := post(1, "root a", 0), post(2, "root b", 0), post(3, "root c", 0)
	post(4, "a1", a)
	post(5, "a2", a)
	post(6, "b1", b)
	post(7, "c1", c)

	code, got := rig.threads(t, []int64{a, b, c, 999999})
	if code != http.StatusOK {
		t.Fatalf("status %d, want 200", code)
	}
	want := map[int64][]string{a: {"a1", "a2"}, b: {"b1"}, c: {"c1"}}
	if len(got) != len(want) {
		t.Fatalf("got %d threads, want %d (the unknown root is left out)", len(got), len(want))
	}
	for _, th := range got {
		var bodies []string
		for _, m := range th.Messages {
			bodies = append(bodies, m.Body)
		}
		if strings.Join(bodies, ",") != strings.Join(want[th.Root.ID], ",") {
			t.Errorf("thread %d replies %v, want %v", th.Root.ID, bodies, want[th.Root.ID])
		}
	}
}
