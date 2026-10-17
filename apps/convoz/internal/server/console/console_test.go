package console

import (
	"io/fs"
	"math"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

// builtCSS is the stylesheet the web build ships.
func builtCSS(t *testing.T) string {
	t.Helper()
	requireBuild(t)
	names, err := fs.Glob(dist, "web/assets/*.css")
	if err != nil || len(names) != 1 {
		t.Fatalf("want one built stylesheet, got %v (%v)", names, err)
	}
	raw, err := dist.ReadFile(names[0])
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

// The default look is dark: the theme (no media query) must define a dark page, and only the prefers-color-scheme: light
// block may lighten it. A browser with no preference, or one that cannot evaluate the query, therefore gets dark.
func TestCSSDefaultIsDarkAndLightIsTheOverride(t *testing.T) {
	css := builtCSS(t)
	light := regexp.MustCompile(`@media\s*\(prefers-color-scheme:\s*light\)`).FindStringIndex(css)
	if light == nil {
		t.Fatal("no light override block")
	}
	base, over := css[:light[0]], css[light[0]:]
	if !strings.Contains(base, ":root") {
		t.Fatal("no :root theme before the media query")
	}
	bg, text := customProperty(t, base, "--color-surface"), customProperty(t, base, "--color-text")
	if luminance(t, bg) > 0.1 || luminance(t, text) < 0.6 {
		t.Fatalf("the default must be light text on a dark page: surface %s, text %s", bg, text)
	}
	if luminance(t, customProperty(t, over, "--color-surface")) < 0.8 || luminance(t, customProperty(t, over, "--color-text")) > 0.1 {
		t.Fatal("the prefers-color-scheme: light block must give dark text on a light page")
	}
}

func customProperty(t *testing.T, css, name string) string {
	t.Helper()
	m := regexp.MustCompile(regexp.QuoteMeta(name) + `:\s*(#[0-9a-fA-F]{6}|#[0-9a-fA-F]{3})\b`).FindStringSubmatch(css)
	if m == nil {
		t.Fatalf("%s is not a hex colour here", name)
	}
	hex := m[1]
	if len(hex) == 4 {
		hex = "#" + strings.Repeat(hex[1:2], 2) + strings.Repeat(hex[2:3], 2) + strings.Repeat(hex[3:4], 2)
	}
	return hex
}

// luminance is the WCAG relative luminance of a #rrggbb colour, 0 (black) to 1 (white).
func luminance(t *testing.T, hex string) float64 {
	t.Helper()
	channel := func(from int) float64 {
		v, err := strconv.ParseUint(hex[from:from+2], 16, 8)
		if err != nil {
			t.Fatal(err)
		}
		c := float64(v) / 255
		if c <= 0.03928 {
			return c / 12.92
		}
		return math.Pow((c+0.055)/1.055, 2.4)
	}
	return 0.2126*channel(1) + 0.7152*channel(3) + 0.0722*channel(5)
}

// The page loads only our own files: no inline script or style needs a nonce, and every asset it names is served.
func TestPageNeedsNoInlineCodeAndItsAssetsAreServed(t *testing.T) {
	requireBuild(t)
	page := string(index)
	if regexp.MustCompile(`<script(?:\s[^>]*)?>[^<]`).MatchString(page) || strings.Contains(page, "<style") || strings.Contains(page, " style=") {
		t.Fatal("index.html carries inline script or style, which the CSP refuses")
	}
	for _, m := range regexp.MustCompile(`(?:src|href)="/assets/([^"/]+)"`).FindAllStringSubmatch(page, -1) {
		if m[1] == "lookalikes.js" { // served by httpapi from the identity table
			continue
		}
		rec := httptest.NewRecorder()
		req := httptest.NewRequest("GET", "/assets/"+m[1], nil)
		req.SetPathValue("file", m[1])
		Asset(rec, req)
		if rec.Code != http.StatusOK || !strings.Contains(rec.Header().Get("Cache-Control"), "immutable") {
			t.Fatalf("/assets/%s: %d %q", m[1], rec.Code, rec.Header().Get("Cache-Control"))
		}
	}
}

func TestNotFoundMarksTheDocument(t *testing.T) {
	requireBuild(t)
	rec := httptest.NewRecorder()
	NotFound(rec, httptest.NewRequest("GET", "/chats/9", nil))
	if rec.Code != http.StatusNotFound || !strings.Contains(rec.Body.String(), notFoundMark) || rec.Header().Get("Content-Security-Policy") != CSP {
		t.Fatalf("404 page: %d, marked %v", rec.Code, strings.Contains(rec.Body.String(), notFoundMark))
	}
}

func TestAssetRefusesNamesThatAreNotBuildFiles(t *testing.T) {
	for _, name := range []string{"", "../index.html", ".hidden.js", "x.html", "nope.js"} {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest("GET", "/assets/x", nil)
		req.SetPathValue("file", name)
		Asset(rec, req)
		if rec.Code != http.StatusNotFound {
			t.Errorf("%q: %d", name, rec.Code)
		}
	}
}

// requireBuild fails (never skips) a test that needs the web build: CI and `make build` build it first.
func requireBuild(t *testing.T) {
	t.Helper()
	if !Built() {
		t.Fatal("the web app is not built into console/web: run make -C apps/convoz web")
	}
}
