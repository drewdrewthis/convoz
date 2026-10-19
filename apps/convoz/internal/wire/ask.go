package wire

import (
	"encoding/json"
	"slices"
	"strings"
	"unicode/utf8"
)

// Route of the ask API, as the CLI calls it.
const RouteAsks = "/api/asks"

// OwnersCallKinds are the reasons an ask may give for being the owner's call: a one-way door, a choice of taste or of values,
// or scope the owner must own.
var OwnersCallKinds = []string{"one-way", "taste", "values", "scope"}

// MaxOwnersCallReason is the longest reason, in characters.
const MaxOwnersCallReason = 280

// DecideYourself is what the CLI, the MCP tool and the API tell an agent that sends an ask without saying why only the owner can
// decide it. One text, so the three cannot disagree.
const DecideYourself = "Decide this yourself: weigh the options and pick one, then tell the owner in a post. " +
	"Send an ask only when it is the owner's call: a one-way door, a taste or values choice, or scope the owner must own. " +
	"Then pass --owners-call <one-way|taste|values|scope> --owners-call-why '...'"

// OwnersCallInYourName is the owner's call of a draft ask. It is never given by an agent: the server sets it, with InYourNameReason.
const (
	OwnersCallInYourName = "in-your-name"
	InYourNameReason     = "It goes out in your name."
)

// Limits of a draft ask, in characters.
const (
	MaxDraft        = 4000
	MaxOriginal     = 2000
	MaxOriginalFrom = 200
)

// OwnersCall is why only the owner can decide an ask.
type OwnersCall struct {
	Kind   string `json:"kind"`
	Reason string `json:"reason"`
}

// Problem says in words what is wrong with the owner's call, or "" when it is good.
func (o OwnersCall) Problem() string {
	switch {
	case o.Kind == OwnersCallInYourName:
		return "The call in-your-name is for a draft ask only: use --draft."
	case !slices.Contains(OwnersCallKinds, o.Kind) || strings.TrimSpace(o.Reason) == "":
		return DecideYourself
	case utf8.RuneCountInString(o.Reason) > MaxOwnersCallReason:
		return "The reason it is the owner's call has at most 280 characters."
	}
	return ""
}

// AskDraft is a message the agent wants to send in the owner's name: the draft, and the message it answers when there is one.
type AskDraft struct {
	Text         string `json:"text"`
	Original     string `json:"original,omitempty"`
	OriginalFrom string `json:"original_from,omitempty"`
}

// Problem says in words what is wrong with the draft, or "" when it is good.
func (d AskDraft) Problem() string {
	switch {
	case strings.TrimSpace(d.Text) == "":
		return "A draft ask needs the draft text."
	case utf8.RuneCountInString(d.Text) > MaxDraft:
		return "A draft has at most 4000 characters."
	case utf8.RuneCountInString(d.Original) > MaxOriginal:
		return "The original has at most 2000 characters."
	case utf8.RuneCountInString(d.OriginalFrom) > MaxOriginalFrom:
		return "The from-line of the original has at most 200 characters."
	}
	return ""
}

// TruncateOriginal cuts an original to MaxOriginal characters and ends it with "…" when it was longer.
func TruncateOriginal(s string) string {
	if utf8.RuneCountInString(s) <= MaxOriginal {
		return s
	}
	return string([]rune(s)[:MaxOriginal-1]) + "…"
}

// AskReply is the answer of a draft ask as the agent reads it: Text is the final text, present only when Send is true.
type AskReply struct {
	Send bool   `json:"send"`
	Text string `json:"text,omitempty"`
}

// AskOption is one answer an ask offers. The first of an ask is the recommended one.
type AskOption struct {
	Label       string `json:"label"`
	Why         string `json:"why"`
	Recommended bool   `json:"recommended,omitempty"`
}

// AskChoice is what an answer was: a recommended option, an alternative (Index 1 to 4) or the person's own words.
type AskChoice struct {
	Kind  string `json:"kind"`
	Index int    `json:"index,omitempty"`
	Text  string `json:"text,omitempty"`
}

// AskHistoryRow is one row of an ask's history; a row without By was made by the system.
type AskHistoryRow struct {
	Version int64   `json:"version"`
	Event   string  `json:"event"`
	ToState string  `json:"to_state"`
	By      *Person `json:"by,omitempty"`
	At      int64   `json:"at"`
}

// AskConversation names the conversation of an ask.
type AskConversation struct {
	ID    int64   `json:"id"`
	Title *string `json:"title"`
}

// AskView is an ask as a reader sees it: the same shape in a message, in GET /api/asks/:id and in Now.
type AskView struct {
	ID             int64            `json:"id"`
	ConversationID int64            `json:"conversation_id"`
	Conversation   *AskConversation `json:"conversation,omitempty"`
	ThreadRootID   int64            `json:"thread_root_id,omitempty"`
	Asker          Person           `json:"asker"`
	Question       string           `json:"question"`
	Urgent         bool             `json:"urgent"`
	OwnersCall     *OwnersCall      `json:"owners_call,omitempty"` // absent on an ask from before the field
	State          string           `json:"state"`
	CloseReason    string           `json:"close_reason,omitempty"`
	Options        []AskOption      `json:"options"`
	Chosen         *AskChoice       `json:"chosen,omitempty"`
	Answer         string           `json:"answer,omitempty"`
	AnswerVia      string           `json:"answer_via,omitempty"`
	ResolvedBy     *Person          `json:"resolved_by,omitempty"`
	ResolvedAt     int64            `json:"resolved_at,omitempty"`
	AckedAt        int64            `json:"acked_at,omitempty"`
	Version        int64            `json:"version"`
	CreatedAt      int64            `json:"created_at"`
	SnoozedUntil   int64            `json:"snoozed_until,omitempty"`
	History        []AskHistoryRow  `json:"history,omitempty"`
	App            json.RawMessage  `json:"app,omitempty"` // the app shown with the question, or its stub
	Draft          *AskDraft        `json:"draft,omitempty"` // a draft ask: the message to send in the owner's name
	Reply          *AskReply        `json:"reply,omitempty"` // a draft ask once answered
}

// AskOptionRequest is one option of a new ask.
type AskOptionRequest struct {
	Label string `json:"label"`
	Why   string `json:"why"`
}

// AskRequest is POST /api/asks. The asker is never in it: the server takes it from the lease.
type AskRequest struct {
	ConversationID int64              `json:"conversation_id"`
	ThreadRootID   int64              `json:"thread_root_id,omitempty"`
	ClientID       string             `json:"client_id"`
	Question       string             `json:"question"`
	Recommended    AskOptionRequest   `json:"recommended"`
	Alternatives   []AskOptionRequest `json:"alternatives"`
	OwnersCall     OwnersCall         `json:"owners_call"`
	Urgent         bool               `json:"urgent,omitempty"`
	App            json.RawMessage    `json:"app,omitempty"` // the app.v1 an agent shows with the question
	Draft          *AskDraft          `json:"draft,omitempty"` // a draft ask: no options and no owner's call are given, the server sets them
}

// OwnersCallProblem judges the owner's call of the request: a draft ask needs none (the server sets it), any other ask needs a good one.
func (r AskRequest) OwnersCallProblem() string {
	if r.Draft != nil {
		return ""
	}
	return r.OwnersCall.Problem()
}

// OneAsk is the answer of the ask routes.
type OneAsk struct {
	Ask AskView `json:"ask"`
}

// AskAnswerRequest is POST /api/asks/:id/answer.
type AskAnswerRequest struct {
	Choice    string `json:"choice"`
	Index     int    `json:"index,omitempty"`
	Text      string `json:"text,omitempty"` // custom: the person's words; recommended on a draft ask: the final text
	IfVersion int64  `json:"if_version,omitempty"`
	ClientID  string `json:"client_id,omitempty"`
	Via       string `json:"via,omitempty"`
}

// AskMarkRequest is POST /api/asks/:id/{dismiss,undismiss,withdraw}.
type AskMarkRequest struct {
	IfVersion int64  `json:"if_version,omitempty"`
	ClientID  string `json:"client_id,omitempty"`
}

// AskSnoozeRequest is PUT /api/asks/:id/snooze: a preset (1h, tonight, tomorrow; the last two read in TZ) or an exact time.
type AskSnoozeRequest struct {
	Preset string `json:"preset,omitempty"`
	Until  int64  `json:"until,omitempty"`
	TZ     string `json:"tz,omitempty"`
}

// AskConflict is the body of a 409: the error and the ask as it stands.
type AskConflict struct {
	Error ErrorDetail `json:"error"`
	Ask   AskView     `json:"ask"`
}

// NowPendingAdd is an agent that waits for a person to add it to a conversation.
type NowPendingAdd struct {
	Conversation AskConversation `json:"conversation"`
	Person       Person          `json:"person"`
	RequestedBy  *Person         `json:"requested_by,omitempty"`
	At           int64           `json:"at"`
}
