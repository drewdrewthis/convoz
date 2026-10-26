package httpapi

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/conversation"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/message"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/upload"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

// Caps of the extension's answer (page-share.feature).
const (
	pageReadMax = 256 << 10 // the read, as JSON
	pageShotMax = 5 << 20   // the PNG, decoded
	// pageResultBody bounds the whole answer: a 5 MB PNG in base64 and the JSON around it.
	pageResultBody = pageShotMax*4/3 + 64<<10
)

const noSharedTab = "no shared tab"

// pageOff answers 404 when the owner named no extension: then page sharing does not exist on this server.
func (s *Server) pageOff(w http.ResponseWriter) bool {
	if s.Cfg.ExtensionOrigin == "" {
		writeErr(w, http.StatusNotFound, "not_found", "No such route.")
		return true
	}
	return false
}

// fromExtension refuses a call that is not from the owner's extension. The CSRF wall lets the app's own Origin write anywhere, and
// a GET has no wall at all, so the page routes check the caller themselves: only the panel shares, polls and answers.
// Chrome sends no Origin on an extension's GET to a host it has access to; it marks it Sec-Fetch-Site: none and Sec-Fetch-Mode: cors,
// which no page can send (the app's own fetch is same-origin, a link the owner opens is navigate, and a page cannot set Sec-Fetch-*).
func (s *Server) fromExtension(w http.ResponseWriter, r *http.Request) bool {
	origin := r.Header.Get("Origin")
	byExtension := origin == s.Cfg.ExtensionOrigin ||
		r.Method == http.MethodGet && origin == "" && r.Header.Get("Sec-Fetch-Site") == "none" && r.Header.Get("Sec-Fetch-Mode") == "cors"
	if !byExtension {
		writeErr(w, http.StatusForbidden, "forbidden", "Only the Convoz extension shares a tab.")
		return false
	}
	return true
}

// seesConversation answers 404 (a person) or 403 (an agent) unless conv exists and the caller sees it.
func (s *Server) seesConversation(w http.ResponseWriter, r *http.Request, c *call, conv int64) bool {
	ctx, d := r.Context(), s.reader()
	_, found, err := conversation.Get(ctx, d, conv)
	visible := false
	if err == nil && found {
		_, visible, err = canSee(ctx, d, c.p, conv)
	}
	if err != nil {
		s.internalError(w, r, err)
		return false
	}
	if !visible {
		notVisible(w, c)
	}
	return visible
}

// tabOrigin is the origin of a web page as the extension names it: http or https, a host, no path. "" when it is not one.
func tabOrigin(raw string) string {
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" || u.User != nil {
		return ""
	}
	if origin := u.Scheme + "://" + u.Host; origin == raw {
		return origin
	}
	return ""
}

// startPageShare is POST /api/page/shares: the owner's extension shares a tab with a conversation the owner sees. A conversation has
// one live share: a new one ends the old.
func (s *Server) startPageShare(w http.ResponseWriter, r *http.Request, c *call) {
	if s.pageOff(w) || !s.fromExtension(w, r) {
		return
	}
	var in wire.PageShareRequest
	if !decode(w, r, &in) {
		return
	}
	origin := tabOrigin(in.TabOrigin)
	if origin == "" {
		writeFieldErr(w, http.StatusBadRequest, "invalid_request", "tab_origin", "The tab's origin is an http or https origin, like https://example.com.")
		return
	}
	if !s.seesConversation(w, r, c, in.ConversationID) {
		return
	}
	share := s.pages.start(in.ConversationID, c.p.HumanID, origin, s.Clock.Now())
	writeJSON(w, http.StatusCreated, wire.PageShareResponse{Share: share})
}

// stopPageShare is DELETE /api/page/shares/:id: Stop in the panel, the panel closing, or the tab leaving its site.
func (s *Server) stopPageShare(w http.ResponseWriter, r *http.Request, c *call) {
	if s.pageOff(w) || !s.fromExtension(w, r) {
		return
	}
	if !s.pages.stop(r.PathValue("id"), c.p.HumanID) {
		writeErr(w, http.StatusNotFound, "not_found", "No such share.")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// nextPageRequest is GET /api/page/shares/:id/next?wait=N: the extension's long poll for the next request, up to N seconds
// (at most 25). 200 with the request, 204 when none came, 404 once the share ended. Each poll keeps the share live.
func (s *Server) nextPageRequest(w http.ResponseWriter, r *http.Request, c *call) {
	if s.pageOff(w) || !s.fromExtension(w, r) {
		return
	}
	wait := time.Duration(0)
	if v := r.URL.Query().Get("wait"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 0 {
			writeFieldErr(w, http.StatusBadRequest, "invalid_request", "wait", "wait is a number of seconds.")
			return
		}
		wait = min(time.Duration(n)*time.Second, pagePollMax)
	}
	id := r.PathValue("id")
	timer := time.NewTimer(wait)
	defer timer.Stop()
	for timedOut := false; ; {
		share, req, found := s.pages.poll(id, c.p.HumanID, s.Clock.Now())
		switch {
		case !found:
			writeErr(w, http.StatusNotFound, "not_found", "The share ended.")
			return
		case req != nil:
			writeJSON(w, http.StatusOK, wire.PageNextResponse{Request: wire.PageRequest{ID: req.id, Op: req.op}})
			return
		case timedOut:
			w.WriteHeader(http.StatusNoContent)
			return
		}
		select {
		case <-share.wake:
		case <-share.ended:
		case <-timer.C:
			timedOut = true
		case <-r.Context().Done():
			return
		}
	}
}

// answerPageRequest is POST /api/page/requests/:id/result: the extension's answer to the request its poll handed it. A read over
// 256 KB or a PNG over 5 MB is refused (413), and the agent is told so.
func (s *Server) answerPageRequest(w http.ResponseWriter, r *http.Request, c *call) {
	if s.pageOff(w) || !s.fromExtension(w, r) {
		return
	}
	id, owner := r.PathValue("id"), c.p.HumanID
	req := s.pages.request(id, owner)
	if req == nil {
		writeErr(w, http.StatusNotFound, "not_found", "No such request.")
		return
	}
	tooBig := func() {
		s.pages.answer(id, owner, pageOutcome{status: http.StatusRequestEntityTooLarge})
		writeErr(w, http.StatusRequestEntityTooLarge, "too_large", "A read has at most 256 KB and a screenshot at most 5 MB.")
	}
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, pageResultBody))
	var over *http.MaxBytesError
	if errors.As(err, &over) {
		tooBig()
		return
	}
	var in wire.PageResult
	if err != nil || json.Unmarshal(raw, &in) != nil {
		writeErr(w, http.StatusBadRequest, "invalid_request", "The answer is not valid JSON.")
		return
	}
	switch {
	case !in.OK:
	case req.op == wire.PageOpRead && in.Read != nil && in.Shot == nil:
		if b, _ := json.Marshal(in.Read); len(b) > pageReadMax {
			tooBig()
			return
		}
	case req.op == wire.PageOpShot && in.Shot != nil && in.Read == nil:
		if n := base64.StdEncoding.DecodedLen(len(in.Shot.PNGBase64)); n > pageShotMax+2 {
			tooBig()
			return
		}
		png, err := base64.StdEncoding.DecodeString(in.Shot.PNGBase64)
		if err != nil {
			writeFieldErr(w, http.StatusBadRequest, "invalid_request", "shot", "The screenshot is not base64.")
			return
		} else if len(png) > pageShotMax {
			tooBig()
			return
		}
	default:
		writeErr(w, http.StatusBadRequest, "invalid_request", "A "+req.op+" is answered with its "+req.op+".")
		return
	}
	if !s.pages.answer(id, owner, pageOutcome{result: in}) {
		writeErr(w, http.StatusNotFound, "not_found", "No such request.")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// listPageShares is GET /api/page/shares: the live shares of the conversations the agent is in.
func (s *Server) listPageShares(w http.ResponseWriter, r *http.Request, c *call) {
	if s.pageOff(w) {
		return
	}
	ctx, d := r.Context(), s.reader()
	var failed error
	shares := s.pages.list(s.Clock.Now(), func(conv int64) bool {
		_, ok, err := canSee(ctx, d, c.p, conv)
		if err != nil {
			failed = err
		}
		return ok
	})
	if failed != nil {
		s.internalError(w, r, failed)
		return
	}
	writeJSON(w, http.StatusOK, wire.PageSharesResponse{Shares: shares})
}

// askPage is POST /api/page/requests: an agent of the conversation reads the shared tab or takes a screenshot of it, and waits for
// the extension (up to 25 s). One request at a time per share, and one screenshot in 2 s. Each read and shot leaves a system line
// in the conversation; a shot also puts the image there. The page's words never become a message.
func (s *Server) askPage(w http.ResponseWriter, r *http.Request, c *call) {
	if s.pageOff(w) {
		return
	}
	var in wire.PageRequest
	if !decode(w, r, &in) {
		return
	}
	if in.Op != wire.PageOpRead && in.Op != wire.PageOpShot {
		writeFieldErr(w, http.StatusBadRequest, "invalid_request", "op", "The op is read or shot.")
		return
	}
	if !s.seesConversation(w, r, c, in.ConversationID) {
		return
	}
	req, refused := s.pages.ask(in.ConversationID, in.Op, s.Clock.Now())
	switch refused {
	case pageNoShare:
		writeErr(w, http.StatusConflict, wire.CodeNoSharedTab, noSharedTab)
		return
	case pageBusy:
		tooMany(w, time.Second, "The shared tab is busy with another request. Try again.")
		return
	case pageTooSoon:
		tooMany(w, pageShotEvery, "One screenshot every 2 seconds.")
		return
	}
	timer := time.NewTimer(s.pageWait)
	defer timer.Stop()
	var out pageOutcome
	select {
	case out = <-req.done:
	case <-req.share.ended:
		writeErr(w, http.StatusConflict, wire.CodeNoSharedTab, noSharedTab)
		return
	case <-timer.C:
		s.pages.drop(req)
		writeErr(w, http.StatusGatewayTimeout, "page_timeout", "The shared tab did not answer in time.")
		return
	case <-r.Context().Done():
		s.pages.drop(req)
		return
	}
	switch {
	case out.status == http.StatusRequestEntityTooLarge:
		writeErr(w, http.StatusBadGateway, "page_too_large", "The shared page is too big to send.")
	case !out.result.OK && out.result.Error == noSharedTab:
		writeErr(w, http.StatusConflict, wire.CodeNoSharedTab, noSharedTab)
	case !out.result.OK:
		writeErr(w, http.StatusBadGateway, "page_failed", "The shared tab could not be read: "+clipTo(out.result.Error, 200))
	default:
		s.auditPage(r.Context(), c, in, out.result)
		answer := wire.PageAnswer{Shot: out.result.Shot}
		if in.Op == wire.PageOpRead {
			read := *out.result.Read
			read.Kind, read.Note = "page-content", wire.PageNote // the server's own words, whatever the extension sent
			if read.Elements == nil {
				read.Elements = []wire.PageElement{}
			}
			answer = wire.PageAnswer{Read: &read}
		}
		writeJSON(w, http.StatusOK, answer)
	}
}

// auditPage writes the system line of a read or shot, with the screenshot as its image when the server keeps files. A failure is
// logged and never fails the agent's request: the extension has answered by then.
func (s *Server) auditPage(ctx context.Context, c *call, in wire.PageRequest, res wire.PageResult) {
	ctx = context.WithoutCancel(ctx)
	agent, now := c.p.Identity(), s.Clock.Now()
	line := message.SystemLine{T: "page.read", Identity: agent}
	var shot []string
	if in.Op == wire.PageOpShot {
		line.T = "page.shot"
		if id, err := s.storeShot(ctx, c, in.ConversationID, res.Shot.PNGBase64); err != nil {
			s.Log.Printf("page shot: the image is not kept: %v", err)
		} else if id != "" {
			shot = []string{id}
		}
	}
	err := s.Store.Writer.Tx(ctx, func(ctx context.Context, tx *pdb.Tx) error {
		d := tx.DBTX()
		lineID, _, err := sayLine(ctx, d, now, agent, in.ConversationID, line)
		if err != nil || shot == nil {
			return err
		}
		_, err = upload.Bind(ctx, d, now, upload.BindArgs{MessageID: lineID, ConversationID: in.ConversationID, Author: agent, PublicIDs: shot})
		return err
	})
	if err != nil {
		s.Log.Printf("page audit line: %v", err)
		return
	}
	s.Bus.Notify()
}

// storeShot keeps the screenshot as a finished image upload of the agent in the conversation and returns its public id; "" when
// this server keeps no files.
func (s *Server) storeShot(ctx context.Context, c *call, conv int64, b64 string) (string, error) {
	svc := files.Load()
	if svc == nil {
		return "", nil
	}
	png, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(png)
	var row upload.Row
	err = s.Store.Writer.Tx(ctx, func(ctx context.Context, tx *pdb.Tx) (err error) {
		row, err = svc.Create(ctx, tx.DBTX(), s.Clock.Now(), upload.NewRequest{
			Uploader: c.p.Identity(), Session: c.p.SessionID, Conversation: conv, Kind: upload.KindImage, Filename: "screenshot.png", Size: int64(len(png)), SHA256: sum[:],
		}, c.lease.MachineID)
		return err
	})
	if err != nil {
		return "", err
	}
	prog, err := svc.Receive(row, upload.Chunk{}, bytes.NewReader(png))
	if err == nil && prog.Finished == nil {
		err = errors.New("the screenshot did not finish")
	}
	if err == nil {
		err = s.persistUpload(ctx, row, prog)
	}
	if err != nil {
		s.abortUpload(ctx, svc, row)
		return "", err
	}
	svc.Forget(row.StorageName)
	return row.PublicID, nil
}
