package ask

import (
	"context"
	"errors"
	"fmt"
	"time"

	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// Limits (design §13.1, schema §7).
const (
	MaxOpenPerAsker = 20
	MaxQuestion     = 500
	MaxLabel        = 120
	MaxWhy          = 280
	MaxAlternatives = 4
	MaxCustomText   = 4000
	MaxOriginal     = 2000
	MaxOriginalFrom = 200
	// MaxSnooze is how far ahead a snooze may reach.
	MaxSnooze = 31 * 24 * time.Hour
)

// States and close reasons.
const (
	Open      = "open"
	Answered  = "answered"
	Dismissed = "dismissed"
	Closed    = "closed"

	ReasonRemoved   = "removed"
	ReasonWithdrawn = "withdrawn"
	ReasonDeleted   = "deleted"
	ReasonRevoked   = "agent_revoked"
	// ReasonReplied is how asks closed before migration 0039, when the owner's reply in the ask's thread closed it. New replies keep the ask open.
	ReasonReplied = "replied"
)

// Choice kinds.
const (
	Recommended = "recommended"
	Alternative = "alternative"
	Custom      = "custom"
)

// Option is one answer an ask offers. The first of an ask is the recommended one.
type Option struct{ Label, Why string }

// OwnersCall is why only the owner can decide an ask: a Kind (one-way, taste, values or scope) and a Reason.
type OwnersCall struct{ Kind, Reason string }

// Draft is a message the agent wants to send in the owner's name; Original is the message it answers, from OriginalFrom.
type Draft struct{ Text, Original, OriginalFrom string }

// The two options of a draft ask: the owner sends the draft (Send is the recommended choice, and carries the final text) or does not.
var draftOptions = []Option{{Label: "Send", Why: "Post the draft, as written or as edited."}, {Label: "Don't send", Why: "Drop the draft."}}

// Choice is what an answer was.
type Choice struct {
	Kind  string
	Index int // Alternative: 1 to 4
	Text  string
}

// Transition is one row of the history (C-6). By is 0 for the system.
type Transition struct {
	Version int64
	Event   string
	ToState string
	By      int64
	At      int64
}

// Ask is an ask as a reader sees it.
type Ask struct {
	ID, ConversationID, AskerID int64
	Question                    string
	Urgent                      bool
	OwnersCall                  *OwnersCall // nil on an ask from before the field, and after a purge
	Draft                       *Draft      // nil on any ask that is not a draft ask, and after a purge
	Scrubbed                    bool
	State, CloseReason          string
	Options                     []Option
	Chosen                      *Choice
	AnswerVia                   string
	ResolvedBy, ResolvedAt      int64
	AckedAt                     int64
	// OwnerRepliedAt and OwnerReplyID are the latest reply of the owner in the thread of this open ask; 0 when there is none.
	OwnerRepliedAt, OwnerReplyID int64
	// ReplyAnswered is someone other than the owner posting in the thread after the owner's reply (the agent answered in words).
	ReplyAnswered bool
	// Answers is the summary of the answers the latest update carries, and Changed what that update changed ("question, options"); empty before any update.
	Answers, Changed     string
	Version              int64
	CreatedAt, UpdatedAt int64
	History              []Transition
}

// WaitingOnAgent is an open ask whose thread has the owner's reply as its last word: the agent has not answered it yet.
func (a Ask) WaitingOnAgent() bool {
	return a.State == Open && a.OwnerRepliedAt > 0 && !a.ReplyAnswered
}

// Answer is the answer in words: the chosen option's label, or the custom text; "Send: <text>" or "Don't send" on a draft ask.
func (a Ask) Answer() string {
	switch {
	case a.Chosen == nil:
		return ""
	case a.Draft != nil && a.Chosen.Kind == Recommended:
		return "Send: " + a.Chosen.Text
	case a.Draft != nil:
		return "Don't send"
	case a.Chosen.Kind == Custom:
		return a.Chosen.Text
	case a.Chosen.Kind == Recommended && len(a.Options) > 0:
		return a.Options[0].Label
	case a.Chosen.Kind == Alternative && a.Chosen.Index < len(a.Options):
		return a.Options[a.Chosen.Index].Label
	}
	return ""
}

// The versioned names of the events of this module (design §5.4). Their payloads are ids and enums only (I-23).
const (
	EventCreated   = "ask.created.v1"
	EventAnswered  = "ask.answered.v1"
	EventDismissed = "ask.dismissed.v1"
	EventReopened  = "ask.reopened.v1"
	EventClosed    = "ask.closed.v1"
	EventAcked     = "ask.acked.v1"
	EventSnoozed   = "ask.snoozed.v1"
	EventUnsnoozed = "ask.unsnoozed.v1"
	EventWoke      = "ask.woke.v1"
	// EventOwnerReplied is the owner replying in the thread of an open ask: the ask stays open.
	EventOwnerReplied = "ask.owner_replied.v1"
	// EventUpdated is the asking agent updating its open ask in place.
	EventUpdated = "ask.updated.v1"
)

// Change is a thin event the module asks its journal to write. Audience is set when only one identity may see it (a snooze).
type Change struct {
	Type                                            string
	Actor, Session, Conversation, Message, Audience int64
	Payload                                         map[string]any
}

// Ports are the other modules a change works through; the composition root plugs them in. Every call runs in the
// caller's transaction.
type Ports struct {
	Messages      Messages
	Conversations Conversations
	Inbox         Inbox
	Journal       Journal
	Notify        Notifier
}

// AskMessage is the ask message to write.
type AskMessage struct {
	Conversation, ThreadRoot, Author, Session int64
	OriginLabel, OriginMachine                string
	ClientID, Question                        string
	App                                       []byte // the app shown with the question; nil for none
}

// AnswerMessage is the text message that carries an answer, written by the person who answered. It goes where the ask was
// asked (the ask's thread, else the main list) and never moves the answerer's read cursor (I-15).
type AnswerMessage struct {
	Ask, Conversation, Author, Device int64
	Text                              string
}

// Messages writes the messages of an ask.
type Messages interface {
	// PostAsk writes the ask message. Replayed is true when the client id wrote it before; then nothing changed.
	PostAsk(ctx context.Context, d pdb.DBTX, now time.Time, m AskMessage) (id int64, replayed bool, err error)
	PostAnswer(ctx context.Context, d pdb.DBTX, now time.Time, m AnswerMessage) error
	// SetQuestion writes the updated question into the ask message, so previews and search follow the card.
	SetQuestion(ctx context.Context, d pdb.DBTX, now time.Time, ask int64, question string) error
}

// Conversations is the conversation side of an ask.
type Conversations interface {
	// AddOpenAsks moves the open-ask counter of a conversation.
	AddOpenAsks(ctx context.Context, d pdb.DBTX, conv, delta int64) error
	// AskerActive reports whether the asking agent is still an active participant of the conversation and not disabled.
	AskerActive(ctx context.Context, d pdb.DBTX, conv, asker int64) (bool, error)
}

// Inbox tells the asking agent that its ask was resolved.
type Inbox interface {
	AskResolved(ctx context.Context, d pdb.DBTX, now time.Time, agent, conv, askMessage, sourceSeq int64) error
}

// Journal writes the thin event of a change and returns its seq.
type Journal interface {
	Write(ctx context.Context, d pdb.DBTX, now time.Time, c Change) (int64, error)
}

// Notifier records the notification a snooze waking causes (design §10.1, reason snooze_wake).
type Notifier interface {
	SnoozeWoke(ctx context.Context, d pdb.DBTX, now time.Time, person, conv, askMessage, sourceSeq int64) error
}

// Errors. A FieldError is a 400, a Conflict a 409, the rest are named where they are returned.
var (
	ErrNotFound = errors.New("no such ask")
	ErrNotAsker = errors.New("only the asking agent may do that")
	// ErrCap is the create-time limit: the agent already has 20 open asks.
	ErrCap = errors.New("an agent holds at most 20 open asks")
	// ErrPresetGone is Tonight asked for at 18:00 or later.
	ErrPresetGone = errors.New("Tonight is over")
)

// FieldError is a request the module refuses, naming the field.
type FieldError struct{ Field, Message string }

func (e *FieldError) Error() string { return fmt.Sprintf("%s: %s", e.Field, e.Message) }

// Conflict codes.
const (
	CodeConflict  = "conflict"   // another change won; the ask as it stands comes with it
	CodeNotOpen   = "not_open"   // snooze of an ask that is not open (C-5)
	CodeAskerGone = "asker_gone" // the agent left the conversation or was disabled
	CodeAskCap    = "ask_cap"    // undismiss while the agent holds 20 open asks
)

// Conflict is a 409: the code and the ask as it stands now.
type Conflict struct {
	Code string
	Ask  Ask
}

func (c *Conflict) Error() string {
	return fmt.Sprintf("ask %d: %s (%s)", c.Ask.ID, c.Code, c.Ask.State)
}
