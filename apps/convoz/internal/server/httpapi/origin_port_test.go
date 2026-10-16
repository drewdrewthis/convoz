package httpapi

import (
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
	h := NewAdminHandler(migratedStore(t), platform.SystemClock{}, "https://convoz.testonly.ts.net:8473", nil)
	r := httptest.NewRequest("POST", "/admin/bootstrap-link", strings.NewReader("{}"))
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"url":"https://convoz.testonly.ts.net:8473/bootstrap#`) {
		t.Errorf("%d %s", w.Code, w.Body.String())
	}
}
