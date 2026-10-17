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

// page is one console page. Shell pages are the signed-in app (prototype v41): the title and the account menu in the top bar and the
// floating bottom navigation (Now, Conversations, Crew). The others (sign in, setup, recovery, the second-way-in step) are focused
// flows with the wordmark only.
type page struct {
	Name, Title, Heading string
	Shell                bool
	Chat                 bool   // a conversation page: it fills the screen, with Back and the agent in the top bar and no bottom navigation
	NewChat              bool   // a "New conversation" button floats above the bottom navigation
	Back                 string // the Back button of the top bar: where it goes (empty: none)
	Open                 bool   // the top bar shows how many asks wait ("2 open")
	Public               bool   // reachable without a session, so a 401 must not send the browser to sign in
	HideHeading          bool   // the script names the page once it knows (a setup link says what it is worth)
	Script               string // a page script served from /assets, loaded after console.js
	Tab                  string
	tmpl                 *template.Template
}

var pages = map[string]*page{}

func init() {
	for _, p := range []page{
		{Name: "bootstrap", Title: "Set up Convoz", Heading: "Welcome to Convoz", Public: true, HideHeading: true},
		{Name: "signin", Title: "Sign in", Heading: "Sign in", Public: true},
		{Name: "recover", Title: "Use a recovery code", Heading: "Use a recovery code", Public: true},
		{Name: "chats", Title: "Conversations", Heading: "Conversations", Shell: true, Tab: "chats", NewChat: true, Back: "/", Script: "chat.js"},
		{Name: "chat", Title: "Chat", Heading: "Chat", Chat: true, Script: "chat.js"},
		{Name: "notfound", Title: "Chat not found", Heading: "Chat not found", Shell: true, Tab: "chats", Back: "/chats"},
		{Name: "now", Title: "Now", Heading: "Now", Shell: true, Tab: "now", Open: true},
		{Name: "crew", Title: "Crew", Heading: "Crew", Shell: true, Tab: "crew", Back: "/", Script: "chat.js"},
		{Name: "machines", Title: "Machines", Heading: "Machines", Shell: true, Tab: "crew", Back: "/crew"},
		{Name: "onboarding", Title: "Set up a second way in", Heading: "Set up a second way in"},
		{Name: "passkeys", Title: "Passkeys", Heading: "Passkeys", Shell: true, Tab: "", Back: "/"},
		{Name: "recovery", Title: "Recovery codes", Heading: "Recovery codes", Shell: true, Tab: "", Back: "/"},
		{Name: "account", Title: "Account", Heading: "Account", Shell: true, Tab: "", Back: "/"},
	} {
		p := p
		p.tmpl = template.Must(template.ParseFS(files, "templates/layout.html", "templates/"+p.Name+".html"))
		pages[p.Name] = &p
	}
}

// render builds the page once; a template that cannot render is a build defect.
func render(name string) []byte {
	p := pages[name]
	var buf bytes.Buffer
	if err := p.tmpl.ExecuteTemplate(&buf, "layout", p); err != nil {
		panic(err)
	}
	return buf.Bytes()
}

func write(w http.ResponseWriter, status int, body []byte) {
	h := w.Header()
	h.Set("Content-Type", "text/html; charset=utf-8")
	h.Set("Content-Security-Policy", CSP)
	h.Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_, _ = w.Write(body)
}

// Page serves the named page.
func Page(name string) http.HandlerFunc {
	body := render(name)
	return func(w http.ResponseWriter, _ *http.Request) { write(w, http.StatusOK, body) }
}

// NotFound answers 404 with the console's own page and a link back to Conversations.
func NotFound() http.HandlerFunc {
	body := render("notfound")
	return func(w http.ResponseWriter, _ *http.Request) { write(w, http.StatusNotFound, body) }
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
