package notify

import (
	"encoding/json"
	"strconv"
	"unicode/utf8"
)

// Payload is what the service worker receives (design §10.3): {v:1, reason, title, body?, url, badge, topic}.
// It carries the short plain text of a message and never app props, results or file bytes (E-20).
type Payload struct {
	V      int    `json:"v"`
	Reason string `json:"reason"`
	Title  string `json:"title"`
	Body   string `json:"body,omitempty"`
	URL    string `json:"url"`
	Badge  int    `json:"badge"`
	Topic  string `json:"topic"`
}

// Preview settings (notify.previews).
const (
	PreviewFull   = "full"   // sender and text
	PreviewSender = "sender" // sender only
	PreviewNone   = "none"   // nothing about the content
)

// Facts is what the sender reads at send time to build one push. The composition root fills it from the other modules.
type Facts struct {
	// Visible is false when the person can no longer see what the push is about: the push is dropped (I-28).
	Visible  bool
	Previews string
	// Sender is who did it, "Dev Tool @devtool": an agent's name is always followed by its handle (I-3).
	Sender string
	// Text is the short plain text of the thing (≤140 characters). Empty when the reason has none.
	Text string
	// Conversation is the conversation's title, for a push about the conversation itself.
	Conversation string
	// Machine and Code belong to a machine request.
	Machine, Code string
	URL           string
	Badge         int
}

// Longest title and body a push carries, in characters.
const maxShown = 140

func clip(s string) string {
	if utf8.RuneCountInString(s) <= maxShown {
		return s
	}
	return string([]rune(s)[:maxShown])
}

// Compose builds the payload of a notification from the person's preview setting. burst is how many pushes this topic has had in
// the last minute, this one included: from the second the body says how many are new, so a burst reads "3 new" (the Topic header makes the
// push service keep only the newest).
func Compose(reason, topic string, f Facts, burst int) Payload {
	p := Payload{V: 1, Reason: reason, URL: f.URL, Badge: f.Badge, Topic: topic}
	switch reason {
	case ReasonMachineRequest:
		p.Title, p.Body = clip(f.Machine)+" wants to connect", "code "+f.Code
		return p
	case ReasonSecurity:
		p.Title, p.Body = "Security alert", clip(f.Text)
		return p
	}
	if f.Previews == PreviewNone {
		p.Title, p.Body = "Convoz", "New activity"
		return p
	}
	p.Title = clip(f.Sender)
	if p.Title == "" {
		p.Title = "Convoz"
	}
	switch {
	case burst > 1:
		p.Body = strconv.Itoa(burst) + " new"
	case f.Previews == PreviewFull && f.Text != "":
		p.Body = clip(f.Text)
	default:
		p.Body = genericBody(reason)
	}
	return p
}

// genericBody is the body when the text is not shown.
func genericBody(reason string) string {
	switch reason {
	case ReasonAsk, ReasonAskUrgent, ReasonSnoozeWake:
		return "New question"
	case ReasonThreadReply:
		return "New reply"
	case ReasonAgentAdd:
		return "Wants to add someone"
	case ReasonPaused:
		return "Conversation paused"
	}
	return "New message"
}

// encode is the payload as JSON, and the record size that pads the encrypted push to the next 512-byte bucket.
func (p Payload) encode() (body []byte, recordSize uint32, err error) {
	body, err = json.Marshal(p)
	if err != nil {
		return nil, 0, err
	}
	return body, recordSizeFor(len(body)), nil
}

// The overhead inside an RFC 8188 record: the header webpush-go writes (salt 16, record size 4, key length 1, key 65), the 1-byte
// padding delimiter and the 16-byte GCM tag. webpush-go pads the plaintext to the record size, so the whole body is exactly the record size.
const (
	headerBytes  = 16 + 4 + 1 + 65
	recordExtra  = headerBytes + 1 + 16
	paddingBlock = 512
)

// recordSizeFor is the smallest multiple of 512 that holds a message of n bytes. A push service sees only that size (I-28).
func recordSizeFor(n int) uint32 {
	need := n + recordExtra
	return uint32((need + paddingBlock - 1) / paddingBlock * paddingBlock)
}
