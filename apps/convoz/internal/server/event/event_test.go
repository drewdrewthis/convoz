package event_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/event"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/dbtest"
)

var t0 = time.Unix(1_800_000_000, 0)

func TestWriteRefusesAnUnversionedName(t *testing.T) {
	for _, typ := range []string{"message.created", "message.created.v", "message.created.vx", "Message.created.v1", ".v1", ""} {
		if _, err := event.Write(context.Background(), nil, t0, event.Entry{Type: typ}); !errors.Is(err, event.ErrBadType) {
			t.Errorf("%q: %v, want ErrBadType", typ, err)
		}
	}
}

func TestWriteStoresTheFullNameAndAnIdempotencyKeyFindsItAgain(t *testing.T) {
	s := dbtest.Store(t)
	dbtest.Exec(t, s,
		`INSERT INTO identities (id, kind, handle, display_name, display_skeleton, avatar_letter, avatar_palette, created_at) VALUES (1,'human','drew','Drew','drew','D',0,1)`,
		`INSERT INTO humans (identity_id, role, created_via) VALUES (1,'owner','bootstrap')`)
	dbtest.Tx(t, s, func(ctx context.Context, d pdb.DBTX) error {
		first, err := event.Write(ctx, d, t0, event.Entry{Type: event.ConversationCreated, Actor: 1, Conversation: 7, IdemKey: "k1", Payload: map[string]any{"id": 7}})
		if err != nil {
			return err
		}
		second, err := event.Append(ctx, d, t0, "passkey.added.v1", map[string]any{"identity_id": 1})
		if err != nil || second <= first {
			t.Errorf("seq grows: %d then %d (%v)", first, second, err)
		}
		got, err := event.Since(ctx, d, 0, 10)
		if err != nil || len(got) != 2 || got[0].Type != "conversation.created.v1" || got[1].Type != "passkey.added.v1" {
			t.Errorf("the log holds the names as written: %+v %v", got, err)
		}
		idem, ok, err := event.FindIdem(ctx, d, 1, "k1")
		if err != nil || !ok || idem.Conversation != 7 || idem.Payload != `{"id":7}` {
			t.Errorf("the retry finds its event: %+v ok=%v err=%v", idem, ok, err)
		}
		if _, ok, _ := event.FindIdem(ctx, d, 1, "other"); ok {
			t.Error("an unused key finds nothing")
		}
		if _, err := event.Write(ctx, d, t0, event.Entry{Type: event.MessageCreated, Actor: 1, IdemKey: "k1"}); err == nil {
			t.Error("one event per (actor, key)")
		}
		return nil
	})
}

func TestCursorRoundTripsAndRefusesJunk(t *testing.T) {
	if got := event.FormatCursor(57); got != event.Epoch+":57" {
		t.Errorf("FormatCursor(57) = %q", got)
	}
	epoch, seq, ok := event.ParseCursor("1:57")
	if !ok || epoch != "1" || seq != 57 {
		t.Errorf("ParseCursor(1:57) = %q %d %v", epoch, seq, ok)
	}
	for _, bad := range []string{"", "57", ":57", "1:", "1:x", "1:-3", "1:2:3"} {
		if _, _, ok := event.ParseCursor(bad); ok {
			t.Errorf("ParseCursor(%q) was accepted", bad)
		}
	}
}
