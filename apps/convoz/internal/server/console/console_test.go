package console

import (
	"bytes"
	"encoding/json"
	"io"
	"io/fs"
	"math"
	"net/http"
	"net/http/httptest"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/andybalholm/brotli"
)

// builtCSS is the stylesheet every page of the web build loads (a lazy feature's own stylesheet comes with its chunk).
func builtCSS(t *testing.T) string {
	t.Helper()
	requireBuild(t)
	names, err := fs.Glob(dist, "web/assets/main-*.css")
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
	// Other light blocks (the canvas grain) may come first; the override is the one that sets the theme colours.
	var light []int
	for _, at := range regexp.MustCompile(`@media\s*\(prefers-color-scheme:\s*light\)`).FindAllStringIndex(css, -1) {
		if regexp.MustCompile(`^[^@]*--color-surface:`).MatchString(css[at[1]:]) {
			light = at
			break
		}
	}
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

// Every page (the lean shell and the cold page) runs only code the CSP names: each inline block has a CSP hash and the policy has
// no 'unsafe-inline'. The lean shell has no inline block at all, and every asset it names is served.
func TestEachInlineBlockHasACSPHashAndTheCSPHasNoUnsafeInline(t *testing.T) {
	requireBuild(t)
	page := string(index)
	if regexp.MustCompile(`<script(?:\s[^>]*)?>[^<]`).MatchString(page) || strings.Contains(page, "<style") || strings.Contains(page, " style=") {
		t.Fatal("index.html carries inline script or style, and its CSP allows none")
	}
	if strings.Contains(CSP, "unsafe-inline") {
		t.Fatalf("the lean page's CSP allows unsafe-inline: %s", CSP)
	}
	for _, m := range regexp.MustCompile(`(?:src|href)="/assets/([^"/]+)"`).FindAllStringSubmatch(page, -1) {
		if m[1] == "lookalikes.js" { // served by httpapi from the identity table
			continue
		}
		rec := httptest.NewRecorder()
		req := httptest.NewRequest("GET", "/assets/"+m[1], nil)
		req.SetPathValue("file", m[1])
		Asset(rec, req, false)
		if rec.Code != http.StatusOK || !strings.Contains(rec.Header().Get("Cache-Control"), "immutable") {
			t.Fatalf("/assets/%s: %d %q", m[1], rec.Code, rec.Header().Get("Cache-Control"))
		}
	}

	const dataBlock = `{"generated_at":1,"reads":{}}`
	body, csp := serveCold(t, false, []byte(dataBlock))
	if strings.Contains(csp, "unsafe-inline") || strings.Contains(csp, "unsafe-eval") {
		t.Fatalf("the cold page's CSP allows unsafe code: %s", csp)
	}
	blocks := inlineBlocks(body)
	if len(blocks) < 5 { // theme boot, main bundle, stylesheet, confusables, data
		t.Fatalf("the cold page has %d inline blocks", len(blocks))
	}
	if n := strings.Count(csp, "'sha256-"); n != len(blocks)-1 { // every block but the data block
		t.Fatalf("the CSP lists %d hashes for %d executable or style blocks: %s", n, len(blocks)-1, csp)
	}
	for _, b := range blocks {
		if b.text == dataBlock { // type="application/json": never executed, so the CSP never checks it and must not list it
			if strings.Contains(csp, b.hash) {
				t.Fatalf("the CSP lists the data block's hash, which it never checks: %s", csp)
			}
			continue
		}
		if !strings.Contains(csp, b.hash) {
			t.Fatalf("an inline %s block (%.60q) has no hash in the CSP", b.kind, b.text)
		}
		// A changed byte is a block the policy does not allow.
		changed := []byte(b.text)
		changed[len(changed)/2] ^= 1
		if strings.Contains(csp, cspHash(changed)) {
			t.Fatalf("the CSP allows an inline %s block with a changed byte", b.kind)
		}
	}
}

type block struct{ kind, text, hash string }

// inlineBlocks reads every inline script and style of a page, each with the CSP source of its exact bytes.
func inlineBlocks(page string) []block {
	var out []block
	for _, kind := range []string{"script", "style"} {
		for _, m := range regexp.MustCompile(`(?s)<`+kind+`(\s[^>]*)?>(.*?)</`+kind+`>`).FindAllStringSubmatch(page, -1) {
			if strings.Contains(m[1], " src=") {
				continue
			}
			out = append(out, block{kind, m[2], cspHash([]byte(m[2]))})
		}
	}
	return out
}

// bootScript is the theme boot script the build inlined: the first script of the cold page. (httpapi checks that it is the
// settings module's own; this package may not import that module.)
func bootScript(t *testing.T) []byte {
	t.Helper()
	m := regexp.MustCompile(`(?s)<script>(.*?)</script>`).FindSubmatch(coldHead)
	if m == nil {
		t.Fatal("the cold page has no boot script")
	}
	return m[1]
}

// serveCold serves this build's cold page with its theme boot script and a stand-in confusables script.
func serveCold(t *testing.T, br bool, data []byte) (string, string) {
	t.Helper()
	requireBuild(t)
	p, err := NewColdPage(bootScript(t), []byte("globalThis.CONVOZ_LOOKALIKES=[];"))
	if err != nil || p == nil {
		t.Fatalf("cold page: %v %v", p, err)
	}
	rec := httptest.NewRecorder()
	p.Serve(rec, httptest.NewRequest("GET", "/", nil), data, br)
	body := rec.Body.Bytes()
	if br {
		if rec.Header().Get("Content-Encoding") != "br" {
			t.Fatalf("br: Content-Encoding %q", rec.Header().Get("Content-Encoding"))
		}
		var err error
		if body, err = io.ReadAll(brotli.NewReader(bytes.NewReader(body))); err != nil {
			t.Fatalf("the brotli page does not decode: %v", err)
		}
	}
	h := rec.Header()
	if rec.Code != http.StatusOK || h.Get("Cache-Control") != "no-store" || !slices.Contains(h.Values("Vary"), "Cookie") {
		t.Fatalf("cold page: %d, Cache-Control %q, Vary %q", rec.Code, h.Get("Cache-Control"), h.Values("Vary"))
	}
	return string(body), h.Get("Content-Security-Policy")
}

// The brotli copy is the build's static part continued in the same stream: it decodes to exactly the plain page.
func TestColdPageInBrotliDecodesToThePlainPage(t *testing.T) {
	data := []byte(`{"generated_at":1,"reads":{"/api/me":{"x":"` + strings.Repeat("y", 70_000) + `"}}}`) // more than one stored block
	plain, _ := serveCold(t, false, data)
	packed, _ := serveCold(t, true, data)
	if packed != plain {
		t.Fatalf("brotli %d bytes, plain %d bytes: not the same page", len(packed), len(plain))
	}
	if !strings.HasSuffix(plain, `<script type="application/json" id="cz-data">`+string(data)+"</script>\n</body>\n</html>\n") {
		t.Fatal("the data block is not the end of the page")
	}
}

// A message body cannot end the data block: <, >, & and the line separators the old JSON-in-script rules feared are escaped,
// and the block still reads back to the same text.
func TestDataBlockEscapesMarkupAndLineSeparators(t *testing.T) {
	text := "</script><script>alert(1)</script> <!-- & \u2028 \u2029 end"
	answer, _ := json.Marshal(map[string]string{"body": text})
	out, err := DataBlock(time.UnixMilli(1234), map[string]json.RawMessage{"/api/conversations": answer})
	if err != nil {
		t.Fatal(err)
	}
	if strings.ContainsAny(string(out), "<>&\u2028\u2029") {
		t.Fatalf("the data block holds raw markup or a line separator: %s", out)
	}
	var back struct {
		GeneratedAt int64                        `json:"generated_at"`
		Reads       map[string]map[string]string `json:"reads"`
	}
	if err := json.Unmarshal(out, &back); err != nil || back.GeneratedAt != 1234 || back.Reads["/api/conversations"]["body"] != text {
		t.Fatalf("read back: %+v %v", back, err)
	}
	page, csp := serveCold(t, false, out)
	if strings.Count(page, "</script>") != strings.Count(page, "<script") || strings.Contains(csp, cspHash(out)) {
		t.Fatal("the data block's text ended a script element, or its hash is in the CSP")
	}
}

func TestColdPageRefusesABuildWithAnotherBootScript(t *testing.T) {
	requireBuild(t)
	if _, err := NewColdPage([]byte("(function(){})();"), nil); err == nil {
		t.Fatal("a cold page whose theme boot script is not the server's was accepted")
	}
	if _, err := NewColdPage(bootScript(t), []byte("x='</script>'")); err == nil {
		t.Fatal("a tail script that ends its own block was accepted")
	}
}

func TestColdPageRefusesACarriageReturnInAnInlineBlock(t *testing.T) {
	requireBuild(t)
	if _, err := NewColdPage(bootScript(t), []byte("x=1;\r\ny=2;")); err == nil {
		t.Fatal("a tail script with a carriage return was accepted")
	}
	boot, saved := bootScript(t), coldHead
	t.Cleanup(func() { coldHead = saved })
	for _, tag := range []string{"<style>", `<script type="module">`, "<script>"} { // stylesheet, main bundle, theme boot
		coldHead = bytes.Replace(saved, []byte(tag), []byte(tag+"\r"), 1)
		if _, err := NewColdPage(boot); err == nil {
			t.Fatalf("a build with a carriage return after %s was accepted", tag)
		}
	}
}

func TestAssetSendsTheBrotliCopyToAClientThatTakesIt(t *testing.T) {
	requireBuild(t)
	m := regexp.MustCompile(`src="/assets/(main-[^"/]+\.js)"`).FindStringSubmatch(string(index))
	if m == nil {
		t.Fatal("index.html loads no main bundle")
	}
	plain, err := fs.ReadFile(dist, "web/assets/"+m[1])
	if err != nil {
		t.Fatal(err)
	}
	for _, br := range []bool{true, false} {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest("GET", "/assets/"+m[1], nil)
		req.SetPathValue("file", m[1])
		Asset(rec, req, br)
		body := rec.Body.Bytes()
		if br {
			if rec.Header().Get("Content-Encoding") != "br" || len(body) >= len(plain) {
				t.Fatalf("br: %q, %d of %d bytes", rec.Header().Get("Content-Encoding"), len(body), len(plain))
			}
			if body, err = io.ReadAll(brotli.NewReader(bytes.NewReader(body))); err != nil {
				t.Fatal(err)
			}
		}
		if rec.Code != http.StatusOK || !bytes.Equal(body, plain) || rec.Header().Get("Vary") != "Accept-Encoding" {
			t.Fatalf("br=%v: %d, same body %v, Vary %q", br, rec.Code, bytes.Equal(body, plain), rec.Header().Get("Vary"))
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
		Asset(rec, req, true)
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
