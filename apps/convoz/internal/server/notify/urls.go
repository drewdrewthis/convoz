package notify

import "strconv"

// The page a tapped push opens. Every one must be a page route of the server (httpapi.Routes, Page: true): the web app
// shows "Conversation not found" for a URL the server answers 404 for.
const (
	// URLNow is the Now screen, where asks, snooze wakes and agent-add requests wait.
	URLNow = "/"
	// URLSettings is the Settings page, where push is turned on.
	URLSettings = "/settings"
	// URLPrivacy is Privacy & security, where a security alert tells the owner to sign other devices out.
	URLPrivacy = "/settings/privacy"
)

// ReasonTest is the reason of the push that confirms push is on (it has no Facts: nothing about it can go stale).
const ReasonTest = "test"

// URLFor is the page the push for a reason opens. conversation is the conversation it is about (0 for none); request is a
// machine request's id.
func URLFor(reason string, conversation, request int64) string {
	switch reason {
	case ReasonMachineRequest:
		return URLMachineRequest(request)
	case ReasonSecurity:
		return URLPrivacy
	case ReasonTest:
		return URLSettings
	case ReasonAsk, ReasonAskUrgent, ReasonSnoozeWake, ReasonAgentAdd:
		return URLNow
	}
	if conversation != 0 {
		return URLChat(conversation)
	}
	return URLNow
}

// URLChat is the page of one conversation.
func URLChat(id int64) string { return "/chats/" + strconv.FormatInt(id, 10) }

// URLMachineRequest is the Now screen with one machine request's card open.
func URLMachineRequest(id int64) string { return "/now/machine/" + strconv.FormatInt(id, 10) }
