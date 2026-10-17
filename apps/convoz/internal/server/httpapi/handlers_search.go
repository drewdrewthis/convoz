package httpapi

import (
	"net/http"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/conversation"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/message"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/search"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

// defaultSearchLimit is how many messages a search returns when the caller names no limit.
const defaultSearchLimit = 20

// search is GET /api/search?q=&limit=: the messages the caller may see (I-6) that hold the words and meet the filters,
// newest first, each with a snippet around its first match, and the conversations whose title the words name. A person and
// an agent get the same answer for what they may see. The text never reaches SQL as syntax: search turns it into quoted
// words, and the filters into integers and bound values.
func (s *Server) search(w http.ResponseWriter, r *http.Request, c *call) {
	text := r.URL.Query().Get("q")
	if len(text) > search.MaxQuery {
		writeFieldErr(w, http.StatusBadRequest, "invalid_request", "q", "A search has at most 200 characters.")
		return
	}
	limit, hasLimit, ok := intParam(w, r, "limit")
	if !ok {
		return
	}
	if !hasLimit {
		limit = defaultSearchLimit
	}
	q := search.Parse(text)
	out := wire.SearchResponse{Results: []wire.SearchResult{}, Conversations: []wire.SearchConversation{}, Filters: []wire.SearchFilter{}}
	for _, ch := range q.Chips {
		out.Filters = append(out.Filters, wire.SearchFilter{Token: ch.Token, Label: ch.Label})
	}
	if q.Empty() {
		writeJSON(w, http.StatusOK, out)
		return
	}
	ctx, d := r.Context(), s.reader()
	dir, err := loadDirectory(ctx, d)
	var sc search.Scope
	var seen []conversation.Conversation
	if err == nil {
		sc, seen, err = searchScope(ctx, d, c.p, dir)
	}
	var hits []search.Hit
	if err == nil {
		hits, err = search.Run(ctx, d, q, sc, int(limit))
	}
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	titles := make(map[int64]string, len(sc.Visible))
	for _, v := range sc.Visible {
		titles[v.ID] = v.Title
	}
	for _, h := range hits {
		m, found, err := message.GetAny(ctx, d, h.MessageID)
		if err != nil {
			s.internalError(w, r, err)
			return
		}
		if !found || m.Deleted {
			continue // the index drops a message in its delete; this only guards a read between two commits of another writer
		}
		res := wire.SearchResult{
			MessageID: m.ID, ConversationID: m.ConversationID, ConversationTitle: titles[m.ConversationID], Author: dir.person(m.AuthorID),
			CreatedAt: m.CreatedAt, ThreadRootID: m.ThreadRootID, App: m.HasApp, Snippet: snippetParts(plainText(ctx, d, m), q),
		}
		if m.Kind == "ask" {
			res.Kind = "ask"
		}
		out.Results = append(out.Results, res)
	}
	if found := search.Titles(q, sc); len(found) > 0 {
		starred := map[int64]bool{}
		if ids, err := sc.Starred(); err == nil {
			for _, id := range ids {
				starred[id] = true
			}
		}
		last := make(map[int64]int64, len(seen))
		for _, cv := range seen {
			last[cv.ID] = cv.LastMessageID
		}
		for _, v := range found[:min(len(found), int(max(limit, 1)))] {
			preview := ""
			if id := last[v.ID]; id > v.Floor {
				if m, ok, err := message.Get(ctx, d, id); err == nil && ok {
					preview = message.Preview(plainText(ctx, d, m))
				}
			}
			out.Conversations = append(out.Conversations, wire.SearchConversation{ID: v.ID, Title: v.Title, Starred: starred[v.ID], Preview: preview, Snippet: snippetParts(v.Title, q)})
		}
	}
	writeJSON(w, http.StatusOK, out)
}

func snippetParts(text string, q search.Query) []wire.SearchPart {
	parts := search.Snippet(text, q)
	out := make([]wire.SearchPart, len(parts))
	for i, p := range parts {
		out[i] = wire.SearchPart{Text: p.Text, Hit: p.Hit}
	}
	return out
}
