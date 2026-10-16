package httpapi

import (
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/dbtest"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform"
)

func TestCSRFComparesToTheOriginWithItsPort(t *testing.T) {
	s := &Server{Cfg: Config{Host: "convoz.testonly.ts.net", Origin: "https://convoz.testonly.ts.net:8473", Unix: true}}
	h := s.csrf(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) }))
	for origin, want := range map[string]int{
		"https://convoz.testonly.ts.net:8473": http.StatusNoContent,
		"https://convoz.testonly.ts.net":      http.StatusForbidden,
	} {
		r := httptest.NewRequest("POST", "/api/x", strings.NewReader("{}"))
		r.Header.Set("Origin", origin)
		r.Header.Set("X-Convoz", "1")
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != want {
			t.Errorf("Origin %s: %d want %d", origin, w.Code, want)
		}
	}
}

func TestBootstrapLinkCarriesThePort(t *testing.T) {
	h := NewAdminHandler(dbtest.Store(t), platform.SystemClock{}, "https://convoz.testonly.ts.net:8473", nil)
	r := httptest.NewRequest("POST", "/admin/bootstrap-link", strings.NewReader("{}"))
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"url":"https://convoz.testonly.ts.net:8473/bootstrap#`) {
		t.Errorf("%d %s", w.Code, w.Body.String())
	}
}

// Only the device flow (a CLI with no cookie and no credential) skips the Origin check; every other write
// without an Authorization header still needs it.
func TestCSRFExemptsOnlyTheRoutesMarkedNoCSRF(t *testing.T) {
	exempt := map[string]bool{}
	for _, r := range Routes {
		if r.NoCSRF {
			exempt[r.Method+" "+r.Pattern] = true
		}
	}
	if len(exempt) != 2 || !exempt["POST /api/device/code"] || !exempt["POST /api/device/token"] {
		t.Fatalf("NoCSRF routes: %v", exempt)
	}
	s := &Server{Cfg: Config{Host: "convoz.testonly.ts.net", Origin: "https://convoz.testonly.ts.net"}, csrfExempt: exempt}
	h := s.csrf(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) }))
	for path, want := range map[string]int{
		"/api/device/code":  http.StatusNoContent,
		"/api/device/token": http.StatusNoContent,
		"/api/sessions":     http.StatusForbidden,
		"/api/crew/agents":  http.StatusForbidden,
	} {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest("POST", path, strings.NewReader("{}")))
		if w.Code != want {
			t.Errorf("POST %s with no Origin: %d want %d", path, w.Code, want)
		}
	}
}
