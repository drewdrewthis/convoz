// Package console serves the owner console: the web app of apps/web, built by Vite into web/ and embedded in the binary
// (`make build` and `make release` build it first, so a binary never ships a stale UI; web/placeholder.txt alone keeps
// the package compiling before the first build, and then every page answers 503). Every page URL gets the same
// index.html (the lean shell), except a first screen's cold load (cold.go); the app picks the screen from the URL. The server keeps the sign-in redirects and the 404 of a chat that is
// not the caller's, and marks that 404 in the document so the app shows the not-found page.
package console

import (
	"bytes"
	"embed"
	"io/fs"
	"net/http"
	"path"
	"regexp"
	"strings"
	"sync/atomic"
)

//go:embed all:web
var dist embed.FS

// CSP is the policy of the lean shell: our own script and style only, nothing framed, no plugins. The shell has no inline
// script or style (Vite links its hashed files). The cold page (cold.go) keeps this policy and allows each of its inline blocks
// by the hash of its bytes, never by 'unsafe-inline'.
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; " +
	"object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"

// googleLive is what a voice call adds to connect-src: the token-free live socket of Gemini, nothing else (the page talks to Google
// directly with a one-use token, so the key never reaches it). It is in the policy only while the server has a voice key.
const googleLive = " https://generativelanguage.googleapis.com wss://generativelanguage.googleapis.com"

var voiceOn atomic.Bool

// SetVoice says whether the server has a voice key: the pages then may connect to Google's live address.
func SetVoice(on bool) { voiceOn.Store(on) }

// connectSrc is the connect-src of every page: our own origin, and Google's live address while voice is on.
func connectSrc() string {
	if voiceOn.Load() {
		return "connect-src 'self'" + googleLive
	}
	return "connect-src 'self'"
}

// policy is CSP for the lean shell at this moment.
func policy() string {
	if !voiceOn.Load() {
		return CSP
	}
	return strings.Replace(CSP, "connect-src 'self'", connectSrc(), 1)
}

// notFoundMark is how a 404 page tells the app it is one: the root element carries data-status="404".
const notFoundMark = `<html lang="en" data-status="404">`

var (
	index, _ = dist.ReadFile("web/index.html") // nil until the web app is built
	notFound = markNotFound(index)
)

// Built reports whether the binary carries the web app.
func Built() bool { return index != nil }

// markNotFound puts the 404 mark on the root element; a build without it is a build defect.
func markNotFound(page []byte) []byte {
	if page == nil {
		return nil
	}
	out := bytes.Replace(page, []byte(`<html lang="en">`), []byte(notFoundMark), 1)
	if bytes.Equal(out, page) {
		panic(`console: index.html has no <html lang="en"> to mark`)
	}
	return out
}

const notBuilt = "The web app is not in this build. Run make -C apps/convoz build.\n"

func writePage(w http.ResponseWriter, status int, body []byte) {
	if body == nil {
		http.Error(w, notBuilt, http.StatusServiceUnavailable)
		return
	}
	h := w.Header()
	h.Set("Content-Type", "text/html; charset=utf-8")
	h.Set("Content-Security-Policy", policy())
	h.Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_, _ = w.Write(body)
}

// Page serves the app for a page URL.
func Page(w http.ResponseWriter, _ *http.Request) { writePage(w, http.StatusOK, index) }

// NotFound answers 404 with the app's not-found page and a link back to Conversations.
func NotFound(w http.ResponseWriter, _ *http.Request) { writePage(w, http.StatusNotFound, notFound) }

// File serves one public file of the build at a fixed URL (icons, the manifest, the font licence). They keep their names
// across builds, so the browser revalidates them.
func File(name, contentType string) http.HandlerFunc {
	body, err := dist.ReadFile("web/" + name)
	return func(w http.ResponseWriter, r *http.Request) {
		if err != nil {
			http.NotFound(w, r)
			return
		}
		h := w.Header()
		h.Set("Content-Type", contentType)
		h.Set("Cache-Control", "no-cache")
		_, _ = w.Write(body)
	}
}

// hashedTypes are the files Vite writes into assets/ with a content hash in the name. Any other name is not ours: 404.
var hashedTypes = map[string]string{
	".js":    "text/javascript; charset=utf-8",
	".css":   "text/css; charset=utf-8",
	".woff2": "font/woff2",
	".svg":   "image/svg+xml",
	".png":   "image/png",
}

// viteHash is the content hash Vite puts before the extension of a built file: "-" and 8 characters (main-DwQgiNMS.js).
var viteHash = regexp.MustCompile(`-[A-Za-z0-9_-]{8}\.[A-Za-z0-9]+$`)

// assetCacheControl is the Cache-Control of one file of assets/ (name may hold folders): a year for a name with a Vite hash, which a
// new build changes; revalidation for a name without one (the manifest names the icons, the stylesheet names the grain).
func assetCacheControl(name string) string {
	if viteHash.MatchString(path.Base(name)) {
		return "public, max-age=31536000, immutable"
	}
	return "no-cache"
}

// Asset serves web/assets/<file>. A content-hashed build file never changes under its name, so it is cached for a year; a file of
// public/ (grain, icons) keeps its name from build to build, so it is revalidated (assetCacheControl).
// When the client takes brotli (`br`, decided by the caller) and the build compressed the file ahead (<file>.br, at the
// highest quality, design §12.3), that copy goes out as it is: on a slow link the first load is bound by these bytes.
func Asset(w http.ResponseWriter, r *http.Request, br bool) {
	name := r.PathValue("file")
	contentType, known := hashedTypes[path.Ext(name)]
	if !known || name == "" || strings.ContainsAny(name, `/\`) || strings.HasPrefix(name, ".") {
		http.NotFound(w, r)
		return
	}
	h := w.Header()
	if packed, err := fs.ReadFile(dist, "web/assets/"+name+".br"); err == nil {
		h.Add("Vary", "Accept-Encoding")
		if br {
			h.Set("Content-Type", contentType)
			h.Set("Content-Encoding", "br")
			h.Set("Cache-Control", assetCacheControl(name))
			_, _ = w.Write(packed)
			return
		}
	}
	body, err := fs.ReadFile(dist, "web/assets/"+name)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	h.Set("Content-Type", contentType)
	h.Set("Cache-Control", assetCacheControl(name))
	_, _ = w.Write(body)
}
