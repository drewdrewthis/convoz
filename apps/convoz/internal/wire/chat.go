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
	RouteInboxAck      = "/api/inbox/ack"
)

// Person is who wrote a message or takes part in a conversation. A system line has the kind "system" and no handle.
type Person struct {
	ID          int64  `json:"id,omitempty"`
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

// Pickup states of a conversation (SEC-6).
const (
	PickupClosed = "closed" // nobody opened it for pickup
	PickupOpen   = "open"   // opened, and no agent holds it
	PickupTaken  = "taken"  // an agent holds it
)

// PendingAdd is an agent that waits to be added until a human approves, and the agent that asked.
type PendingAdd struct {
	Person      Person  `json:"person"`
	RequestedBy *Person `json:"requested_by,omitempty"`
	At          int64   `json:"at"`
}

// Conversation is one row of the list, and the body of the single-conversation routes. The fields after Unread are
// the details: the list sends the cheap ones (paused, pickup, deleted_at) and the single-conversation route all of them.
type Conversation struct {
	ID             int64        `json:"id"`
	Title          *string      `json:"title"`
	CreatedAt      int64        `json:"created_at"`
	LastActivityAt int64        `json:"last_activity_at"`
	Participants   []Person     `json:"participants"`
	Last           *LastMessage `json:"last"`
	Unread         int64        `json:"unread"`

	StartedBy  *Person      `json:"started_by,omitempty"`
	LinkURL    *string      `json:"link_url,omitempty"`
	MutedUntil *int64       `json:"muted_until,omitempty"`
	Paused     bool         `json:"paused,omitempty"`
	Pickup     string       `json:"pickup,omitempty"`
	PickedUpBy *Person      `json:"picked_up_by,omitempty"`
	Pending    []PendingAdd `json:"pending,omitempty"`
	DeletedAt  *int64       `json:"deleted_at,omitempty"`
	PurgesAt   *int64       `json:"purges_at,omitempty"`
}

// Origin says which agent session wrote a message and where it ran. Only a person sees it.
type Origin struct {
	Session string `json:"session"`
	Machine string `json:"machine"`
}

// Message is one message of a page.
type Message struct {
	ID        int64  `json:"id"`
	Author    Person `json:"author"`
	Body      string `json:"body"`
	Format    string `json:"format"`
	CreatedAt int64  `json:"created_at"`
	// Via is set on an agent's message when the reader is a person: its session label and machine.
	Via *Origin `json:"via,omitempty"`
	// Kind is "ask" for an agent's question; a plain message leaves it out.
	Kind string `json:"kind,omitempty"`
	// Ask is where an ask stands (open, answered, dismissed or closed), for a message of kind ask.
	Ask *AskState `json:"ask,omitempty"`
}

// AskState is the state of the ask a message carries.
type AskState struct {
	State string `json:"state"`
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
	// All marks everything read: the main thread up to its newest message.
	All bool `json:"all,omitempty"`
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
	Conversation InboxConversation `json:"conversation"`
	Message      Message           `json:"message"`
}

// InboxResponse is GET /api/inbox.
type InboxResponse struct {
	Items []InboxItem `json:"items"`
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

// AckResponse is the answer to POST /api/inbox/ack.
type AckResponse struct {
	Results []AckResult `json:"results"`
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
