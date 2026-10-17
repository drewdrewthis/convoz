package notify

import "time"

// Reasons of a notification (design §10.1).
const (
	ReasonAsk            = "ask"
	ReasonAskUrgent      = "ask_urgent"
	ReasonMention        = "mention"
	ReasonThreadReply    = "thread_reply"
	ReasonAgentAdd       = "agent_add"
	ReasonSnoozeWake     = "snooze_wake"
	ReasonPaused         = "paused"
	ReasonMachineRequest = "machine_request"
	ReasonSecurity       = "security"
)

// Why a notification was suppressed (the log shows it, AC-7).
const (
	WhyMuted          = "muted"
	WhyQuietHours     = "quiet_hours"
	WhySettingOff     = "setting_off"
	WhyActiveHere     = "active_here"
	WhyNotVisible     = "not_visible"
	WhyNoSubscription = "no_subscription"
)

// Decisions.
const (
	Send       = "send"
	Suppressed = "suppressed"
)

// Topic kinds: the letter that goes before the id under the HMAC (design §10.3).
const (
	TopicAsk          byte = 'a'
	TopicConversation byte = 'c'
	TopicThread       byte = 't'
	TopicMachine      byte = 'm'
	TopicSecurity     byte = 's'
)

// Trigger is one thing that may notify one person: an event seen by the pipeline.
type Trigger struct {
	Person       int64
	Reason       string
	SourceSeq    int64 // the event that caused it; with Person and Reason it is the notification's identity (I-28)
	Conversation int64 // 0 when the reason is about no conversation
	Message      int64
	TopicKind    byte
	TopicID      int64
	Urgent       bool
	// ExceptDevice is a device that does not get the push: the one that did the thing (a security alert is for the other devices).
	ExceptDevice int64
}

// Env is what the person's choices and the data say about one trigger, read by the composition root.
type Env struct {
	Visible      bool // the person can see what it is about (I-28)
	Enabled      bool // the person's setting for this kind of notification is on
	Muted        bool // the conversation is muted
	Quiet        bool // now is inside the person's quiet hours
	UrgentBypass bool // the person lets an urgent ask through quiet hours
	Focused      bool // a device of the person has the conversation open and focused
}

// bypassesQuiet says whether the trigger goes through quiet hours: the owner is waiting at a terminal for a machine request,
// a security alert cannot wait, and an urgent ask goes through when the person said so.
func (t Trigger) bypassesQuiet(e Env) bool {
	switch t.Reason {
	case ReasonMachineRequest, ReasonSecurity:
		return true
	case ReasonAskUrgent:
		return e.UrgentBypass
	}
	return false
}

// Decide is the pipeline's one decision (AC-7). It returns Send or Suppressed with the reason; the first rule that holds wins,
// in the order a person would explain it: they cannot see it, they turned it off, they muted it, it is quiet, they are looking at it, there is nowhere to send it.
func Decide(t Trigger, e Env, devices int) (decision, why string) {
	switch {
	case !e.Visible:
		return Suppressed, WhyNotVisible
	case !e.Enabled:
		return Suppressed, WhySettingOff
	case e.Muted && t.Reason != ReasonMachineRequest && t.Reason != ReasonSecurity:
		return Suppressed, WhyMuted
	case e.Quiet && !t.bypassesQuiet(e):
		return Suppressed, WhyQuietHours
	case e.Focused:
		return Suppressed, WhyActiveHere
	case devices == 0:
		return Suppressed, WhyNoSubscription
	}
	return Send, ""
}

// expiry is how long a notification may wait for its push before it is dropped as stale (design §5.3: an hour).
const expiry = time.Hour
