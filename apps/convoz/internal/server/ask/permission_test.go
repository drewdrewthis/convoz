package ask_test

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/ask"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/dbtest"
)

// recordingMessages writes the ask message row the way the message module does and records the answer texts.
type recordingMessages struct {
	next    int64
	answers []string
}

func (f *recordingMessages) PostAsk(ctx context.Context, d pdb.DBTX, _ time.Time, m ask.AskMessage) (int64, bool, error) {
	f.next++
	id := 100 + f.next
	_, err := d.ExecContext(ctx, `INSERT INTO messages (id, conversation_id, author_id, kind, body, created_at) VALUES (?,?,?,'ask',?,1)`, id, m.Conversation, m.Author, m.Question)
	return id, false, err
}
func (f *recordingMessages) PostAnswer(_ context.Context, _ pdb.DBTX, _ time.Time, m ask.AnswerMessage) error {
	f.answers = append(f.answers, m.Text)
	return nil
}
func (*recordingMessages) SetQuestion(context.Context, pdb.DBTX, time.Time, int64, string) error {
	return nil
}

func ports() (ask.Ports, *recordingMessages) {
	m := &recordingMessages{}
	return ask.Ports{Messages: m, Conversations: &fakeConversations{}, Inbox: &fakeInbox{}, Journal: &fakeJournal{}, Threads: threads{}}, m
}

func perm() *ask.Permission {
	return &ask.Permission{Action: "Merge PR 415", Risk: "Checkout breaks", Undo: "Revert the merge", Considered: []string{"Hold: costs a day", "Squash: loses history"}, Confidence: 90}
}

// opened creates a permission ask of devtool (identity 2) in conversation 10 and returns its id.
func opened(t *testing.T, s *pdb.Store, p ask.Ports, pm *ask.Permission) int64 {
	t.Helper()
	var id int64
	dbtest.Tx(t, s, func(ctx context.Context, d pdb.DBTX) error {
		a, _, err := ask.Create(ctx, d, p, t0, ask.New{Conversation: 10, Asker: 2, ClientID: "c-" + fmt.Sprint(time.Now().UnixNano()), Permission: pm})
		id = a.ID
		return err
	})
	return id
}

func TestCreate_PermissionAskIsOpenWithFixedOptionsAndItsActionAsQuestion(t *testing.T) {
	s := world(t)
	p, _ := ports()
	a := get(t, s, opened(t, s, p, perm()))
	if a.Kind() != "permission" || a.State != ask.Open || a.Question != "Merge PR 415" {
		t.Errorf("kind %q state %q question %q, want permission, open, the action", a.Kind(), a.State, a.Question)
	}
	var labels []string
	for _, o := range a.Options {
		labels = append(labels, o.Label)
	}
	if !slices.Equal(labels, []string{"Go", "Not this"}) {
		t.Errorf("options %v, want Go and Not this", labels)
	}
	if a.OwnersCall != nil || a.Permission == nil || a.Permission.Confidence != 90 || !slices.Equal(a.Permission.Considered, perm().Considered) {
		t.Errorf("owners call %v, permission %+v: want no owner's call and the stored parts", a.OwnersCall, a.Permission)
	}
}

func TestCreate_PermissionAskIsRefusedNamingTheField(t *testing.T) {
	s := world(t)
	p, _ := ports()
	for name, mut := range map[string]func(*ask.Permission){
		"an action of 101":   func(pm *ask.Permission) { pm.Action = strings.Repeat("é", 101) },
		"undo and one way":   func(pm *ask.Permission) { pm.OneWay = true },
		"a confidence of 79": func(pm *ask.Permission) { pm.Confidence = 79 },
	} {
		pm := perm()
		mut(pm)
		err := dbtest.TxErr(t, s, func(ctx context.Context, d pdb.DBTX) error {
			_, _, err := ask.Create(ctx, d, p, t0, ask.New{Conversation: 10, Asker: 2, ClientID: "c-" + name, Permission: pm})
			return err
		})
		var fe *ask.FieldError
		if !errors.As(err, &fe) {
			t.Errorf("%s: err = %v, want a field error", name, err)
		}
	}
}

func answer(t *testing.T, s *pdb.Store, p ask.Ports, id int64, c ask.Choice) error {
	t.Helper()
	return dbtest.TxErr(t, s, func(ctx context.Context, d pdb.DBTX) error {
		_, _, err := ask.Answer(ctx, d, p, t0, ask.Answering{ID: id, By: 1, Choice: c})
		return err
	})
}

func TestAnswer_GoAndNotThisPostTheirWords(t *testing.T) {
	s := world(t)
	p, m := ports()
	goID, notID := opened(t, s, p, perm()), opened(t, s, p, perm())
	if err := answer(t, s, p, goID, ask.Choice{Kind: ask.Recommended}); err != nil {
		t.Fatal(err)
	}
	if err := answer(t, s, p, notID, ask.Choice{Kind: ask.Alternative, Index: 1, Text: "  Wait for PR 412 "}); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(m.answers, []string{"Go", "Not this: Wait for PR 412"}) {
		t.Errorf("answers posted %q, want Go and Not this: Wait for PR 412", m.answers)
	}
	if c := get(t, s, notID).Chosen; c == nil || c.Kind != ask.Alternative || c.Index != 1 || c.Text != "Wait for PR 412" {
		t.Errorf("chosen = %+v, want alternative 1 with the reason", c)
	}
}

func TestAnswer_NotThisNeedsAReasonAndGoTakesNone(t *testing.T) {
	s := world(t)
	p, _ := ports()
	id := opened(t, s, p, perm())
	for name, c := range map[string]ask.Choice{
		"no text":     {Kind: ask.Alternative, Index: 1},
		"whitespace":  {Kind: ask.Alternative, Index: 1, Text: " \t"},
		"4001 points": {Kind: ask.Alternative, Index: 1, Text: strings.Repeat("é", 4001)},
		"go and text": {Kind: ask.Recommended, Text: "because"},
	} {
		var fe *ask.FieldError
		if err := answer(t, s, p, id, c); !errors.As(err, &fe) || fe.Field != "text" {
			t.Errorf("%s: err = %v, want a field error naming text", name, err)
		}
	}
	if st, _ := state(t, s, id); st != ask.Open {
		t.Errorf("state = %s, want the ask still open", st)
	}
}

func TestUpdate_ChangedNamesExactlyThePermissionFieldsThatDiffer(t *testing.T) {
	s := world(t)
	p, _ := ports()
	id := opened(t, s, p, perm())
	next := perm()
	next.Action, next.Considered = "Merge PR 415 after the nightly", []string{"Hold: costs a day"}
	dbtest.Tx(t, s, func(ctx context.Context, d pdb.DBTX) error {
		_, err := ask.Update(ctx, d, p, t0, ask.Updating{ID: id, By: 2, Permission: next})
		return err
	})
	a := get(t, s, id)
	if a.Changed != "action, considered" || a.Question != next.Action {
		t.Errorf("changed %q question %q, want \"action, considered\" and the new action", a.Changed, a.Question)
	}
	oneWay := *next
	oneWay.Undo, oneWay.OneWay = "", true
	dbtest.Tx(t, s, func(ctx context.Context, d pdb.DBTX) error {
		_, err := ask.Update(ctx, d, p, t0, ask.Updating{ID: id, By: 2, Permission: &oneWay})
		return err
	})
	if pm := get(t, s, id).Permission; !pm.OneWay || pm.Undo != "" || pm.Confidence != 90 {
		t.Errorf("permission = %+v, want one-way, no undo, confidence kept", pm)
	}
}

func TestUpdate_PermissionFieldsOnADecisionAskAreRefused(t *testing.T) {
	s := world(t) // ask 5 is a decision ask of devtool
	p, _ := ports()
	err := dbtest.TxErr(t, s, func(ctx context.Context, d pdb.DBTX) error {
		_, err := ask.Update(ctx, d, p, t0, ask.Updating{ID: 5, By: 2, Permission: perm()})
		return err
	})
	var fe *ask.FieldError
	if !errors.As(err, &fe) {
		t.Errorf("err = %v, want a field error", err)
	}
}
