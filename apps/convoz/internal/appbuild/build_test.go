package appbuild

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func app(t *testing.T, index string) string {
	dir := t.TempDir()
	if err := Init(dir); err != nil {
		t.Fatal(err)
	}
	if index != "" {
		if err := os.WriteFile(filepath.Join(dir, "index.html"), []byte(index), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

func TestBuildPutsTheRuntimeFirstAndInlinesWhatIsRelative(t *testing.T) {
	dir := app(t, "<!doctype html>\n<p>hi</p>\n<script src=\"./x.js\"></script>\n<link rel=\"stylesheet\" href=\"./x.css\">\n")
	_ = os.WriteFile(filepath.Join(dir, "x.js"), []byte("document.title = 'x';"), 0o644)
	_ = os.WriteFile(filepath.Join(dir, "x.css"), []byte("p { color: red }"), 0o644)
	res, err := Build(dir, "")
	if err != nil {
		t.Fatal(err)
	}
	html, _ := os.ReadFile(res.HTML)
	text := string(html)
	if strings.Index(text, "window.convoz") > strings.Index(text, "document.title") || strings.Contains(text, "src=") || strings.Contains(text, "<link") {
		t.Fatalf("the runtime comes first and nothing stays linked: %.200s", text)
	}
	if res.Size != len(html) || len(res.SHA256) != 64 {
		t.Fatalf("size and hash: %+v", res)
	}
}

func TestBuildRefusesAnOutsideAddressAndNamesTheLine(t *testing.T) {
	dir := app(t, "<!doctype html>\n<p>hi</p>\n<script src=\"https://cdn.example/x.js\"></script>\n")
	_, err := Build(dir, "")
	var p *Problem
	if !errors.As(err, &p) || p.Code != CodeExternalRef || p.File != "index.html" || p.Line != 3 {
		t.Fatalf("got %v", err)
	}
}

func TestBuildRefusesATagAFrameMayNotHave(t *testing.T) {
	_, err := Build(app(t, "<!doctype html>\n<iframe></iframe>\n"), "")
	var p *Problem
	if !errors.As(err, &p) || p.Code != CodeForbiddenTag {
		t.Fatalf("got %v", err)
	}
}
