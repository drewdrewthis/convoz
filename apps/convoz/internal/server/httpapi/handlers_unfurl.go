package httpapi

import (
	"context"
	"net/http"
	"sync"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/message"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/unfurl"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

// getUnfurl is GET /api/messages/:id/unfurl: the card of the first link of a message, for a person who can see the message
// (I-6). Who may see it is decided first, like for the message itself, so nobody can probe which links exist. An agent who can
// see the message is still refused: an agent gets the address and never the fetched page (invariant 24).
func (s *Server) getUnfurl(w http.ResponseWriter, r *http.Request, c *call) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	ctx, d := r.Context(), s.reader()
	m, found, err := message.GetAny(ctx, d, id)
	if err == nil && found {
		switch access, aerr := messagePorts(c.p).Conversations.Access(ctx, d, m.ConversationID); {
		case aerr != nil:
			err = aerr
		case access == message.Missing:
			found = false
		case access == message.Denied:
			err = message.ErrDenied
		}
	}
	if s.messageRefused(w, err) {
		return
	}
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	if !found || m.Deleted || m.Purged || m.Kind == "system" {
		writeErr(w, http.StatusNotFound, "not_found", "No such message.")
		return
	}
	if c.p.SessionID != 0 {
		writeErr(w, http.StatusForbidden, "agent_gets_link_only", "An agent gets the address of a link, not a preview of the page.")
		return
	}
	card, found, err := unfurl.Find(ctx, d, m.Body)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	if !found {
		writeErr(w, http.StatusNotFound, "not_found", "This message has no link preview.")
		return
	}
	writeJSON(w, http.StatusOK, wire.UnfurlCard{Status: card.Status, URL: card.URL, Kind: card.Kind, Site: card.Site,
		Title: card.Title, Description: card.Description, Meta: card.Meta})
}

const (
	unfurlEvery     = time.Second // how often the worker looks for addresses to fetch
	unfurlBatch     = 4           // addresses fetched at once
	unfurlFetchTime = 12 * time.Second
)

// unfurlFetchers keeps one fetcher per server, built on first use so the test build reads its fixtures when it first needs them.
var unfurlFetchers sync.Map

func (s *Server) fetcher() *unfurl.Fetcher {
	f, _ := unfurlFetchers.LoadOrStore(s, unfurl.NewFetcher())
	return f.(*unfurl.Fetcher)
}

// RunUnfurls is the preview worker, until ctx ends: it takes the addresses the post transaction queued, fetches them outside any
// transaction (the fetcher refuses private addresses), and records what each came to.
func (s *Server) RunUnfurls(ctx context.Context) {
	tick := time.NewTicker(unfurlEvery)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
			if err := s.unfurlDue(ctx); err != nil && ctx.Err() == nil {
				s.Log.Printf("unfurl: %v", err)
			}
		}
	}
}

func (s *Server) unfurlDue(ctx context.Context) error {
	jobs, err := unfurl.Due(ctx, s.reader(), s.Clock.Now(), unfurlBatch)
	if err != nil || len(jobs) == 0 {
		return err
	}
	var wg sync.WaitGroup
	errs := make([]error, len(jobs))
	for i, j := range jobs {
		wg.Add(1)
		go func() {
			defer wg.Done()
			fctx, cancel := context.WithTimeout(ctx, unfurlFetchTime)
			card, ferr := s.fetcher().Fetch(fctx, j.URL)
			cancel()
			if ctx.Err() != nil {
				return
			}
			errs[i] = s.Store.Writer.Tx(ctx, func(ctx context.Context, tx *pdb.Tx) error {
				return unfurl.Settle(ctx, tx.DBTX(), s.Clock.Now(), j, card, ferr)
			})
		}()
	}
	wg.Wait()
	for _, e := range errs {
		if e != nil {
			return e
		}
	}
	return nil
}
