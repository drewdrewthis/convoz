package httpapi

import (
	"bytes"
	"compress/gzip"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/andybalholm/brotli"
)

func TestChooseEncodingPrefersBrotliThenGzipAndHonoursQZero(t *testing.T) {
	cases := map[string]string{
		"":                    "",
		"identity":            "",
		"gzip":                "gzip",
		"gzip, br":            "br",
		"br;q=0, gzip":        "gzip",
		"deflate, gzip;q=0.5": "gzip",
		"gzip;q=0":            "",
		"BR":                  "br",
	}
	for accept, want := range cases {
		if got := chooseEncoding(accept); got != want {
			t.Errorf("chooseEncoding(%q) = %q, want %q", accept, got, want)
		}
	}
}

// answer runs a handler that writes body as JSON behind compress, for a client sending accept.
func answer(t *testing.T, accept, body string) *httptest.ResponseRecorder {
	t.Helper()
	h := compress(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, body)
	}))
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/x", nil)
	req.Header.Set("Accept-Encoding", accept)
	h.ServeHTTP(rec, req)
	return rec
}

func TestAnswersOver1KBAreCompressedAndShortOnesAreNot(t *testing.T) {
	big := `{"text":"` + strings.Repeat("a typical line of text ", 200) + `"}`
	if rec := answer(t, "br, gzip", big); rec.Header().Get("Content-Encoding") != "br" {
		t.Errorf("a big answer to a brotli client has encoding %q", rec.Header().Get("Content-Encoding"))
	} else if out, err := io.ReadAll(brotli.NewReader(rec.Body)); err != nil || string(out) != big || rec.Body.Len() > len(big)/4 {
		t.Errorf("the brotli body does not give back the answer or is not small: %v %d bytes", err, rec.Body.Len())
	}
	rec := answer(t, "gzip", big)
	if zr, err := gzip.NewReader(bytes.NewReader(rec.Body.Bytes())); err != nil || rec.Header().Get("Content-Encoding") != "gzip" {
		t.Fatalf("a big answer to a gzip client: %v %q", err, rec.Header().Get("Content-Encoding"))
	} else if out, _ := io.ReadAll(zr); string(out) != big {
		t.Errorf("the gzip body does not give back the answer")
	}
	if rec := answer(t, "br", `{"ok":true}`); rec.Header().Get("Content-Encoding") != "" || rec.Body.String() != `{"ok":true}` {
		t.Errorf("a short answer was compressed: %q %q", rec.Header().Get("Content-Encoding"), rec.Body.String())
	}
	if rec := answer(t, "", big); rec.Header().Get("Content-Encoding") != "" || rec.Body.String() != big {
		t.Errorf("a client that accepts nothing got an encoded answer")
	}
}
