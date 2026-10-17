// Package appbuild makes a Tier-2 app: it bundles the files of a source folder into one HTML document, puts the frame runtime
// first in it, and writes the document with the app that posts it. Agents need no npm: esbuild runs inside the binary.
// The CLI uses it; the server never does.
package appbuild

import (
	"crypto/sha256"
	_ "embed"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/evanw/esbuild/pkg/api"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/appschema"
)

// KitVersion is the version of the frame runtime inlined into every bundle; a manifest names it as `kit`.
const KitVersion = "1.0.0"

// Codes of a build that is refused.
const (
	CodeTooLarge     = "app_bundle_too_large"
	CodeExternalRef  = "app_bundle_external_ref"
	CodeForbiddenTag = "app_bundle_forbidden_tag"
	CodeBadSource    = "app_bundle_source"
	// Placeholder is the fallback `dist/app.json` carries until the agent gives the real one.
	Placeholder = "Replace this with the words of the app, for readers that cannot open it."
)

//go:embed runtime/runtime.js
var runtimeJS string

// Problem is a refusal that names the place: a code, the file and the line.
type Problem struct {
	Code, File string
	Line       int
	Message    string
}

func (p *Problem) Error() string {
	if p.File == "" {
		return p.Code + ": " + p.Message
	}
	if p.Line == 0 {
		return fmt.Sprintf("%s: %s: %s", p.Code, p.File, p.Message)
	}
	return fmt.Sprintf("%s: %s:%d: %s", p.Code, p.File, p.Line, p.Message)
}

// Result is what a build made.
type Result struct {
	HTML     string   `json:"html_path"`
	AppJSON  string   `json:"app_json_path"`
	Size     int      `json:"size"`
	SHA256   string   `json:"sha256"`
	Warnings []string `json:"warnings"`
}

// Init writes a small app into dir: a manifest and an index.html that answers with a result when the button is tapped.
func Init(dir string) error {
	if _, err := os.Stat(filepath.Join(dir, "convoz.app.json")); err == nil {
		return fmt.Errorf("%s already has an app", dir)
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	name := filepath.Base(filepath.Clean(dir))
	manifest := fmt.Sprintf("{\n  \"name\": %q,\n  \"version\": \"1.0.0\",\n  \"icon\": \"app\",\n  \"height\": {\"initial\": 160, \"min\": 80, \"max\": 400},\n  \"results\": true,\n  \"permissions\": []\n}\n", name)
	if err := os.WriteFile(filepath.Join(dir, "convoz.app.json"), []byte(manifest), 0o644); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, "index.html"), []byte(starterHTML), 0o644)
}

const starterHTML = `<!doctype html>
<meta charset="utf-8">
<style>
  body { margin: 0; padding: 12px; font: 14px/1.45 system-ui, sans-serif; background: var(--cvz-raised); color: var(--cvz-text) }
  button { font: inherit; padding: 6px 12px }
</style>
<p id="hello">Loading...</p>
<button id="go">Send a reply</button>
<script>
  convoz.onInit(({ data }) => {
    document.getElementById("hello").textContent = data && data.hello ? data.hello : "Hello from your app.";
    convoz.fit();
  });
  document.getElementById("go").onclick = () => convoz.result({ summary: "Pressed the button", value: { pressed: true } });
</script>
`

// Build makes dir/dist (or out) from the app in dir.
func Build(dir, out string) (Result, error) {
	if out == "" {
		out = filepath.Join(dir, "dist")
	}
	manifest, err := readManifest(dir)
	if err != nil {
		return Result{}, err
	}
	src, err := os.ReadFile(filepath.Join(dir, "index.html"))
	if err != nil {
		return Result{}, &Problem{Code: CodeBadSource, File: "index.html", Message: "the app has no index.html"}
	}
	var warnings []string
	if p, w := scanHTML("index.html", string(src)); p != nil {
		return Result{}, p
	} else {
		warnings = append(warnings, w...)
	}
	html, err := inline(dir, string(src))
	if err != nil {
		return Result{}, err
	}
	html = putRuntimeFirst(html)
	if len(html) > appschema.MaxBundleBytes {
		return Result{}, &Problem{Code: CodeTooLarge, File: "index.html", Message: fmt.Sprintf("the bundle is %d bytes; a bundle has at most %d", len(html), appschema.MaxBundleBytes)}
	}
	if err := os.MkdirAll(out, 0o755); err != nil {
		return Result{}, err
	}
	sum := sha256.Sum256([]byte(html))
	htmlPath, jsonPath := filepath.Join(out, "app.html"), filepath.Join(out, "app.json")
	if err := os.WriteFile(htmlPath, []byte(html), 0o644); err != nil {
		return Result{}, err
	}
	envelope := map[string]any{"v": 1, "type": "frame", "title": manifest["name"], "fallback": Placeholder,
		"props": map[string]any{"bundle": map[string]any{"file": "app.html"}, "manifest": manifest}}
	if h, ok := manifest["height"].(map[string]any); ok {
		if n, ok := h["initial"].(float64); ok {
			envelope["height"] = int(n)
		}
	}
	raw, _ := json.MarshalIndent(envelope, "", "  ")
	if err := os.WriteFile(jsonPath, append(raw, '\n'), 0o644); err != nil {
		return Result{}, err
	}
	return Result{HTML: htmlPath, AppJSON: jsonPath, Size: len(html), SHA256: hex.EncodeToString(sum[:]), Warnings: append([]string{}, warnings...)}, nil
}

// readManifest reads convoz.app.json, fills what the build knows (the bridge and the kit version) and checks it.
func readManifest(dir string) (map[string]any, error) {
	raw, err := os.ReadFile(filepath.Join(dir, "convoz.app.json"))
	if err != nil {
		return nil, &Problem{Code: CodeBadSource, File: "convoz.app.json", Message: "the app has no convoz.app.json"}
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, &Problem{Code: CodeBadSource, File: "convoz.app.json", Message: "is not JSON"}
	}
	m["bridge"], m["kit"] = 1, KitVersion
	if _, ok := m["permissions"]; !ok {
		m["permissions"] = []any{}
	}
	filled, _ := json.Marshal(m)
	if issue := appschema.CheckManifest(filled); issue != nil {
		return nil, &Problem{Code: issue.Code, File: "convoz.app.json", Message: issue.Path + ": " + issue.Message}
	}
	return m, nil
}

var (
	forbiddenTag = regexp.MustCompile(`(?i)<\s*(iframe|object|embed|base)\b`)
	metaRefresh  = regexp.MustCompile(`(?i)<\s*meta\b[^>]*http-equiv\s*=\s*["']?refresh`)
	linkHint     = regexp.MustCompile(`(?i)<\s*link\b[^>]*\brel\s*=\s*["']?(prefetch|preconnect|dns-prefetch|preload)`)
	formAction   = regexp.MustCompile(`(?i)<\s*form\b[^>]*\baction\s*=`)
	absAttr      = regexp.MustCompile(`(?i)\b(?:src|href|poster|srcset|action|data)\s*=\s*["']?\s*((?:[a-z][a-z0-9+.-]*:|//)[^"'\s>]*)`)
	absURL       = regexp.MustCompile(`(?i)url\(\s*["']?\s*((?:[a-z][a-z0-9+.-]*:|//)[^"')\s]*)`)
	absImport    = regexp.MustCompile(`(?i)\b(?:import|from)\s*\(?\s*["'` + "`" + `]\s*((?:https?:)?//[^"'` + "`" + `]*)`)
	absFetch     = regexp.MustCompile(`(?i)\bfetch\(\s*["'` + "`" + `]\s*((?:https?:)?//[^"'` + "`" + `]*)`)
	passwordIn   = regexp.MustCompile(`(?i)<\s*input\b[^>]*type\s*=\s*["']?password`)
)

// scanHTML refuses what a frame must not hold, naming the line (spec §5.2 step 4), and warns about a password field.
func scanHTML(file, src string) (*Problem, []string) {
	var warnings []string
	for i, line := range strings.Split(src, "\n") {
		n := i + 1
		for _, re := range []*regexp.Regexp{forbiddenTag, metaRefresh, linkHint, formAction} {
			if m := re.FindString(line); m != "" {
				return &Problem{Code: CodeForbiddenTag, File: file, Line: n, Message: "a frame cannot have " + strings.TrimSpace(m)}, nil
			}
		}
		if p := externalIn(file, n, line, true); p != nil {
			return p, nil
		}
		if passwordIn.MatchString(line) {
			warnings = append(warnings, fmt.Sprintf("%s:%d: a password field in an app is not private; the owner should not type secrets into apps", file, n))
		}
	}
	return nil, warnings
}

// externalIn finds an absolute address in one line. data: addresses are the only ones a frame may hold. markup is true for
// HTML, where attributes name addresses; in a script or a style only url(), import and fetch( do.
func externalIn(file string, line int, text string, markup bool) *Problem {
	res := []*regexp.Regexp{absURL, absImport, absFetch}
	if markup {
		res = append(res, absAttr)
	}
	for _, re := range res {
		for _, m := range re.FindAllStringSubmatch(text, -1) {
			if strings.HasPrefix(strings.ToLower(m[1]), "data:") || strings.HasPrefix(m[1], "#") {
				continue
			}
			return &Problem{Code: CodeExternalRef, File: file, Line: line, Message: "a frame cannot load " + m[1]}
		}
	}
	return nil
}

var (
	scriptSrc = regexp.MustCompile(`(?is)<script\b([^>]*?)\bsrc\s*=\s*["']([^"']+)["']([^>]*)>\s*</script>`)
	styleLink = regexp.MustCompile(`(?is)<link\b[^>]*>`)
	hrefAttr  = regexp.MustCompile(`(?is)\bhref\s*=\s*["']([^"']+)["']`)
	imgSrc    = regexp.MustCompile(`(?is)(<img\b[^>]*?\bsrc\s*=\s*["'])([^"']+)(["'])`)
	typeAttr  = regexp.MustCompile(`(?i)\btype\s*=\s*["']?module`)
)

// inline replaces the relative scripts, styles and images of index.html with their content.
func inline(dir, src string) (string, error) {
	var failure error
	fail := func(err error) string {
		if failure == nil {
			failure = err
		}
		return ""
	}
	src = scriptSrc.ReplaceAllStringFunc(src, func(tag string) string {
		m := scriptSrc.FindStringSubmatch(tag)
		code, err := bundleScript(dir, m[2], typeAttr.MatchString(m[1]+m[3]))
		if err != nil {
			return fail(err)
		}
		attrs := strings.TrimSpace(m[1] + " " + m[3])
		if attrs != "" {
			attrs = " " + attrs
		}
		return "<script" + attrs + ">" + strings.ReplaceAll(code, "</script", `<\/script`) + "</script>"
	})
	src = styleLink.ReplaceAllStringFunc(src, func(tag string) string {
		if !strings.Contains(strings.ToLower(tag), "stylesheet") {
			return tag
		}
		m := hrefAttr.FindStringSubmatch(tag)
		if m == nil {
			return tag
		}
		css, err := bundleStyle(dir, m[1])
		if err != nil {
			return fail(err)
		}
		return "<style>" + strings.ReplaceAll(css, "</style", `<\/style`) + "</style>"
	})
	src = imgSrc.ReplaceAllStringFunc(src, func(tag string) string {
		m := imgSrc.FindStringSubmatch(tag)
		if strings.HasPrefix(m[2], "data:") {
			return tag
		}
		uri, err := dataURI(dir, m[2])
		if err != nil {
			return fail(err)
		}
		return m[1] + uri + m[3]
	})
	return src, failure
}

// localPath keeps a relative address inside the app folder.
func localPath(dir, rel string) (string, error) {
	p := filepath.Join(dir, filepath.FromSlash(rel))
	if r, err := filepath.Rel(dir, p); err != nil || strings.HasPrefix(r, "..") {
		return "", &Problem{Code: CodeBadSource, File: rel, Message: "is outside the app folder"}
	}
	return p, nil
}

func dataURI(dir, rel string) (string, error) {
	p, err := localPath(dir, rel)
	if err != nil {
		return "", err
	}
	raw, err := os.ReadFile(p)
	if err != nil {
		return "", &Problem{Code: CodeBadSource, File: rel, Message: "cannot be read"}
	}
	if strings.HasSuffix(strings.ToLower(rel), ".svg") {
		return "data:image/svg+xml;base64," + base64.StdEncoding.EncodeToString(raw), nil
	}
	return "data:" + http.DetectContentType(raw) + ";base64," + base64.StdEncoding.EncodeToString(raw), nil
}

var dataLoaders = map[string]api.Loader{
	".png": api.LoaderDataURL, ".jpg": api.LoaderDataURL, ".jpeg": api.LoaderDataURL, ".gif": api.LoaderDataURL, ".webp": api.LoaderDataURL,
	".svg": api.LoaderDataURL, ".woff": api.LoaderDataURL, ".woff2": api.LoaderDataURL, ".ttf": api.LoaderDataURL,
}

func bundleScript(dir, rel string, module bool) (string, error) {
	p, err := localPath(dir, rel)
	if err != nil {
		return "", err
	}
	if prob, err := scanFile(rel, p); err != nil || prob != nil {
		return "", orProblem(prob, err)
	}
	format := api.FormatIIFE
	if module {
		format = api.FormatESModule
	}
	return build(rel, api.BuildOptions{EntryPoints: []string{p}, Bundle: true, MinifyWhitespace: true, MinifySyntax: true, Target: api.ES2020, Format: format, Loader: dataLoaders})
}

func bundleStyle(dir, rel string) (string, error) {
	p, err := localPath(dir, rel)
	if err != nil {
		return "", err
	}
	if prob, err := scanFile(rel, p); err != nil || prob != nil {
		return "", orProblem(prob, err)
	}
	return build(rel, api.BuildOptions{EntryPoints: []string{p}, Bundle: true, MinifyWhitespace: true, MinifySyntax: true, Loader: dataLoaders})
}

func orProblem(p *Problem, err error) error {
	if p != nil {
		return p
	}
	return err
}

// scanFile looks for an outside address in a script or a style the app brings.
func scanFile(rel, path string) (*Problem, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, &Problem{Code: CodeBadSource, File: rel, Message: "cannot be read"}
	}
	for i, line := range strings.Split(string(raw), "\n") {
		if p := externalIn(rel, i+1, line, false); p != nil {
			return p, nil
		}
	}
	return nil, nil
}

func build(rel string, o api.BuildOptions) (string, error) {
	o.Write, o.LogLevel = false, api.LogLevelSilent
	res := api.Build(o)
	if len(res.Errors) > 0 {
		e := res.Errors[0]
		line := 0
		if e.Location != nil {
			line = e.Location.Line
		}
		return "", &Problem{Code: CodeBadSource, File: rel, Line: line, Message: e.Text}
	}
	if len(res.OutputFiles) == 0 {
		return "", errors.New("esbuild made no output for " + rel)
	}
	return strings.TrimSpace(string(res.OutputFiles[0].Contents)), nil
}

// putRuntimeFirst puts the frame runtime ahead of every other script, after the doctype if there is one.
func putRuntimeFirst(html string) string {
	tag := "<script>" + strings.ReplaceAll(runtimeJS, "</script", `<\/script`) + "</script>\n"
	if i := strings.Index(strings.ToLower(html), "<!doctype"); i >= 0 {
		if j := strings.Index(html[i:], ">"); j >= 0 {
			cut := i + j + 1
			return html[:cut] + "\n" + tag + strings.TrimLeft(html[cut:], "\n")
		}
	}
	return tag + html
}
