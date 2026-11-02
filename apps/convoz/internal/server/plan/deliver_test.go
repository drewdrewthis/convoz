package plan

import (
	"errors"
	"testing"
	"time"
)

// Owner (Drew, conv 179, msg 9734): "when things will be delivered … with the reminders when due dates pass".

func TestDeliverablesStayUntilShippedAndARedateKeepsTheItem(t *testing.T) {
	got, shipped, err := mergeDeliver(nil, []DeliverInput{{Text: "Search live", Due: 500}}, nil, 10)
	if err != nil || len(got) != 1 || got[0] != (Deliverable{Text: "Search live", Due: 500, Since: 10}) || shipped != nil {
		t.Fatalf("a new deliverable: %+v %v %v", got, shipped, err)
	}
	got, _, _ = mergeDeliver(got, nil, nil, 20)
	if len(got) != 1 || got[0].Due != 500 {
		t.Fatalf("a plan without --deliver keeps the deliverables: %+v", got)
	}
	got[0].NudgedDue = 500
	got, _, _ = mergeDeliver(got, []DeliverInput{{Text: "Search live", Due: 900}}, nil, 30)
	if len(got) != 1 || got[0].Due != 900 || got[0].Since != 10 || got[0].NudgedDue != 500 {
		t.Fatalf("a new date keeps the item and its start: %+v", got)
	}
	got, shipped, _ = mergeDeliver(got, nil, []string{"Search live", "Other"}, 40)
	if len(got) != 0 || len(shipped) != 1 || shipped[0] != "Search live" {
		t.Fatalf("--done with the same text ships it: %+v %v", got, shipped)
	}
}

func TestAPlanHoldsAtMostFiveDeliverables(t *testing.T) {
	var in []DeliverInput
	for _, s := range []string{"a", "b", "c", "d", "e", "f"} {
		in = append(in, DeliverInput{Text: s, Due: 1})
	}
	if _, _, err := mergeDeliver(nil, in[:5], nil, 0); err != nil {
		t.Fatalf("5: %v", err)
	}
	if _, _, err := mergeDeliver(nil, in, nil, 0); !errors.Is(err, ErrTooManyDeliver) {
		t.Fatalf("6: %v", err)
	}
}

func TestParseDueTakesADurationAClockTimeOrADate(t *testing.T) {
	now := time.Date(2026, 10, 27, 10, 0, 0, 0, time.UTC)
	ms := func(t time.Time) int64 { return t.UnixMilli() }
	for in, want := range map[string]int64{
		"30m":              ms(now.Add(30 * time.Minute)),
		"2d":               ms(now.Add(48 * time.Hour)),
		"1d4h":             ms(now.Add(28 * time.Hour)),
		"18:00":            ms(time.Date(2026, 10, 27, 18, 0, 0, 0, time.UTC)),
		"09:00":            ms(time.Date(2026, 10, 28, 9, 0, 0, 0, time.UTC)),
		"2026-10-30 17:30": ms(time.Date(2026, 10, 30, 17, 30, 0, 0, time.UTC)),
		"2026-10-30T17:30": ms(time.Date(2026, 10, 30, 17, 30, 0, 0, time.UTC)),
	} {
		if got, ok := ParseDue(in, 0, now); !ok || got != want {
			t.Errorf("%q: got %d %v, want %d", in, got, ok, want)
		}
	}
	for _, in := range []string{"", "tomorrow", "0m", "-1h", "2026-10-20 10:00", "100d", "2026-13-01 10:00"} {
		if _, ok := ParseDue(in, 0, now); ok {
			t.Errorf("%q: accepted", in)
		}
	}
}

func TestADeliverableIsLateThenWaitingThenAtRiskThenOnTrack(t *testing.T) {
	const hour = int64(time.Hour / time.Millisecond)
	dv := Deliverable{Text: "x", Due: 10 * hour}
	cases := []struct {
		name string
		p    Plan
		now  int64
		want string
	}{
		{"on track", Plan{UpdatedAt: 0}, hour, DeliveryOnTrack},
		{"nine hours since the plan", Plan{UpdatedAt: 0}, 9 * hour, DeliveryOnTrack},
		{"blocked", Plan{Body: Body{Blocked: "CI"}}, hour, DeliveryAtRisk},
		{"waiting on the owner", Plan{Body: Body{Blocked: "CI", Waiting: []Waiting{{Text: "ok?"}}}}, hour, DeliveryWaiting},
		{"late", Plan{Body: Body{Waiting: []Waiting{{Text: "ok?"}}}}, 10 * hour, DeliveryLate},
	}
	for _, c := range cases {
		if got := DeliveryState(c.p, dv, c.now); got != c.want {
			t.Errorf("%s: got %q, want %q", c.name, got, c.want)
		}
	}
	far := Deliverable{Text: "y", Due: 100 * hour}
	if got := DeliveryState(Plan{UpdatedAt: 0}, far, 25*hour); got != DeliveryAtRisk {
		t.Errorf("a plan with no update for a day is at risk: %q", got)
	}
}

func TestTheAgentIsAskedOncePerDueDate(t *testing.T) {
	p := Plan{Body: Body{Deliver: []Deliverable{{Text: "x", Due: 100}, {Text: "y", Due: 300}}}}
	if got := p.DeliveriesToNudge(99); len(got) != 0 {
		t.Fatalf("before the due time: %v", got)
	}
	got := p.DeliveriesToNudge(100)
	if len(got) != 1 || got[0] != 0 {
		t.Fatalf("at the due time: %v", got)
	}
	p.Deliver[0].NudgedDue = 100
	if got := p.DeliveriesToNudge(250); len(got) != 0 {
		t.Fatalf("asked already for this date: %v", got)
	}
	p.Deliver, _, _ = mergeDeliver(p.Deliver, []DeliverInput{{Text: "x", Due: 400}}, nil, 260)
	if got := p.DeliveriesToNudge(399); len(got) != 1 || got[0] != 1 {
		t.Fatalf("a new date waits for its own time (only y is due): %v", got)
	}
	if got := p.DeliveriesToNudge(400); len(got) != 2 {
		t.Fatalf("both are due at 400: %v", got)
	}
	if dv, ok := p.LateDeliverable(400); !ok || dv.Text != "y" {
		t.Fatalf("the earliest late one: %+v %v", dv, ok)
	}
}
