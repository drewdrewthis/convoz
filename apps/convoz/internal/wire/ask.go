package wire

import (
	"encoding/json"
	"fmt"
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

// A permission ask: the agent is confident in one action and asks the owner to accept its risk (Drew, conv 349 msg 6199). The owner
// answers Go or Not this, with a reason. MinConfidence is the bar of the confidence the agent reports; below it the ask is refused
// with GetConfidentFirst, one text for the CLI, the MCP tool and the API.
const (
	MinConfidence     = 80
	GetConfidentFirst = "Get confident first: research it or run it by @advisor, then ask with --confidence 80 or more. Never hand the owner the thinking."
)

// Limits of a permission ask, in characters (code points): the parts must read in about 10 seconds.
const (
	MaxAction         = 100
	MaxRisk           = 140
	MaxUndo           = 80
	MaxConsidered     = 3
	MaxConsideredLine = 120
)

// AskPermission is what a permission ask asks the owner to accept: the action, its risk, how to undo it (or OneWay when it cannot
// be undone), 1 to 3 other ways the agent considered and why each is worse, and the agent's own confidence (0 to 100).
type AskPermission struct {
	Action     string   `json:"action"`
	Risk       string   `json:"risk"`
	Undo       string   `json:"undo,omitempty"`
	OneWay     bool     `json:"one_way,omitempty"`
	Considered []string `json:"considered"`
	Confidence int      `json:"confidence"`
}

// Problem says in words what is wrong with the permission, or "" when it is good.
func (p AskPermission) Problem() string {
	_, problem := p.Check()
	return problem
}

// Check is Problem with the field it names (action, risk, undo, considered or confidence). An agent under the confidence bar is told
// to get confident before anything else: the other parts do not matter until it is.
func (p AskPermission) Check() (field, problem string) {
	switch {
	case p.Confidence < 0 || p.Confidence > 100:
		return "confidence", "The confidence is a whole number from 0 to 100."
	case p.Confidence < MinConfidence:
		return "confidence", GetConfidentFirst
	}
	if field, problem := checkPart("action", p.Action, MaxAction); problem != "" {
		return field, problem
	}
	if field, problem := checkPart("risk", p.Risk, MaxRisk); problem != "" {
		return field, problem
	}
	switch hasUndo := strings.TrimSpace(p.Undo) != ""; {
	case hasUndo && p.OneWay:
		return "undo", "Give undo or one_way, not both."
	case !hasUndo && !p.OneWay:
		return "undo", "Say how to undo it, or mark it one_way."
	case hasUndo:
		if field, problem := checkPart("undo", p.Undo, MaxUndo); problem != "" {
			return field, problem
		}
	}
	if len(p.Considered) < 1 || len(p.Considered) > MaxConsidered {
		return "considered", "Give 1 to 3 other ways you considered, each with why it is worse."
	}
	for _, line := range p.Considered {
		if field, problem := checkPart("considered", line, MaxConsideredLine); problem != "" {
			return field, problem
		}
	}
	return "", ""
}

// checkPart judges one text part of a permission: there, and at most max characters.
func checkPart(field, v string, max int) (string, string) {
	switch {
	case strings.TrimSpace(v) == "":
		return field, "A permission ask needs " + field + "."
	case utf8.RuneCountInString(v) > max:
		return field, fmt.Sprintf("Shorten: %s has at most %d characters", field, max)
	}
	return "", ""
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
	// ReplyCount and UnreadReplies are of the thread "Reply in thread" opens on this ask: its own, or the one it was asked in.
	// UnreadReplies is per reader and 0 for a reader who is not in that thread.
	ReplyCount    int64  `json:"reply_count,omitempty"`
	UnreadReplies int64  `json:"unread_replies,omitempty"`
	Asker         Person `json:"asker"`
	// Kind is "permission", "decision" (an ask with options, the legacy shape) or "draft".
	Kind        string      `json:"kind"`
	Question    string      `json:"question"`
	Urgent      bool        `json:"urgent"`
	OwnersCall  *OwnersCall `json:"owners_call,omitempty"` // absent on an ask from before the field
	State       string      `json:"state"`
	CloseReason string      `json:"close_reason,omitempty"`
	Options     []AskOption `json:"options"`
	Chosen      *AskChoice  `json:"chosen,omitempty"`
	Answer      string      `json:"answer,omitempty"`
	AnswerVia   string      `json:"answer_via,omitempty"`
	ResolvedBy  *Person     `json:"resolved_by,omitempty"`
	ResolvedAt  int64       `json:"resolved_at,omitempty"`
	AckedAt     int64       `json:"acked_at,omitempty"`
	// OwnerReply is the latest reply of the owner in the thread of this open ask; present while the ask waits on the agent's answer.
	OwnerReply *AskOwnerReply `json:"owner_reply,omitempty"`
	// Answers is the short summary of the answers to the owner's questions that the latest update of the ask carries.
	Answers string `json:"answers,omitempty"`
	// Revision is 2 after the first update, 3 after the next; absent on an ask that was never updated. Changed is what the latest update changed.
	Revision     int             `json:"revision,omitempty"`
	Changed      string          `json:"changed,omitempty"`
	Version      int64           `json:"version"`
	CreatedAt    int64           `json:"created_at"`
	SnoozedUntil int64           `json:"snoozed_until,omitempty"`
	History      []AskHistoryRow `json:"history,omitempty"`
	App          json.RawMessage `json:"app,omitempty"`        // the app shown with the question, or its stub
	Draft        *AskDraft       `json:"draft,omitempty"`      // a draft ask: the message to send in the owner's name
	Reply        *AskReply       `json:"reply,omitempty"`      // a draft ask once answered
	Permission   *AskPermission  `json:"permission,omitempty"` // a permission ask: its parts and the confidence it was asked with
}

// AskOwnerReply is the owner's latest reply in the thread of an open ask: the message, a short excerpt of its words and when it was sent.
type AskOwnerReply struct {
	ID   int64  `json:"id"`
	Text string `json:"text"`
	At   int64  `json:"at"`
}

// OwnerReplyExcerpt is how many characters of the owner's reply an ask shows.
const OwnerReplyExcerpt = 100

// RepliedNote is what an agent is told about an ask that closed before migration 0039 because the owner replied in its thread.
const RepliedNote = "The owner replied instead of choosing. Ask again if you still need a decision."

// OwnerRepliedNote is what an agent is told when the owner replied in the thread of its open ask instead of choosing.
const OwnerRepliedNote = "@owner replied in the thread of your ask: answer there, then update the same ask with `convoz ask --update <id> --answers ...` (do not send a new ask)."

// Note is the line that tells an agent what an ask means for it after the owner replied; empty when the ask needs none.
func (a AskView) Note() string {
	switch {
	case a.State == "open" && a.OwnerReply != nil:
		return OwnerRepliedNote
	case a.State == "closed" && a.CloseReason == "replied":
		return RepliedNote
	}
	return ""
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
	App            json.RawMessage    `json:"app,omitempty"`   // the app.v1 an agent shows with the question
	Draft          *AskDraft          `json:"draft,omitempty"` // a draft ask: no options and no owner's call are given, the server sets them
	// Permission is a permission ask: no options and no owner's call are given (the server sets Go and Not this); the question defaults to the action.
	Permission *AskPermission `json:"permission,omitempty"`
}

// OwnersCallProblem judges the owner's call of the request: a draft or permission ask needs none, any other ask needs a good one.
func (r AskRequest) OwnersCallProblem() string {
	if r.Draft != nil || r.Permission != nil {
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

// AskUpdateRequest is PATCH /api/asks/:id: the asking agent updates its open ask in place. Recommended and Alternatives are given together
// and replace the options; Answers is the summary (at most 1000 characters) of the answers to the owner's questions, required once the owner replied.
type AskUpdateRequest struct {
	Question         string             `json:"question,omitempty"`
	Recommended      *AskOptionRequest  `json:"recommended,omitempty"`
	Alternatives     []AskOptionRequest `json:"alternatives,omitempty"`
	OwnersCallReason string             `json:"owners_call_reason,omitempty"`
	Answers          string             `json:"answers,omitempty"`
	// Permission rewrites the parts of a permission ask, all of them; its confidence is fixed when the ask is made and must be left out.
	Permission *AskPermission `json:"permission,omitempty"`
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

// NowWaiting is one plan item an agent waits on the owner for.
type NowWaiting struct {
	Conversation AskConversation `json:"conversation"`
	Agent        Person          `json:"agent"`
	Text         string          `json:"text"`
	Since        int64           `json:"since"`
}

// NowPendingAdd is an agent that waits for a person to add it to a conversation.
type NowPendingAdd struct {
	Conversation AskConversation `json:"conversation"`
	Person       Person          `json:"person"`
	RequestedBy  *Person         `json:"requested_by,omitempty"`
	At           int64           `json:"at"`
}
