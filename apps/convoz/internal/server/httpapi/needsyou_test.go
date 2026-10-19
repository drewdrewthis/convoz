package httpapi

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

func TestNeedsYouAllowed(t *testing.T) {
	yes, no := true, false
	for name, c := range map[string]struct {
		in      *bool
		allowed bool
		status  int
		warned  bool
	}{
		"false is news":    {&no, true, http.StatusOK, false},
		"absent is warned": {nil, true, http.StatusOK, true},
		"true is an ask":   {&yes, false, http.StatusUnprocessableEntity, false},
	} {
		w := httptest.NewRecorder()
		if got := needsYouAllowed(w, wire.PostRequest{Body: "Ship it?", NeedsYou: c.in}); got != c.allowed {
			t.Errorf("%s: allowed = %v", name, got)
		}
		if !c.allowed && (w.Code != c.status || !strings.Contains(w.Body.String(), `convoz ask --question \"Ship it?\"`)) {
			t.Errorf("%s: %d %s", name, w.Code, w.Body)
		}
		if warned := w.Header().Get("Convoz-Warning") == needsYouWarning; warned != c.warned {
			t.Errorf("%s: warned = %v", name, warned)
		}
	}
}
