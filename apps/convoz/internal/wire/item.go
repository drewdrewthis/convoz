package wire

import "encoding/json"

// RouteFeed is GET /api/feed: the owner's feed items.
const RouteFeed = "/api/feed"

// ItemRequest is POST /api/conversations/:id/items/:key/:event, the agent's one call per transition (start, block, done, fyi, drop, say).
// Title, Context and Recommend are plain text. Outcome carries the note of done, fyi and say.
type ItemRequest struct {
	Title     string `json:"title,omitempty"`
	Context   string `json:"context,omitempty"`
	Recommend string `json:"recommend,omitempty"`
	Outcome   string `json:"outcome,omitempty"`
	// App is an app.v1 document (appkit) shown with the item: it rides on the item's message. Start and block only, on a new item.
	App json.RawMessage `json:"app,omitempty"`
	// Due is a duration (2d), a time HH:MM or a date YYYY-MM-DD HH:MM in the agent's zone (UTCOffset seconds east); display only.
	Due       string `json:"due,omitempty"`
	UTCOffset int    `json:"utc_offset,omitempty"`
}

// FeedItem is one feed item as the owner and the agent read it.
type FeedItem struct {
	ID             int64  `json:"id"`
	ConversationID int64  `json:"conversation_id"`
	AgentID        int64  `json:"agent_id"`
	Handle         string `json:"handle,omitempty"`
	Key            string `json:"key"`
	Seq            int64  `json:"seq"`
	State          string `json:"state"`
	Title          string `json:"title"`
	Context        string `json:"context,omitempty"`
	Recommendation string `json:"recommendation,omitempty"`
	// ThreadRootID is the message the item's thread hangs on; 0 until someone writes in the thread.
	ThreadRootID int64 `json:"thread_root_id,omitempty"`
	// CanAccept is false for a blocking item with no recommendation: Add info only.
	CanAccept    bool   `json:"can_accept"`
	DueAt        int64  `json:"due_at,omitempty"`
	AckedAt      int64  `json:"acked_at,omitempty"`
	AckKind      string `json:"ack_kind,omitempty"`
	SnoozedUntil int64  `json:"snoozed_until,omitempty"`
	Version      int64  `json:"version"`
	UpdatedAt    int64  `json:"updated_at"`
}

// FeedResponse is GET /api/feed: open items in plan order per (conversation, agent), and the last finished ones.
type FeedResponse struct {
	Items []FeedItem `json:"items"`
	Done  []FeedItem `json:"done"`
}

// FeedAcceptRequest is POST /api/feed/:id/accept; IfVersion is the version the owner saw.
type FeedAcceptRequest struct {
	IfVersion int64 `json:"if_version"`
}

// FeedAnswerRequest is POST /api/feed/:id/answer (Add info). Resolves says "this answers it": the item is done.
type FeedAnswerRequest struct {
	Text     string `json:"text"`
	Resolves bool   `json:"resolves,omitempty"`
}

// FeedReplyRequest is POST /api/feed/:id/reply: the owner writes in the item's thread.
type FeedReplyRequest struct {
	Text string `json:"text"`
}

// FeedSnoozeRequest is PUT /api/feed/:id/snooze.
type FeedSnoozeRequest struct {
	Until int64 `json:"until"`
}
