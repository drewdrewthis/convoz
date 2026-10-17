package wire

// RouteSearch is GET /api/search?q=<text>&limit=<n>: the messages of the text newest first, and the conversations whose title
// it names. The text holds words and the filters from:@handle, in:"title", is:ask, is:pinned, is:starred, is:app, has:file
// and has:link.
const RouteSearch = "/api/search"

// SearchPart is a run of a snippet; Hit marks a word the query matched.
type SearchPart struct {
	Text string `json:"text"`
	Hit  bool   `json:"hit,omitempty"`
}

// SearchResult is one found message.
type SearchResult struct {
	MessageID         int64        `json:"message_id"`
	ConversationID    int64        `json:"conversation_id"`
	ConversationTitle string       `json:"conversation_title"` // empty for a conversation with no title yet
	Author            Person       `json:"author"`
	CreatedAt         int64        `json:"created_at"`
	Kind              string       `json:"kind,omitempty"` // "ask" for an ask; absent for text
	App               bool         `json:"app,omitempty"`
	ThreadRootID      int64        `json:"thread_root_id,omitempty"`
	Snippet           []SearchPart `json:"snippet"`
}

// SearchConversation is a conversation whose title the query names.
type SearchConversation struct {
	ID      int64        `json:"id"`
	Title   string       `json:"title"`
	Starred bool         `json:"starred,omitempty"`
	Preview string       `json:"preview"` // the newest message as the list shows it (140 runes), empty for none
	Snippet []SearchPart `json:"snippet"` // the title with the matched words marked
}

// SearchFilter is one filter of the query, as the "Active filters" row shows it. Token is the text to take out of the query
// to remove the filter.
type SearchFilter struct {
	Token string `json:"token"`
	Label string `json:"label"`
}

// SearchResponse is the answer of GET /api/search.
type SearchResponse struct {
	Results       []SearchResult       `json:"results"`
	Conversations []SearchConversation `json:"conversations"`
	Filters       []SearchFilter       `json:"filters"`
}
