package httpapi

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestLookalikesAssetAnswers304ToAMatchingETag(t *testing.T) {
	first := httptest.NewRecorder()
	lookalikesAsset(nil, first, httptest.NewRequest("GET", "/assets/lookalikes.js", nil), nil)
	etag := first.Header().Get("ETag")
	if first.Code != http.StatusOK || etag == "" || first.Body.Len() == 0 {
		t.Fatalf("first fetch: code %d, etag %q, %d bytes", first.Code, etag, first.Body.Len())
	}
	if got := first.Header().Get("Cache-Control"); got != "no-cache" {
		t.Errorf("Cache-Control = %q, want no-cache", got)
	}

	again := httptest.NewRequest("GET", "/assets/lookalikes.js", nil)
	again.Header.Set("If-None-Match", etag)
	second := httptest.NewRecorder()
	lookalikesAsset(nil, second, again, nil)
	if second.Code != http.StatusNotModified || second.Body.Len() != 0 {
		t.Errorf("revalidation: code %d with %d bytes, want 304 and no body", second.Code, second.Body.Len())
	}

	stale := httptest.NewRequest("GET", "/assets/lookalikes.js", nil)
	stale.Header.Set("If-None-Match", `"other"`)
	third := httptest.NewRecorder()
	lookalikesAsset(nil, third, stale, nil)
	if third.Code != http.StatusOK {
		t.Errorf("a different ETag got %d, want 200", third.Code)
	}
}
