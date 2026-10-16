// Package console serves the owner console: bare pages for the S1a flows (sign in, bootstrap,
// onboarding, recover, passkeys, Now). Plain HTML and one script, no framework; the React app (S-U)
// replaces it and must pass the same role and text locators.
package console

import (
	"bytes"
	"embed"
	"html/template"
	"net/http"
)

//go:embed templates/*.html static/*
var files embed.FS

// CSP is the policy every page carries: our own script and style only, nothing framed, no plugins.
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; " +
	"object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"

type page struct {
	Title   string
	Heading string
	Name    string
	tmpl    *template.Template
}

var pages = map[string]*page{}

func init() {
	for _, p := range []page{
		{Name: "bootstrap", Title: "Set up Convoz", Heading: "Set up Convoz"},
		{Name: "signin", Title: "Sign in", Heading: "Sign in"},
		{Name: "recover", Title: "Recover access", Heading: "Recover access"},
		{Name: "now", Title: "Now", Heading: "Now"},
		{Name: "onboarding", Title: "Set up a second way in", Heading: "Set up a second way in"},
		{Name: "passkeys", Title: "Passkeys", Heading: "Passkeys"},
	} {
		p := p
		p.tmpl = template.Must(template.ParseFS(files, "templates/layout.html", "templates/"+p.Name+".html"))
		pages[p.Name] = &p
	}
}

// Page serves the named page.
func Page(name string) http.HandlerFunc {
	p := pages[name]
	var buf bytes.Buffer
	if err := p.tmpl.ExecuteTemplate(&buf, "layout", p); err != nil {
		panic(err) // a template that cannot render is a build defect
	}
	body := buf.Bytes()
	return func(w http.ResponseWriter, _ *http.Request) {
		h := w.Header()
		h.Set("Content-Type", "text/html; charset=utf-8")
		h.Set("Content-Security-Policy", CSP)
		h.Set("Cache-Control", "no-store")
		_, _ = w.Write(body)
	}
}

// Asset serves a file from static/, e.g. "console.js".
func Asset(name, contentType string) http.HandlerFunc {
	body, err := files.ReadFile("static/" + name)
	if err != nil {
		panic(err)
	}
	return func(w http.ResponseWriter, _ *http.Request) {
		h := w.Header()
		h.Set("Content-Type", contentType)
		h.Set("Cache-Control", "no-cache")
		_, _ = w.Write(body)
	}
}
