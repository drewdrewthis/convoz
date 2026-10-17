package wire

import (
	"encoding/json"
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
	Starred        bool         `json:"starred"`
	Rank           float64      `json:"rank"`
	Older          bool         `json:"older"`

	StartedBy  *Person      `json:"started_by,omitempty"`
	LinkURL    *string      `json:"link_url,omitempty"`
	MutedUntil *int64       `json:"muted_until,omitempty"`
	Pinned     *[]Message   `json:"pinned,omitempty"`
	Paused     bool         `json:"paused,omitempty"`
	Pickup     string       `json:"pickup,omitempty"`
	PickedUpBy *Person      `json:"picked_up_by,omitempty"`
	Pending    []PendingAdd `json:"pending,omitempty"`
	DeletedAt  *int64       `json:"deleted_at,omitempty"`
	PurgesAt   *int64       `json:"purges_at,omitempty"`
}

// Message is one message of a page. The fields after CreatedAt are set only when they apply (a system line, a reply, an
// edited, deleted or agent-written message); see message.go.
type Message struct {
	ID        int64  `json:"id"`
	Author    Person `json:"author"`
	Body      string `json:"body"`
	Format    string `json:"format"`
	CreatedAt int64  `json:"created_at"`

	Kind         string   `json:"kind,omitempty"` // text, ask or system
	Ask          *AskView `json:"ask,omitempty"`  // the ask a message of kind ask carries
	ThreadRootID int64    `json:"thread_root_id,omitempty"`
	Broadcast    bool     `json:"broadcast,omitempty"`
	ReplyCount   int64    `json:"reply_count,omitempty"`
	LastReplyAt  int64    `json:"last_reply_at,omitempty"` // when the newest reply came, for a thread root
	EditedAt     int64    `json:"edited_at,omitempty"`
	AnswersAsk   int64    `json:"answers_ask_id,omitempty"` // the ask this message answers
	Deleted      bool     `json:"deleted,omitempty"`        // a tombstone: Body is empty
	Purged       bool     `json:"purged,omitempty"`
	System       *System  `json:"system,omitempty"`
	Text         string   `json:"text,omitempty"` // a system line's words, the plain-text projection
	SessionLabel string   `json:"session_label,omitempty"`
	Machine      string   `json:"machine,omitempty"`
	// App is the app of the message in full when it is at most AppInlineBytes, else an AppStub (GET /api/messages/:id/app has the full app).
	App json.RawMessage `json:"app,omitempty"`
	// ViaApp is set on a message the owner sent through an app of an agent (I-46).
	ViaApp *ViaApp `json:"via_app,omitempty"`
	// Uploads are the files the message carries; Text is then the plain-text form of the whole message (a voice note reads
	// "Voice note 0:20: <words>"), which `convoz read` prints.
	Uploads []Upload `json:"uploads,omitempty"`
}

// Upload is a file of a message. It is fetched from /api/files/<ID>.
type Upload struct {
	ID         string `json:"id"`
	Kind       string `json:"kind"` // audio, image or file
	Name       string `json:"name"`
	Size       int64  `json:"size"`
	Mime       string `json:"mime"`
	Inline     bool   `json:"inline"` // a safe image or audio type the browser may show in the page (I-44)
	Width      int64  `json:"width,omitempty"`
	Height     int64  `json:"height,omitempty"`
	DurationMS int64  `json:"duration_ms,omitempty"`
	// Waveform is up to 64 peaks, 0 to 255, of a voice note.
	Waveform []int `json:"waveform,omitempty"`
	// Transcript is set for a voice note while an engine works on it or when it has finished; with no engine it is absent.
	Transcript *Transcript `json:"transcript,omitempty"`
}

// Transcript is the words of a voice note: State is pending, done or failed; Text is set when done.
type Transcript struct {
	State string `json:"state"`
	Text  string `json:"text,omitempty"`
}

// PostRequest is POST /api/conversations/:id/messages. The author is never in it: the server takes it from the credential.
type PostRequest struct {
	ClientID   string          `json:"client_id"`
	Body       string          `json:"body"`
	Format     string          `json:"format,omitempty"`
	ThreadRoot int64           `json:"thread_root_id,omitempty"`
	Broadcast  bool            `json:"broadcast,omitempty"`
	UploadIDs  []string        `json:"upload_ids,omitempty"`
	App        json.RawMessage `json:"app,omitempty"`     // agents only
	ViaApp     *ViaAppRequest  `json:"via_app,omitempty"` // the owner only
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

// ReadRequest is POST /api/conversations/:id/read: the main list up to MainID, or one thread (RootID with ReplyID), or All.
type ReadRequest struct {
	MainID int64 `json:"main_id"`
	// RootID and ReplyID mark one thread read up to a reply (I-14). Both or neither.
	RootID  int64 `json:"root_id,omitempty"`
	ReplyID int64 `json:"reply_id,omitempty"`
	// All marks everything read: the main thread up to its newest message, and every thread up to now.
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
	MentionCount int64             `json:"mention_count"` // how many of the item's messages mention the agent
	Deliveries   int64             `json:"deliveries"`    // how many times a claim handed the item out; at 5 it leaves the queue (M2)
	Conversation InboxConversation `json:"conversation"`
	Message      Message           `json:"message"`
	// TranscriptState is the state of the voice note's transcript (pending, done, failed); absent for an item with no voice note (E-5).
	TranscriptState string `json:"transcript_state,omitempty"`
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
