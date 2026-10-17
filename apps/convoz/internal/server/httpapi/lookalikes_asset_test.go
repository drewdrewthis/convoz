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

	for _, tag := range []string{etag, "W/" + etag, `"x", ` + etag, "*"} {
		again := httptest.NewRequest("GET", "/assets/lookalikes.js", nil)
		again.Header.Set("If-None-Match", tag)
		second := httptest.NewRecorder()
		lookalikesAsset(nil, second, again, nil)
		if second.Code != http.StatusNotModified || second.Body.Len() != 0 {
			t.Errorf("If-None-Match %q: code %d with %d bytes, want 304 and no body", tag, second.Code, second.Body.Len())
		}
	}

	head := httptest.NewRecorder()
	lookalikesAsset(nil, head, httptest.NewRequest("HEAD", "/assets/lookalikes.js", nil), nil)
	if head.Code != http.StatusOK || head.Body.Len() != 0 || head.Header().Get("ETag") != etag {
		t.Errorf("HEAD: code %d with %d bytes, want 200 and no body", head.Code, head.Body.Len())
	}

	stale := httptest.NewRequest("GET", "/assets/lookalikes.js", nil)
	stale.Header.Set("If-None-Match", `"other"`)
	third := httptest.NewRecorder()
	lookalikesAsset(nil, third, stale, nil)
	if third.Code != http.StatusOK {
		t.Errorf("a different ETag got %d, want 200", third.Code)
	}
}
