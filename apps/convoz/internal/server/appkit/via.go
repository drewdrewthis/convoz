package appkit

import (
	"errors"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/appschema"
)

// Target is the app message a result says it comes from.
type Target struct {
	ID, Conversation, Author int64
	App                      []byte
}

// Via is a checked result, ready to be written: the agent comes from the app message, never from the request (I-46).
type Via struct {
	Message, Agent int64
	Result         []byte
	Summary        string
}

// ErrNoApp says the target has no app: a plain message, a deleted one or one of another conversation.
var ErrNoApp = errors.New("that message has no app")

// PrepareVia judges a result against the app it comes from (§4.4 #10). The summary becomes the body of the message.
func PrepareVia(t Target, result []byte) (Via, error) {
	if len(t.App) == 0 {
		return Via{}, ErrNoApp
	}
	app, issue := appschema.Check(t.App)
	if issue != nil {
		return Via{}, issue
	}
	r, issue := appschema.CheckResult(app, result)
	if issue != nil {
		return Via{}, issue
	}
	return Via{Message: t.ID, Agent: t.Author, Result: r.Canonical(), Summary: r.Summary}, nil
}
