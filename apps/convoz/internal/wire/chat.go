package wire

import (
	"strings"
	"unicode"
	"unicode/utf8"
)

// Routes of the chat API, as the CLI calls them.
const (
	RouteConversations = "/api/conversations" // + "/<id>/messages", "/<id>/read"
	RouteInbox         = "/api/inbox"
	RouteInboxClaim    = "/api/inbox/claim"
	RouteInboxAck      = "/api/inbox/ack"
)

// Person is who wrote a message or takes part in a conversation.
type Person struct {
	Handle      string `json:"handle"`
	DisplayName string `json:"display_name"`
	Kind        string `json:"kind"`
}

// LastMessage is the newest message of a conversation as the list shows it.
type LastMessage struct {
	ID           int64  `json:"id"`
	AuthorHandle string `json:"author_handle"`
	Preview      string `json:"preview"` // at most 140 runes, one line
}

// Conversation is one row of the list, and the body of the single-conversation routes.
type Conversation struct {
	ID             int64        `json:"id"`
	Title          *string      `json:"title"`
	CreatedAt      int64        `json:"created_at"`
	LastActivityAt int64        `json:"last_activity_at"`
	Participants   []Person     `json:"participants"`
	Last           *LastMessage `json:"last"`
	Unread         int64        `json:"unread"`
}

// Message is one message of a page.
type Message struct {
	ID        int64  `json:"id"`
	Author    Person `json:"author"`
	Body      string `json:"body"`
	Format    string `json:"format"`
	CreatedAt int64  `json:"created_at"`
}

// PostRequest is POST /api/conversations/:id/messages. The author is never in it: the server takes it from the credential.
type PostRequest struct {
	ClientID string `json:"client_id"`
	Body     string `json:"body"`
	Format   string `json:"format,omitempty"`
}

// PostResponse is the answer to a post: 201 for a new message, 200 with the same ids for a repeat.
type PostResponse struct {
	ID             int64 `json:"id"`
	ConversationID int64 `json:"conversation_id"`
	CreatedAt      int64 `json:"created_at"`
}

// MessagesResponse is GET /api/conversations/:id/messages, oldest first.
type MessagesResponse struct {
	Messages []Message `json:"messages"`
	AsOfSeq  int64     `json:"as_of_seq"`
}

// ReadRequest is POST /api/conversations/:id/read.
type ReadRequest struct {
	MainID int64 `json:"main_id"`
}

// InboxConversation names the conversation of an inbox item.
type InboxConversation struct {
	ID    int64   `json:"id"`
	Title *string `json:"title"`
}

// InboxItem is one inbox item with its newest message. ClaimToken is set only on an item the caller holds.
type InboxItem struct {
	ID           int64             `json:"id"`
	ClaimToken   string            `json:"claim_token,omitempty"`
	State        string            `json:"state"`
	Reason       string            `json:"reason"`
	Count        int64             `json:"count"`
	MentionCount int64             `json:"mention_count"` // how many of the item's messages mention the agent
	Conversation InboxConversation `json:"conversation"`
	Message      Message           `json:"message"`
}

// InboxResponse is GET /api/inbox.
type InboxResponse struct {
	Items []InboxItem `json:"items"`
}

// ClaimRequest is POST /api/inbox/claim: N ready items (1 to 20, default 20) of one conversation (Conv) or of all.
type ClaimRequest struct {
	N          int    `json:"n,omitempty"`
	Visibility string `json:"visibility,omitempty"` // a duration, 30s to 30m
	Conv       int64  `json:"conv,omitempty"`
}

// AckRef names one claimed item.
type AckRef struct {
	ID         int64  `json:"id"`
	ClaimToken string `json:"claim_token"`
}

// AckRequest is POST /api/inbox/ack.
type AckRequest struct {
	Items []AckRef `json:"items"`
}

// Ack results.
const (
	AckOK        = "ok"
	AckClaimLost = "claim_lost"
)

// AckResult is the answer for one item of an ack.
type AckResult struct {
	ID     int64  `json:"id"`
	Result string `json:"result"`
}

// AckResponse is the answer to POST /api/inbox/ack. When any claim was lost the status is 409 and the body also holds
// the error (code claim_lost), so the caller still reads which items were acked.
type AckResponse struct {
	Results []AckResult  `json:"results"`
	Error   *ErrorDetail `json:"error,omitempty"`
}

// WatchLine is what `convoz watch --json` prints for each item: one line of JSON.
type WatchLine struct {
	ItemID            int64   `json:"item_id"`
	ClaimToken        string  `json:"claim_token"`
	Reason            string  `json:"reason"`
	ConversationID    int64   `json:"conversation_id"`
	ConversationTitle *string `json:"conversation_title"`
	Count             int64   `json:"count"`
	MessageID         int64   `json:"message_id"`
	Author            string  `json:"author"`
	Body              string  `json:"body"`
	CreatedAt         string  `json:"created_at"`
}

// ValidClientID reports whether s is a well-formed client id: 8 to 64 characters, no space or control character.
// A client id keys the replay of a post or a session mint, so the server and the CLI judge it the same way.
func ValidClientID(s string) bool {
	n := utf8.RuneCountInString(s)
	return n >= 8 && n <= 64 && !strings.ContainsFunc(s, func(r rune) bool { return unicode.IsControl(r) || unicode.IsSpace(r) })
}
