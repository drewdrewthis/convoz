package httpapi

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strconv"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/appschema"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/appkit"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/auth"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/message"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
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
	content, found, err := appkit.FrameBundle(r.Context(), s.reader(), m.App, r.URL.Query().Get("h"))
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	if !found {
		writeErr(w, http.StatusNotFound, "not_found", "No such app.")
		return
	}
	for k, v := range appkit.FrameHeaders {
		w.Header().Set(k, v)
	}
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(content)
}

// putAppBundle is POST /api/apps/bundles?kind=app|image: an agent keeps a file its next app will name. The upload module's
// uploads replace it.
func (s *Server) putAppBundle(w http.ResponseWriter, r *http.Request, c *call) {
	if c.p.SessionID == 0 || c.lease.Scopes&auth.ScopePost == 0 {
		writeErr(w, http.StatusForbidden, "forbidden", "Only an agent that may post sends an app file.")
		return
	}
	image := r.URL.Query().Get("kind") == appkit.KindImage
	limit := int64(appschema.MaxBundleBytes)
	if image {
		limit = appkit.MaxImageBytes
	}
	body, ok, err := readAll(w, r, limit)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	if !ok {
		writeErr(w, http.StatusRequestEntityTooLarge, wire.CodeAppTooLarge, "That file is too large.")
		return
	}
	var asset appkit.Asset
	var issue *appschema.Issue
	err = s.Store.Writer.Tx(r.Context(), func(ctx context.Context, tx *pdb.Tx) (err error) {
		if image {
			asset, issue, err = appkit.PutImage(ctx, tx.DBTX(), s.Clock.Now(), c.p.Identity(), body)
		} else {
			asset, issue, err = appkit.PutBundle(ctx, tx.DBTX(), s.Clock.Now(), c.p.Identity(), body)
		}
		return err
	})
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	if issue != nil {
		status := http.StatusBadRequest
		if issue.Code == wire.CodeAppTooLarge {
			status = http.StatusRequestEntityTooLarge
		}
		writeErr(w, status, issue.Code, issue.Message)
		return
	}
	writeJSON(w, http.StatusCreated, wire.AppBundle{Upload: asset.ID, SHA256: asset.SHA256, Size: int(asset.Size)})
}

// getAppFile is GET /api/files/:public_id for the files apps point at. The owner reads any; an agent reads its own. Always
// nosniff and sandboxed, like every file (I-44).
func (s *Server) getAppFile(w http.ResponseWriter, r *http.Request, c *call) {
	a, found, err := appkit.GetAsset(r.Context(), s.reader(), r.PathValue("public_id"))
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	if !found || a.Kind != appkit.KindImage || (c.p.SessionID != 0 && a.Uploader != c.p.Identity()) {
		writeErr(w, http.StatusNotFound, "not_found", "No such file.")
		return
	}
	h := w.Header()
	h.Set("Content-Type", a.Mime)
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Content-Security-Policy", "sandbox; default-src 'none'")
	h.Set("Cache-Control", "private, max-age=31536000, immutable")
	_, _ = w.Write(a.Content)
}
