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
	RouteAgents        = "/api/agents"
	RouteInboxClaim    = "/api/inbox/claim"
	RouteInboxAck      = "/api/inbox/ack"
	RouteMessages      = "/api/messages" // + "/<id>": PATCH edits the text
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

// PendingAdd is an agent that waits to be added until a human approves, and the agent that asked.
type PendingAdd struct {
	Person      Person  `json:"person"`
	RequestedBy *Person `json:"requested_by,omitempty"`
	At          int64   `json:"at"`
}

// Conversation is one row of the list, and the body of the single-conversation routes. The fields after Unread are
// the details: the list sends the cheap ones (paused, deleted_at) and the single-conversation route all of them.
type Conversation struct {
	ID             int64        `json:"id"`
	Title          *string      `json:"title"`
	CreatedAt      int64        `json:"created_at"`
	LastActivityAt int64        `json:"last_activity_at"`
	Participants   []Person     `json:"participants"`
	Last           *LastMessage `json:"last"`
	Unread         int64        `json:"unread"`
	MainUnread     int64        `json:"main_unread"`       // the part of Unread that sits in the main list; the rest is thread replies
	Threads        []ThreadRow  `json:"threads,omitempty"` // the threads with a reply, newest reply first
	Starred        bool         `json:"starred"`
	Rank           float64      `json:"rank"`
	OwnerLast      bool         `json:"owner_last,omitempty"` // the owner wrote the newest message of the main list: it never goes Older (#42)

	StartedBy   *Person      `json:"started_by,omitempty"`
	LinkURL     *string      `json:"link_url,omitempty"`
	MutedUntil  *int64       `json:"muted_until,omitempty"`
	Pinned      *[]Message   `json:"pinned,omitempty"`
	Paused      bool         `json:"paused,omitempty"`
	Stale       bool         `json:"stale,omitempty"`        // an agent marked it stale and no message came since: the rail folds it into Older
	StaleReason string       `json:"stale_reason,omitempty"` // why, when the agent said so (only while Stale)
	Pending     []PendingAdd `json:"pending,omitempty"`
	Seen        []Seen       `json:"seen,omitempty"`      // agents that saw the newest message a person wrote in the main list
	LastRead    *int64       `json:"last_read,omitempty"` // the caller's read cursor in the main list, as it stands now
	DeletedAt   *int64       `json:"deleted_at,omitempty"`
	PurgesAt    *int64       `json:"purges_at,omitempty"`
}

// Message is one message of a page. The fields after CreatedAt are set only when they apply (a system line, a reply, an
// edited, deleted or agent-written message); see message.go.
type Message struct {
	ID        int64  `json:"id"`
	Author    Person `json:"author"`
	Body      string `json:"body"`
	Format    string `json:"format"`
	CreatedAt int64  `json:"created_at"`

	Kind          string     `json:"kind,omitempty"` // text, ask or system
	Ask           *AskView   `json:"ask,omitempty"`  // the ask a message of kind ask carries
	ThreadRootID  int64      `json:"thread_root_id,omitempty"`
	Broadcast     bool       `json:"broadcast,omitempty"`
	ReplyCount    int64      `json:"reply_count,omitempty"`
	UnreadReplies int64      `json:"unread_replies,omitempty"` // for a thread root: the replies the reader has not read, 0 when it is not in the thread
	LastReplyAt   int64      `json:"last_reply_at,omitempty"`  // when the newest reply came, for a thread root
	LastReply     *LastReply `json:"last_reply,omitempty"`     // the newest reply itself, for a thread root: the peek under its reply chip
	EditedAt      int64      `json:"edited_at,omitempty"`
	AnswersAsk    int64      `json:"answers_ask_id,omitempty"` // the ask this message answers
	Deleted       bool       `json:"deleted,omitempty"`        // a tombstone: Body is empty
	Purged        bool       `json:"purged,omitempty"`
	System        *System    `json:"system,omitempty"`
	Text          string     `json:"text,omitempty"` // a system line's words, the plain-text projection
	SessionLabel  string     `json:"session_label,omitempty"`
	Machine       string     `json:"machine,omitempty"`
	// App is the app of the message in full when it is at most AppInlineBytes, else an AppStub (GET /api/messages/:id/app has the full app).
	App json.RawMessage `json:"app,omitempty"`
	// ViaApp is set on a message the owner sent through an app of an agent (I-46).
	ViaApp *ViaApp `json:"via_app,omitempty"`
	// ViaVoice is set on a message the owner's voice call posted: readers see "via voice call".
	ViaVoice bool `json:"via_voice,omitempty"`
	// NeedsYou is true while the message is an ask that waits for the owner. It is computed when the message is read, never stored,
	// and it is on every message so a reader can split news from a request that blocks.
	NeedsYou bool `json:"needs_you"`
	// Uploads are the files the message carries; Text is then the plain-text form of the whole message (a voice note reads
	// "Voice note 0:20: <words>"), which `convoz read` prints.
	Uploads []Upload `json:"uploads,omitempty"`
	// Mentions are the identities the body @mentions, by id: a handle an agent had before still names it (I-51).
	Mentions []MentionSpan `json:"mentions,omitempty"`
}

// LastReply is the newest reply of a thread as the reply chip shows it. Unread is set when it is newer than the reader's read point
// in a thread the reader is involved in (DA-3), so it is per reader.
type LastReply struct {
	ID        int64  `json:"id"`
	Author    Person `json:"author"`
	Preview   string `json:"preview"` // the plain-text projection, at most 120 characters
	CreatedAt int64  `json:"created_at"`
	Unread    bool   `json:"unread,omitempty"`
}

// ThreadRow is one thread of a conversation as the list shows it under the conversation. Unread counts the replies the reader
// has not read, only in a thread it is involved in (DA-3).
type ThreadRow struct {
	RootID      int64      `json:"root_id"`
	Author      Person     `json:"author"`
	Preview     string     `json:"preview"` // the root's plain text
	ReplyCount  int64      `json:"reply_count"`
	LastReply   *LastReply `json:"last_reply,omitempty"`
	LastReplyAt int64      `json:"last_reply_at"`
	Unread      int64      `json:"unread"`
}

// MentionSpan is one @mention: the handle as written, and the identity it names with its handle now.
type MentionSpan struct {
	AsWritten  string `json:"as_written"`
	IdentityID int64  `json:"identity_id"`
	Handle     string `json:"handle"`
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

// Transcript is the words of a voice note: State is pending, done or failed; Text is set when done, and while a redo is pending it is the earlier text.
type Transcript struct {
	State string `json:"state"`
	Text  string `json:"text,omitempty"`
	// RedoFailed is true when "Transcribe again" gave up and Text is the earlier transcript.
	RedoFailed bool `json:"redo_failed,omitempty"`
}

// PostRequest is POST /api/conversations/:id/messages. The author is never in it: the server takes it from the credential.
type PostRequest struct {
	ClientID   string          `json:"client_id"`
	Body       string          `json:"body"`
	Format     string          `json:"format,omitempty"`
	ThreadRoot int64           `json:"thread_root_id,omitempty"`
	Broadcast  bool            `json:"broadcast,omitempty"`
	UploadIDs  []string        `json:"upload_ids,omitempty"`
	App        json.RawMessage `json:"app,omitempty"`       // agents only
	ViaApp     *ViaAppRequest  `json:"via_app,omitempty"`   // the owner only
	ViaVoice   bool            `json:"via_voice,omitempty"` // the owner's voice call posts this; the owner only
	// AsVoice is a message the owner's voice call writes for him: its author is @voice, not the owner. The owner only.
	AsVoice bool `json:"as_voice,omitempty"`
	// Quiet is the call log: stored and shown like a message, but no agent gets an inbox item or a mention from it. Only with via_voice.
	Quiet bool `json:"quiet,omitempty"`
	// NeedsYou says whether the post needs the owner. An agent sends false for news: true is refused on a plain post, because a message
	// that needs the owner is an ask. Absent counts as false with a warning header this release. The owner's value is ignored.
	NeedsYou *bool `json:"needs_you,omitempty"`
}

// AttachAsk puts the ask a message of kind ask carries on it and reads whether the owner still has to act.
func (m *Message) AttachAsk(a AskView) {
	m.Ask, m.NeedsYou = &a, a.State == "open"
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
	// ThreadTopic is the text of the thread root, set only when the message is in a thread. Before is the message just before it in
	// the same place. Both are cut to 120 characters (owner, conv 19 msgs 544 and 561): where am I, and what does this answer.
	ThreadTopic string  `json:"thread_topic,omitempty"`
	Before      *Before `json:"before,omitempty"`
}

// Before is the message that comes just before an inbox item's message in the same place: who wrote it and what it said, cut short.
type Before struct {
	Author string `json:"author"`
	Text   string `json:"text"`
}

// InboxResponse is GET /api/inbox.
type InboxResponse struct {
	Items []InboxItem `json:"items"`
	// Cursor answers a poll with after=: the next poll of the same watch sends it back as after (0 is absent).
	Cursor int64 `json:"cursor,omitempty"`
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

// AgentRow is one agent in `convoz agents`: what another agent needs to name it, and nothing private.
type AgentRow struct {
	Handle      string `json:"handle"`
	DisplayName string `json:"display_name"`
	Description string `json:"description"`
	State       string `json:"state"`
}

// AgentsResponse is the answer of GET /api/agents.
type AgentsResponse struct {
	Agents []AgentRow `json:"agents"`
}

// WatchAdvice is the one way to listen: keep `convoz watch --json` running and read each line as it arrives (coordinator, conv 19 msgs 580
// and 583; owner msg 438: one correct way). `--once` stays in the CLI for scripts and is taught nowhere. The brief and `session start` print it.
const WatchAdvice = "Keep `convoz watch --json` running in the background and read each line as it arrives: answer it. If the watch stops, start it again."

// WatchLine is what `convoz watch --json` prints for each item: one line of JSON.
type WatchLine struct {
	ItemID     int64  `json:"item_id"`
	ClaimToken string `json:"claim_token"`
	// Ack is the ready argument for `convoz ack`: "<item_id>:<claim_token>".
	Ack               string  `json:"ack"`
	Reason            string  `json:"reason"`
	ConversationID    int64   `json:"conversation_id"`
	ConversationTitle *string `json:"conversation_title"`
	Count             int64   `json:"count"`
	MessageID         int64   `json:"message_id"`
	// ThreadRootID is set when the newest message was written inside a thread: answer with `convoz reply <thread_root_id>`, not post.
	ThreadRootID int64  `json:"thread_root_id,omitempty"`
	Author       string `json:"author"`
	Body         string `json:"body"`
	// Text is what the message says in words: the body, or for a message with files the plain form ("Voice note 0:21: <words>"). A voice note has an empty Body.
	Text      string `json:"text"`
	CreatedAt string `json:"created_at"`
	// ThreadTopic and Before say where the message sits and what it answers; see InboxItem.
	ThreadTopic string  `json:"thread_topic,omitempty"`
	Before      *Before `json:"before,omitempty"`
	// Reply is the answer of a draft ask (an ask_resolved item): send true with the final text, or send false. Absent on any other item.
	Reply *AskReply `json:"reply,omitempty"`
	// Note is what the item means for the agent when the message is an ask that closed without a choice (the owner replied). Absent otherwise.
	Note string `json:"note,omitempty"`
}

// ValidClientID reports whether s is a well-formed client id: 8 to 64 characters, no space or control character.
// A client id keys the replay of a post or a session mint, so the server and the CLI judge it the same way.
func ValidClientID(s string) bool {
	n := utf8.RuneCountInString(s)
	return n >= 8 && n <= 64 && !strings.ContainsFunc(s, func(r rune) bool { return unicode.IsControl(r) || unicode.IsSpace(r) })
}

// Seen is one agent that has seen the newest message a person wrote in a place (the main list, or one thread): the message,
// and when the agent's claim first covered it. The page shows "Seen by @handle" under it.
type Seen struct {
	Handle    string `json:"handle"`
	MessageID int64  `json:"message_id"`
	At        int64  `json:"at"`
}

// TypingRequest is POST /api/conversations/:id/typing: an agent says it is working on a reply, in the thread of ThreadRoot
// (any message of the thread) or in the main list when 0.
type TypingRequest struct {
	ThreadRoot int64 `json:"thread_root_id,omitempty"`
}
