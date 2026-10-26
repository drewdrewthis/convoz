package httpapi

import (
	"bytes"
	"context"
	"errors"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/dbtest"
)

// slowRead runs long enough on SQLite that a cancel lands while it runs.
const slowRead = "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n) SELECT count(*) FROM n"

// A read the client cancelled is 499, not 500: it is logged as a client close and never as an internal error (issue 125).
func TestAReadTheClientCancelledIs499NotA500(t *testing.T) {
	store := dbtest.Store(t)
	var out bytes.Buffer
	s := NewServer(store, platform.SystemClock{}, nil, nil, Config{}, log.New(&out, "", 0))

	before, cancel := context.WithCancel(context.Background())
	cancel()
	_, errBefore := store.Reader.SQL().ExecContext(before, "SELECT 1") // cancelled before the query: context canceled

	during, stop := context.WithCancel(context.Background())
	time.AfterFunc(50*time.Millisecond, stop)
	var n int64
	errDuring := store.Reader.SQL().QueryRowContext(during, slowRead).Scan(&n) // cancelled while it runs: sqlite3 interrupted
	if errBefore == nil || errDuring == nil {
		t.Fatalf("the reads were not cancelled: before=%v during=%v", errBefore, errDuring)
	}

	for name, c := range map[string]struct {
		ctx context.Context
		err error
	}{
		"cancelled before the query": {before, errBefore},
		"interrupted while it runs":  {during, errDuring},
		"wrapped":                    {before, errors.Join(errors.New("list conversations"), errBefore)},
	} {
		out.Reset()
		w := httptest.NewRecorder()
		s.internalError(w, httptest.NewRequest(http.MethodGet, "/api/conversations", nil).WithContext(c.ctx), c.err)
		if w.Code != 499 {
			t.Errorf("%s (%v): status %d, want 499", name, c.err, w.Code)
		}
		if strings.Contains(out.String(), "internal error") || !strings.Contains(out.String(), "client closed GET /api/conversations") {
			t.Errorf("%s: log %q, want a client close and no internal error", name, out.String())
		}
	}

	// the same error on a request the client did not cancel is still a 500: only a client that went away is 499
	out.Reset()
	w := httptest.NewRecorder()
	s.internalError(w, httptest.NewRequest(http.MethodGet, "/api/conversations", nil), errDuring)
	if w.Code != http.StatusInternalServerError || !strings.Contains(out.String(), "internal error on GET /api/conversations") {
		t.Errorf("a live request: status %d log %q, want 500 and an internal error", w.Code, out.String())
	}
}
