package console

import (
	"math"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

// The default look is dark: the bare :root block (no media query) must define a dark page, and only the
// prefers-color-scheme: light block may lighten it. A browser with no preference, or one that cannot evaluate
// the query, therefore gets dark.
func TestCSSDefaultIsDarkAndLightIsTheOverride(t *testing.T) {
	raw, err := files.ReadFile("static/console.css")
	if err != nil {
		t.Fatal(err)
	}
	css := string(raw)
	mediaAt := strings.Index(css, "@media (prefers-color-scheme: light)")
	if mediaAt < 0 {
		t.Fatal("no light override block")
	}
	base, light := css[:mediaAt], css[mediaAt:]
	if !regexp.MustCompile(`:root\s*\{`).MatchString(base) {
		t.Fatal("no bare :root block before the media query")
	}
	bg, text := customProperty(t, base, "--bg"), customProperty(t, base, "--text")
	if luminance(t, bg) > 0.1 || luminance(t, text) < 0.6 {
		t.Fatalf("the default must be light text on a dark page: --bg %s, --text %s", bg, text)
	}
	if luminance(t, customProperty(t, light, "--bg")) < 0.8 || luminance(t, customProperty(t, light, "--text")) > 0.1 {
		t.Fatal("the prefers-color-scheme: light block must give dark text on a light page")
	}
}

func customProperty(t *testing.T, css, name string) string {
	t.Helper()
	m := regexp.MustCompile(regexp.QuoteMeta(name) + `:\s*(#[0-9a-fA-F]{6})\s*;`).FindStringSubmatch(css)
	if m == nil {
		t.Fatalf("%s is not a #rrggbb value here", name)
	}
	return m[1]
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
