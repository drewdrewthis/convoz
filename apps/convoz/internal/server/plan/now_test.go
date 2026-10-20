package plan

import (
	"testing"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/plan/db"
)

func TestAttendShowsTheMostUrgentNowItem(t *testing.T) {
	const min = 60_000
	p := Plan{Agent: 1, Conversation: 7, UpdatedAt: 0, Body: Body{Now: []Item{{Text: "slow", ETA: 120 * min}, {Text: "quick", ETA: 30 * min}}}}
	agents := map[int64]Agent{1: {ID: 1, Handle: "dev"}}

	got, _ := Attend(10*min, []Plan{p}, agents, nil)
	if got[0].State != StateWorking || got[0].Text != "slow" || got[0].More != 1 {
		t.Fatalf("before any estimate passes the line shows the first item: %+v", got[0])
	}
	got, _ = Attend(31*min, []Plan{p}, agents, nil)
	if got[0].State != StateLate || got[0].Text != "quick" || got[0].More != 1 {
		t.Fatalf("late is judged per item and the line shows the late one: %+v", got[0])
	}
	if it, state := p.MostOverdue(0, 31*min); state != "late" || it.Text != "quick" {
		t.Fatalf("MostOverdue = %+v %q", it, state)
	}
}

func TestCheckRefusesAFourthNowItem(t *testing.T) {
	if f, _, ok := Check([]string{"a", "b", "c", "d"}, "", nil, nil, nil); ok || f != "doing" {
		t.Fatalf("4 items: field %q ok %v", f, ok)
	}
	if _, _, ok := Check([]string{"a", "b", "c"}, "", nil, nil, nil); !ok {
		t.Fatal("3 items are fine")
	}
}

func TestFillerItemsAreNotShownAsWaiting(t *testing.T) {
	for _, s := range []string{"Nothing", "nothing.", " None ", "N/A", "-", "Nothing yet"} {
		if !Filler(s) {
			t.Errorf("%q is filler", s)
		}
	}
	for _, s := range []string{"Nothing to deploy until you approve", "Approve the dot card", "No rush on the PR"} {
		if Filler(s) {
			t.Errorf("%q is a real item", s)
		}
	}
	p := fromRow(db.Plan{AgentID: 1, ConversationID: 7, BodyJson: `{"waiting":[{"text":"Nothing","since":1}],"blocked":"none","next":["n/a","Ship"]}`})
	if len(p.Waiting) != 0 || p.Blocked != "" || len(p.Next) != 1 {
		t.Fatalf("a stored filler item is dropped on read: %+v", p.Body)
	}
	agents := map[int64]Agent{1: {ID: 1, Handle: "dev"}}
	if got, _ := Attend(0, []Plan{p}, agents, nil); len(got) > 0 && got[0].State == StateWaiting {
		t.Fatalf("a plan whose only waiting item is filler does not wait on the owner: %+v", got[0])
	}
}
