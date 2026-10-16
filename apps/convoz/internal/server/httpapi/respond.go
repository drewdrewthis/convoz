package httpapi

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

func writeJSON(w http.ResponseWriter, status int, v any) {
	h := w.Header()
	h.Set("Content-Type", "application/json")
	h.Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, wire.Error{Error: wire.ErrorDetail{Code: code, Message: message}})
}

// maxBody bounds every request body; the biggest real one is a WebAuthn credential of a few KB.
const maxBody = 1 << 20

// decode reads one JSON object into v and refuses unknown fields. An empty body counts as {}.
// It writes the 400 itself and reports false on failure.
func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxBody))
	dec.DisallowUnknownFields()
	err := dec.Decode(v)
	if err == nil {
		err = dec.Decode(&struct{}{}) // a second value is trailing junk
		if errors.Is(err, io.EOF) {
			return true
		}
		err = errors.New("trailing data")
	}
	if errors.Is(err, io.EOF) {
		return true
	}
	writeErr(w, http.StatusBadRequest, "invalid_request", "The request body is not valid.")
	return false
}

// muxPattern turns the table's ":name" segments into the standard mux's "{name}", and "/" into the exact root.
func muxPattern(p string) string {
	if p == "/" {
		return "/{$}" // exactly the root, not every path
	}
	parts := strings.Split(p, "/")
	for i, s := range parts {
		if strings.HasPrefix(s, ":") {
			parts[i] = "{" + s[1:] + "}"
		}
	}
	return strings.Join(parts, "/")
}
