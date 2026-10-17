package httpapi

import (
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"strconv"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/appschema"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/appkit"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/message"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/upload"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

// viaApp judges the result of an app a person sends (I-46). The app message must be in this conversation, not deleted and
// visible to the sender; the agent is the app message's author, never something the request says; the result must fit the app.
// It writes the refusal itself and reports whether the post may go on.
func (s *Server) viaApp(w http.ResponseWriter, r *http.Request, c *call, conv int64, in wire.ViaAppRequest) (appkit.Via, bool) {
	ctx, d := r.Context(), s.reader()
	target, found, err := message.Get(ctx, d, in.MessageID)
	var floor int64
	var visible bool
	if err == nil && found && target.ConversationID == conv {
		floor, visible, err = canSee(ctx, d, c.p, conv)
	}
	if err != nil {
		s.internalError(w, r, err)
		return appkit.Via{}, false
	}
	if !found || target.ConversationID != conv || !visible || target.ID <= floor {
		writeFieldErr(w, http.StatusNotFound, "not_found", "via_app", "No such app message.")
		return appkit.Via{}, false
	}
	via, err := appkit.PrepareVia(appkit.Target{ID: target.ID, Conversation: conv, Author: target.AuthorID, App: target.App}, in.Result)
	switch {
	case errors.Is(err, appkit.ErrNoApp):
		writeFieldErr(w, http.StatusBadRequest, wire.CodeAppResultDenied, "via_app", "That message has no app to send a result through.")
		return appkit.Via{}, false
	case appRefused(w, err):
		return appkit.Via{}, false
	case err != nil:
		s.internalError(w, r, err)
		return appkit.Via{}, false
	}
	return via, true
}

// readAll reads a whole body of at most max bytes. It reports false when the body is longer.
func readAll(w http.ResponseWriter, r *http.Request, max int64) ([]byte, bool, error) {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, max+1))
	var tooBig *http.MaxBytesError
	if errors.As(err, &tooBig) {
		return nil, false, nil
	}
	return body, err == nil, err
}

// validateApp is POST /api/apps/validate: the schema and the semantic checks of a post without the post. Nothing is written.
func (s *Server) validateApp(w http.ResponseWriter, r *http.Request, c *call) {
	body, ok, err := readAll(w, r, 4*appschema.MaxAppBytes)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	if !ok {
		writeJSON(w, http.StatusBadRequest, wire.Error{Error: wire.ErrorDetail{Code: wire.CodeAppTooLarge, Message: "must have at most 65536 bytes", Field: "app"}})
		return
	}
	// A dry run judges the shape only; the files an app names are checked when it is posted.
	checked, issue := appschema.Check(body)
	if issue != nil {
		appRefused(w, issue)
		return
	}
	writeJSON(w, http.StatusOK, wire.AppChecked{OK: true, Type: checked.Type, Bytes: len(checked.Canonical())})
}

// appOf reads the app of a message the caller may see; it writes the refusal itself.
func (s *Server) appOf(w http.ResponseWriter, r *http.Request, c *call, id int64) (message.Message, bool) {
	ctx, d := r.Context(), s.reader()
	m, found, err := message.Get(ctx, d, id)
	var floor int64
	var visible bool
	if err == nil && found {
		floor, visible, err = canSee(ctx, d, c.p, m.ConversationID)
	}
	if err != nil {
		s.internalError(w, r, err)
		return message.Message{}, false
	}
	if !found || !visible || m.ID <= floor || len(m.App) == 0 {
		writeErr(w, http.StatusNotFound, "not_found", "No such app.")
		return message.Message{}, false
	}
	return m, true
}

// getMessageApp is GET /api/messages/:id/app: the full app of a message (the page carries a stub for a big one).
func (s *Server) getMessageApp(w http.ResponseWriter, r *http.Request, c *call) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	if m, ok := s.appOf(w, r, c, id); ok {
		writeJSON(w, http.StatusOK, wire.OneApp{App: m.App})
	}
}

// getAppFrame is GET /api/apps/:message_id/frame?h=: the Tier-2 bundle of an app message, only to the owner's browser, only as
// an iframe, only with the hash the app names (I-46). Its CSP makes the document sandboxed and offline.
func (s *Server) getAppFrame(w http.ResponseWriter, r *http.Request, c *call) {
	id, err := strconv.ParseInt(r.PathValue("message_id"), 10, 64)
	if err != nil || id <= 0 {
		writeErr(w, http.StatusNotFound, "not_found", "No such app.")
		return
	}
	if r.Header.Get("Sec-Fetch-Dest") != "iframe" {
		writeErr(w, http.StatusBadRequest, "invalid_request", "An app frame opens only as a frame.")
		return
	}
	m, ok := s.appOf(w, r, c, id)
	if !ok {
		return
	}
	hash := r.URL.Query().Get("h")
	bundleID, named := appkit.FrameBundleID(m.App, hash)
	svc := s.uploadService(w)
	if svc == nil {
		return
	}
	row, found, err := upload.ByPublicID(r.Context(), s.reader(), bundleID)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	// Only the bundle this message carries, and only if its bytes are the ones the app names.
	if !named || !found || row.Kind != upload.KindApp || row.MessageID != m.ID || !row.Complete() || hex.EncodeToString(row.SHA256) != hash {
		writeErr(w, http.StatusNotFound, "not_found", "No such app.")
		return
	}
	rd, err := svc.Blobs.Open(row)
	if err == nil {
		err = rd.Verify()
	}
	if err != nil {
		if rd != nil {
			rd.Close()
		}
		s.internalError(w, r, err)
		return
	}
	defer rd.Close()
	for k, v := range appkit.FrameHeaders {
		w.Header().Set(k, v)
	}
	w.WriteHeader(http.StatusOK)
	_, _ = io.Copy(w, rd)
}
