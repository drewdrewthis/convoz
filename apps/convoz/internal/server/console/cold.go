package console

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"time"
)

// The cold page (design §12.2). On a slow link every request wave costs a round trip, so a first screen loaded with an empty cache
// (Now at /, the conversation list at /chats) comes in one response: the build's static part (web/cold-head.html: the theme boot
// script, the stylesheet and the main bundle inline, cut before </body>) and a tail the server writes per request: its own
// scripts (the confusables set) and the first screen's reads as a JSON data block. A service worker asks for the lean shell
// instead (X-Convoz-Shell: lean): it holds the files, and a page with user data never lands in its cache (I-39).
var (
	coldHead, _   = dist.ReadFile("web/cold-head.html")
	coldHeadBr, _ = dist.ReadFile("web/cold-head.html.br") // brotli, flushed but not finished: the tail continues the stream
	readsList, _  = dist.ReadFile("web/first-reads.json")
)

// DataBlockID is the id of the data block: {"generated_at": <server ms>, "reads": {"/api/now": <its answer>, ...}}.
const DataBlockID = "cz-data"

// LeanHeader is what a service worker sends to get the lean shell of a page URL.
const LeanHeader = "X-Convoz-Shell"

// FirstReads lists, by page path, the GET routes whose answers that page's cold load carries inline (the build's
// web/first-reads.json, the list the web app's head start uses too). Empty when the binary has no web build.
func FirstReads() map[string][]string {
	out := map[string][]string{}
	if readsList != nil {
		if err := json.Unmarshal(readsList, &out); err != nil {
			panic("console: web/first-reads.json: " + err.Error())
		}
	}
	return out
}

// Lean reports whether the request asks for the lean shell (a service worker's fetch).
func Lean(r *http.Request) bool { return r.Header.Get(LeanHeader) == "lean" }

// ColdPage is the cold page of this build, checked against the server's own scripts. Its zero value is not usable; NewColdPage.
type ColdPage struct {
	head, headBr []byte
	tail         []byte   // the server's scripts, written before the data block
	scripts      []string // CSP sources of the inline scripts of head and tail
	styles       []string // CSP sources of the inline stylesheets
}

var (
	inlineScript = regexp.MustCompile(`(?s)<script(\s[^>]*)?>(.*?)</script>`)
	inlineStyle  = regexp.MustCompile(`(?s)<style(\s[^>]*)?>(.*?)</style>`)
	endsScript   = regexp.MustCompile(`(?i)</script|<!--`)
)

// errCarriageReturn: an HTML parser turns a \r in an inline block into \n, so the browser would hash other bytes than the server
// did and the CSP would refuse the block.
var errCarriageReturn = errors.New("console: an inline block of the cold page holds a carriage return")

// cspHash is the CSP source that allows one inline block: its exact bytes, hashed.
func cspHash(block []byte) string {
	sum := sha256.Sum256(block)
	return "'sha256-" + base64.StdEncoding.EncodeToString(sum[:]) + "'"
}

// NewColdPage returns the cold page of this build, or nil when the binary has no web build. The build inlines the theme boot
// script from its source file; boot is the server's copy (settings.BootScript), and they must match byte for byte. tail is the
// classic scripts the server appends after the build's part (they run before the app's module, which waits for the parse).
func NewColdPage(boot []byte, tail ...[]byte) (*ColdPage, error) {
	if coldHead == nil || coldHeadBr == nil {
		return nil, nil
	}
	if !bytes.Contains(coldHead, append(append([]byte("<script>"), boot...), "</script>"...)) {
		return nil, errors.New("console: the cold page does not carry the server's theme boot script (rebuild the web app)")
	}
	p := &ColdPage{head: coldHead, headBr: coldHeadBr}
	for _, script := range tail {
		if endsScript.Match(script) {
			return nil, errors.New("console: a script the cold page appends holds markup that would end its block")
		}
		if bytes.IndexByte(script, '\r') >= 0 {
			return nil, errCarriageReturn
		}
		p.tail = append(append(append(p.tail, "<script>"...), script...), "</script>"...)
	}
	static := append(append([]byte{}, p.head...), p.tail...)
	for _, m := range inlineScript.FindAllSubmatch(static, -1) {
		if bytes.Contains(m[1], []byte(" src=")) {
			return nil, errors.New("console: the cold page loads a script by URL")
		}
		if bytes.IndexByte(m[2], '\r') >= 0 {
			return nil, errCarriageReturn
		}
		p.scripts = append(p.scripts, cspHash(m[2]))
	}
	for _, m := range inlineStyle.FindAllSubmatch(static, -1) {
		if bytes.IndexByte(m[2], '\r') >= 0 {
			return nil, errCarriageReturn
		}
		p.styles = append(p.styles, cspHash(m[2]))
	}
	return p, nil
}

// csp is the cold page's policy: the lean page's, with each inline block allowed by its hash (never 'unsafe-inline').
func (p *ColdPage) csp() string {
	scripts := strings.Join(p.scripts, " ") // the JSON data block is not executable, so CSP never checks it
	return "default-src 'self'; script-src 'self' " + scripts + "; style-src 'self' " + strings.Join(p.styles, " ") +
		"; " + connectSrc() + "; img-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
}

// DataBlock is the JSON of the data block, escaped for an HTML script element: <, > and & (so no "</script>" or "<!--" in a
// message ends it), and U+2028 and U+2029, as \u escapes. reads holds each route's answer as it wrote it.
func DataBlock(generatedAt time.Time, reads map[string]json.RawMessage) ([]byte, error) {
	raw, err := json.Marshal(struct {
		GeneratedAt int64                      `json:"generated_at"`
		Reads       map[string]json.RawMessage `json:"reads"`
	}{generatedAt.UnixMilli(), reads})
	if err != nil {
		return nil, fmt.Errorf("console: data block: %w", err)
	}
	var out bytes.Buffer
	json.HTMLEscape(&out, raw)
	return out.Bytes(), nil
}

// Serve writes the cold page with the data block (from DataBlock). It is never stored (no-store) and depends on the session
// (Vary: Cookie). A client that takes brotli gets the build's highest-quality copy of the static part with the tail appended to
// the same stream as stored blocks; any other gets the plain page, which the compression middleware gzips when it is asked to.
func (p *ColdPage) Serve(w http.ResponseWriter, r *http.Request, data []byte, br bool) {
	var tail []byte
	tail = append(tail, p.tail...)
	tail = append(tail, `<script type="application/json" id="`+DataBlockID+`">`...)
	tail = append(tail, data...)
	tail = append(tail, "</script>\n</body>\n</html>\n"...)
	h := w.Header()
	h.Set("Content-Type", "text/html; charset=utf-8")
	h.Set("Content-Security-Policy", p.csp())
	h.Set("Cache-Control", "no-store")
	h.Add("Vary", "Cookie")
	h.Add("Vary", LeanHeader)
	h.Add("Vary", "Accept-Encoding")
	var body []byte
	if br {
		h.Set("Content-Encoding", "br")
		body = appendStored(append([]byte{}, p.headBr...), tail)
	} else {
		body = append(append([]byte{}, p.head...), tail...)
	}
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(body)
}

// appendStored finishes a flushed brotli stream with data as stored (uncompressed) meta-blocks and the last, empty meta-block
// (RFC 7932 §9.2). Each header is 20 bits, padded to 3 bytes: ISLAST=0, MNIBBLES=4, MLEN-1 (16 bits), ISUNCOMPRESSED=1.
func appendStored(stream, data []byte) []byte {
	for len(data) > 0 {
		n := min(len(data), 1<<16)
		head := uint32(n-1)<<3 | 1<<19
		stream = append(stream, byte(head), byte(head>>8), byte(head>>16))
		stream = append(stream, data[:n]...)
		data = data[n:]
	}
	return append(stream, 0x03) // ISLAST=1, ISLASTEMPTY=1
}
