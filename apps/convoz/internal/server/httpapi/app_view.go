package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/appschema"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

// appView is the app of a message as a page carries it: the app itself up to wire.AppInlineBytes, else a stub that names it
// (GET /api/messages/:id/app serves the full app, E-22).
func appView(raw []byte) json.RawMessage {
	if len(raw) == 0 {
		return nil
	}
	if len(raw) <= wire.AppInlineBytes {
		return raw
	}
	var head struct {
		V        int    `json:"v"`
		Type     string `json:"type"`
		Title    string `json:"title"`
		Fallback string `json:"fallback"`
	}
	_ = json.Unmarshal(raw, &head)
	stub, _ := json.Marshal(wire.AppStub{Stub: true, V: head.V, Type: head.Type, Title: head.Title, Fallback: head.Fallback, Bytes: len(raw)})
	return stub
}

// appRefused answers a refused app or result and reports whether err was one. Every refusal is a 400 that names the place
// inside the app, so an agent can fix it ("/props/colour").
func appRefused(w http.ResponseWriter, err error) bool {
	var issue *appschema.Issue
	if !errors.As(err, &issue) {
		return false
	}
	writeJSON(w, http.StatusBadRequest, wire.Error{Error: wire.ErrorDetail{Code: issue.Code, Message: issue.Message, Path: issue.Path, Field: "app"}})
	return true
}

// onAsk refuses what answers or acts on an ask: a picker, a form, a checklist in select mode (I-50). It returns the issue as an
// error, or nil.
func onAsk(a *appschema.App) error {
	if issue := a.OnAsk(); issue != nil {
		return issue
	}
	return nil
}
