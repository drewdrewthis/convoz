package httpapi

// Owner, conv 179 msg 14826: "Turn off toasts on mobile, they should go out as notifications." What a toast told the owner (every
// new message from someone else, an agent asking to connect) becomes a push.

import (
	"context"
	"testing"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/message"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/notify"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/dbtest"
)

func triggersOf(t *testing.T, e notify.Event) []notify.Trigger {
	t.Helper()
	s := mentionStore(t)
	dbtest.Exec(t, s,
		`INSERT INTO conversations (id, created_by, created_at, last_activity_at) VALUES (41,1,1,1)`,
		`INSERT INTO messages (id, conversation_id, author_id, kind, body, created_at) VALUES (900,41,2,'text','done',1),(902,41,1,'text','mine',1)`,
		`INSERT INTO messages (id, conversation_id, author_id, kind, body, created_at, thread_root_id) VALUES (901,41,2,'text','a reply',1,900)`,
		lastMainFixup)
	var out []notify.Trigger
	dbtest.Tx(t, s, func(ctx context.Context, d pdb.DBTX) (err error) {
		out, err = pushSource{}.Triggers(ctx, d, e)
		return err
	})
	return out
}

func TestAPlainMessageFromSomeoneElseIsAMessagePush(t *testing.T) {
	for _, id := range []int64{900, 901} { // the main list, and a thread the owner is not in
		got := triggersOf(t, notify.Event{Seq: 10, Actor: 2, Conversation: 41, Message: id, Type: eventMessageCreated, Payload: `{"kind":"text"}`})
		if len(got) != 1 || got[0].Reason != notify.ReasonMessage || got[0].Message != id || got[0].TopicKind != notify.TopicConversation || got[0].TopicID != 41 {
			t.Errorf("message %d: %+v", id, got)
		}
	}
	if got := triggersOf(t, notify.Event{Seq: 11, Actor: 1, Conversation: 41, Message: 902, Type: eventMessageCreated, Payload: `{"kind":"text"}`}); len(got) != 0 {
		t.Errorf("the owner's own message is no push: %+v", got)
	}
}

func TestAnAgentAskingToConnectIsAnIdentityRequestPush(t *testing.T) {
	got := triggersOf(t, notify.Event{Seq: 12, Type: "identity.requested.v1", Payload: `{"request_id":7,"machine_id":3}`})
	if len(got) != 1 || got[0].Reason != notify.ReasonIdentityRequest || got[0].TopicKind != notify.TopicIdentityRequest || got[0].TopicID != 7 || got[0].Conversation != 0 {
		t.Errorf("%+v", got)
	}
}

func TestAnAppMessagePushReadsItsFallback(t *testing.T) {
	m := message.Message{Format: "plain", App: []byte(`{"title":"Poll","fallback":"Pick a time"}`), HasApp: true}
	if got := pushText("drew", m, nil); got != "App: Poll — Pick a time" {
		t.Errorf("%q", got)
	}
	if got := pushText("drew", message.Message{Format: "plain", Body: "@drew, ready"}, nil); got != "ready" {
		t.Errorf("the leading mention of the owner goes: %q", got)
	}
}
