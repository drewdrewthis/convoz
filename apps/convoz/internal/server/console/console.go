// Package console serves the owner console: the pages of the S1 flows (sign in, bootstrap, onboarding, recover,
// passkeys, recovery codes, account, Now with the machine requests, Machines). Plain HTML, one stylesheet and one
// script, no framework; the React app (S-U) replaces it and must pass the same role and text locators.
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

// page is one console page. Shell pages are the signed-in app: account menu in the top bar and the bottom
// navigation. The others (sign in, setup, recovery, the second-way-in step) are focused flows with the wordmark only.
type page struct {
	Name, Title, Heading string
	Shell                bool
	Public               bool // reachable without a session, so a 401 must not send the browser to sign in
	HideHeading          bool // the script names the page once it knows (a setup link says what it is worth)
	Tab                  string
	tmpl                 *template.Template
}

var pages = map[string]*page{}

func init() {
	for _, p := range []page{
		{Name: "bootstrap", Title: "Set up Convoz", Heading: "Welcome to Convoz", Public: true, HideHeading: true},
		{Name: "signin", Title: "Sign in", Heading: "Sign in", Public: true},
		{Name: "recover", Title: "Use a recovery code", Heading: "Use a recovery code", Public: true},
		{Name: "now", Title: "Now", Heading: "Now", Shell: true, Tab: "now"},
		{Name: "machines", Title: "Machines", Heading: "Machines", Shell: true, Tab: "account"},
		{Name: "onboarding", Title: "Set up a second way in", Heading: "Set up a second way in"},
		{Name: "passkeys", Title: "Passkeys", Heading: "Passkeys", Shell: true, Tab: "account"},
		{Name: "recovery", Title: "Recovery codes", Heading: "Recovery codes", Shell: true, Tab: "account"},
		{Name: "account", Title: "Account", Heading: "Account", Shell: true, Tab: "account"},
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
