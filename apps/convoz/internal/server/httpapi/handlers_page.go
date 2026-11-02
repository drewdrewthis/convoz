package httpapi

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/conversation"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/identity"
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

// tabNotInFront is the extension's answer to a screenshot of a shared tab the owner has behind another tab.
const tabNotInFront = "tab not in front"

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

// tabAddress is the shared tab's address as the extension masked it, when it is on origin; origin itself when the extension sent
// none. ok is false for an address on another site or with a user name.
func tabAddress(raw, origin string) (address string, ok bool) {
	if raw == "" {
		return origin, true
	}
	u, err := url.Parse(raw)
	if err != nil || len(raw) > 2048 || u.User != nil || u.Scheme+"://"+u.Host != origin {
		return "", false
	}
	return raw, true
}

// startPageShare is POST /api/page/shares: the owner's extension shares a tab with a conversation the owner sees, and posts the
// owner's ask about it (share and ask in one step). A conversation has one live share: a new one ends the old.
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
	address, ok := tabAddress(in.TabURL, origin)
	if !ok {
		writeFieldErr(w, http.StatusBadRequest, "invalid_request", "tab_url", "The tab's address is on tab_origin and has no user name.")
		return
	}
	if !s.seesConversation(w, r, c, in.ConversationID) {
		return
	}
	share := s.pages.start(in.ConversationID, c.p.HumanID, c.p.Identity(), origin, s.Clock.Now())
	// after the start: the message makes the web app read the conversation again, and its shared_tab must be there by then
	if !s.postShareAsk(w, r, c, share, shareAsk(in.Ask, in.TabTitle, address, in.ConversationID)) {
		s.pages.stop(share.ID, c.p.HumanID) // no ask, no share: the owner sees the error and shares again
		return
	}
	writeJSON(w, http.StatusCreated, wire.PageShareResponse{Share: share})
}

// postShareAsk posts the owner's message that starts a share, as a normal message: it reaches the inbox of every agent of the
// conversation, which a system line never does. It writes the error itself and reports whether the message was posted.
func (s *Server) postShareAsk(w http.ResponseWriter, r *http.Request, c *call, share wire.PageShare, body string) bool {
	draft := message.Draft{Conversation: share.ConversationID, Author: c.p.Identity(), Device: c.dev.ID, ClientID: "page-share-" + share.ID, Body: body}
	var posted message.Posted
	err := s.Store.Writer.Tx(r.Context(), func(ctx context.Context, tx *pdb.Tx) (err error) {
		posted, err = message.Post(ctx, tx.DBTX(), triagePorts(c.p), s.Clock.Now(), draft)
		return err
	})
	if s.messageRefused(w, err) {
		return false
	}
	if err != nil {
		s.internalError(w, r, err)
		return false
	}
	s.Bus.Notify(posted.Wake...)
	return true
}

// shareAsk is the body of the message that starts a share: the owner's words (or "Look at this tab."), the tab, and the commands an
// agent runs to see it. The title and address are the page's words, so they go in code, where they mention no one.
func shareAsk(ask, title, address string, conv int64) string {
	ask = strings.TrimSpace(ask)
	if ask == "" {
		ask = "Look at this tab."
	}
	tab := "`" + inCode(address) + "`"
	if t := pageTitle(title); t != "" {
		tab = "`" + inCode(t) + "` " + tab
	}
	return fmt.Sprintf("%s\n\n- Shared tab: %s\n- Read it: `convoz page read --conv %d`\n- Screenshot: `convoz page shot --conv %d`", ask, tab, conv, conv)
}

// inCode keeps text inside one code span: a backtick would end it.
func inCode(s string) string { return strings.ReplaceAll(s, "`", "'") }

// pageTitle is a page's title as a line or a message quotes it: one line, no control characters, at most 120 characters.
func pageTitle(raw string) string {
	t := strings.Join(strings.Fields(strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return ' '
		}
		return r
	}, raw)), " ")
	if utf8.RuneCountInString(t) > 120 {
		t = strings.TrimSpace(string([]rune(t)[:120]))
	}
	return t
}

// hostOf is the host of an origin tabOrigin accepted.
func hostOf(origin string) string {
	u, _ := url.Parse(origin)
	return u.Host
}

// pageEndLines are the lines of the reasons DELETE takes; "" is the owner's Stop.
var pageEndLines = map[string]string{"": "page.stopped", wire.PageEndStopped: "page.stopped", wire.PageEndLeft: "page.left", wire.PageEndClosed: "page.closed"}

// stopPageShare is DELETE /api/page/shares/:id {reason}: Stop in the panel (stopped, or no body), the tab closing, going behind
// another tab or leaving its site (left), or the panel closing (closed). The conversation says which.
func (s *Server) stopPageShare(w http.ResponseWriter, r *http.Request, c *call) {
	if s.pageOff(w) || !s.fromExtension(w, r) {
		return
	}
	var in wire.PageEndRequest
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<10))
	if err == nil && len(bytes.TrimSpace(raw)) > 0 {
		err = json.Unmarshal(raw, &in)
	}
	t, known := pageEndLines[in.Reason]
	if err != nil || !known {
		writeFieldErr(w, http.StatusBadRequest, "invalid_request", "reason", "The reason is stopped, left or closed.")
		return
	}
	conv, found := s.pages.stop(r.PathValue("id"), c.p.HumanID)
	if !found {
		writeErr(w, http.StatusNotFound, "not_found", "No such share.")
		return
	}
	line := message.SystemLine{T: t}
	if t == "page.stopped" {
		line.Identity = c.p.Identity()
	}
	s.sayPage(r.Context(), c.p.Identity(), conv, line)
	w.WriteHeader(http.StatusNoContent)
}

// sayPage writes a line of a share in its conversation. A failure is logged and never fails the call: the share has started or
// ended by then.
func (s *Server) sayPage(ctx context.Context, actor, conv int64, line message.SystemLine) {
	err := s.Store.Writer.Tx(context.WithoutCancel(ctx), func(ctx context.Context, tx *pdb.Tx) error {
		_, _, err := sayLine(ctx, tx.DBTX(), s.Clock.Now(), actor, conv, line)
		return err
	})
	if err != nil {
		s.Log.Printf("page share line: %v", err)
		return
	}
	s.Bus.Notify()
}

// sayTimedOut says in their conversations that the shares the heartbeat ended have ended.
func (s *Server) sayTimedOut(ctx context.Context) {
	for _, share := range s.pages.drainTimedOut() {
		s.sayPage(ctx, share.by, share.conv, message.SystemLine{T: "page.timeout"})
	}
}

// withSharedTab marks the conversations that have a live share with the host of its tab, so the web app shows it under the title.
func (s *Server) withSharedTab(views ...*wire.Conversation) {
	now := s.Clock.Now()
	for _, v := range views {
		if origin := s.pages.sharedOrigin(v.ID, now); origin != "" {
			v.SharedTab = &wire.SharedTab{Host: hostOf(origin)}
		}
	}
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
			s.sayTimedOut(r.Context())
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
	s.sayTimedOut(ctx)
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
	s.sayTimedOut(r.Context())
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
	case !out.result.OK && out.result.Error == tabNotInFront:
		writeErr(w, http.StatusConflict, wire.CodeTabNotInFront, "The shared tab is not in front. Ask "+s.ownerRef(r.Context(), req.share.by)+" to bring it forward.")
	case !out.result.OK:
		writeErr(w, http.StatusBadGateway, "page_failed", "The shared tab could not be read: "+clipTo(out.result.Error, 200))
	default:
		answer := wire.PageAnswer{Shot: out.result.Shot}
		if in.Op == wire.PageOpRead {
			read := *out.result.Read
			read.Kind, read.Note = "page-content", wire.PageNote // the server's own words, whatever the extension sent
			if read.Elements == nil {
				read.Elements = []wire.PageElement{}
			}
			answer = wire.PageAnswer{Read: &read}
		}
		s.auditPage(r.Context(), c, in, answer)
		writeJSON(w, http.StatusOK, answer)
	}
}

// ownerRef is "@handle" of the person who shares the tab, or "the owner" when it cannot be read.
func (s *Server) ownerRef(ctx context.Context, id int64) string {
	if h, err := identity.Get(ctx, s.reader(), id); err == nil && h.Handle != "" {
		return "@" + h.Handle
	}
	return "the owner"
}

// auditPage writes the system line of a read or shot, with what the agent got as its file when the server keeps files: the
// screenshot as an image, the read as page-read.json (and its title and word count on the line), so the owner sees what the agent
// saw. A failure is logged and never fails the agent's request: the extension has answered by then.
func (s *Server) auditPage(ctx context.Context, c *call, in wire.PageRequest, answer wire.PageAnswer) {
	ctx = context.WithoutCancel(ctx)
	agent, now := c.p.Identity(), s.Clock.Now()
	line := message.SystemLine{T: "page.read", Identity: agent}
	kind, name := upload.KindFile, "page-read.json"
	var data []byte
	var err error
	if in.Op == wire.PageOpShot {
		line.T, kind, name = "page.shot", upload.KindImage, "screenshot.png"
		data, err = base64.StdEncoding.DecodeString(answer.Shot.PNGBase64)
	} else {
		line.Title, line.Words = pageTitle(answer.Read.Title), len(strings.Fields(answer.Read.Text))
		data, err = json.Marshal(answer.Read)
	}
	var kept []string
	if err == nil {
		var id string
		if id, err = s.storeFile(ctx, c, in.ConversationID, kind, name, data); id != "" {
			kept = []string{id}
		}
	}
	if err != nil {
		s.Log.Printf("page %s: the file is not kept: %v", in.Op, err)
	}
	err = s.Store.Writer.Tx(ctx, func(ctx context.Context, tx *pdb.Tx) error {
		d := tx.DBTX()
		lineID, _, err := sayLine(ctx, d, now, agent, in.ConversationID, line)
		if err != nil || kept == nil {
			return err
		}
		_, err = upload.Bind(ctx, d, now, upload.BindArgs{MessageID: lineID, ConversationID: in.ConversationID, Author: agent, PublicIDs: kept})
		return err
	})
	if err != nil {
		s.Log.Printf("page audit line: %v", err)
		return
	}
	s.Bus.Notify()
}

// storeFile keeps data as a finished upload of the agent in the conversation and returns its public id; "" when this server keeps
// no files.
func (s *Server) storeFile(ctx context.Context, c *call, conv int64, kind, name string, data []byte) (string, error) {
	svc := files.Load()
	if svc == nil {
		return "", nil
	}
	sum := sha256.Sum256(data)
	var row upload.Row
	err := s.Store.Writer.Tx(ctx, func(ctx context.Context, tx *pdb.Tx) (err error) {
		row, err = svc.Create(ctx, tx.DBTX(), s.Clock.Now(), upload.NewRequest{
			Uploader: c.p.Identity(), Session: c.p.SessionID, Conversation: conv, Kind: kind, Filename: name, Size: int64(len(data)), SHA256: sum[:],
		}, c.lease.MachineID)
		return err
	})
	if err != nil {
		return "", err
	}
	prog, err := svc.Receive(row, upload.Chunk{}, bytes.NewReader(data))
	if err == nil && prog.Finished == nil {
		err = errors.New("the file did not finish")
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
