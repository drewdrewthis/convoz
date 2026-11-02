package httpapi

import (
	"strings"
	"testing"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/plan"
)

// The text of a status_due ask comes from what made the ask (advisor follow-up, conv 408 msg 9809): a late step asks about the
// step, a late delivery asks about the delivery, even when the plan has both.
func bothLate() plan.Plan {
	return plan.Plan{UpdatedAt: 0, Body: plan.Body{
		Now:     []plan.Item{{Text: "Building invites", ETA: 1000}},
		Deliver: []plan.Deliverable{{Text: "Search filters live", Due: 2000, NudgedDue: 2000}},
	}}
}

func TestAStepAskNamesTheStepEvenWhenADeliveryIsLate(t *testing.T) {
	got := statusDueBody(41, bothLate(), nil, askedByStep, 5000)
	if !strings.Contains(got, `is late: "Building invites"`) || strings.Contains(got, "new date, or blocked?") {
		t.Fatalf("step ask: %q", got)
	}
}

func TestADeliveryAskNamesTheDelivery(t *testing.T) {
	got := statusDueBody(41, bothLate(), nil, askedByDelivery, 5000)
	if !strings.Contains(got, `"Search filters live"`) || !strings.Contains(got, "done, new date, or blocked?") {
		t.Fatalf("delivery ask: %q", got)
	}
}

func TestADeliveryAskWhoseDeliverableShippedFallsBackToThePlan(t *testing.T) {
	p := bothLate()
	p.Deliver = nil
	got := statusDueBody(41, p, nil, askedByDelivery, 5000)
	if strings.Contains(got, "new date, or blocked?") || !strings.Contains(got, "Building invites") {
		t.Fatalf("shipped delivery: %q", got)
	}
}
