package plan

// Deliverables: what an agent will deliver in a conversation and by when (delivery.feature).
// Owner (Drew, conv 179, msg 9734): "my biggest stress is trying to know what everything is working on and when things will be
// delivered … maybe a global one with the reminders when due dates p[ass]". Design: @langwatch-assistant, conv 179 msg 9739.
//
// A deliverable is not a Now item: a Now ETA is a 30-minute step, a due date is a promise. Deliverables live in the plan's JSON body,
// so they need no column of their own. Unlike the rest of the plan they persist across replacements: `--deliver X --due T` adds X or
// moves its date, and `--done X` ships it. An agent that updates its Doing every half hour so never drops its promises by accident.

import (
	"context"
	"encoding/json"
	"errors"
	"regexp"
	"slices"
	"strconv"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/plan/db"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

const (
	// MaxDeliver is how many deliverables one plan holds.
	MaxDeliver = 5
	// MaxDue is the furthest a due date may lie ahead.
	MaxDue = 60 * 24 * time.Hour
	// DeliveryStaleAfter is how long a plan with a deliverable may go without an update before the deliverable is at risk.
	DeliveryStaleAfter = 24 * time.Hour
)

// The states of a deliverable, most urgent first.
const (
	DeliveryLate    = "late"
	DeliveryWaiting = "waiting"
	DeliveryAtRisk  = "at_risk"
	DeliveryOnTrack = "on_track"
)

// ErrTooManyDeliver means the plan would hold more than MaxDeliver deliverables.
var ErrTooManyDeliver = errors.New("plan: too many deliverables")

// Deliverable is one promise of a plan: what, and when (epoch ms). NudgedDue is the due date the agent was already asked about, so it
// is asked once per date: a new date differs from it and is asked about again when it passes.
type Deliverable struct {
	Text      string `json:"text"`
	Due       int64  `json:"due"`
	Since     int64  `json:"since"`
	NudgedDue int64  `json:"nudged_due,omitempty"`
}

// DeliverInput is one deliverable as the agent sends it, its due date already absolute.
type DeliverInput struct {
	Text string
	Due  int64
}

// mergeDeliver applies a request to the kept deliverables: a known text gets its new date, a new text is added (at is its start),
// and a Done text that names a deliverable ships it. shipped lists the texts shipped.
func mergeDeliver(old []Deliverable, in []DeliverInput, done []string, at int64) (out []Deliverable, shipped []string, err error) {
	out = slices.Clone(old)
	for _, d := range in {
		if i := slices.IndexFunc(out, func(o Deliverable) bool { return o.Text == d.Text }); i >= 0 {
			out[i].Due = d.Due
			continue
		}
		out = append(out, Deliverable{Text: d.Text, Due: d.Due, Since: at})
	}
	for _, t := range done {
		if i := slices.IndexFunc(out, func(o Deliverable) bool { return o.Text == t }); i >= 0 {
			out = slices.Delete(out, i, i+1)
			shipped = append(shipped, t)
		}
	}
	if len(out) > MaxDeliver {
		return nil, nil, ErrTooManyDeliver
	}
	return out, shipped, nil
}

var (
	dateRE = regexp.MustCompile(`^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})$`)
	daysRE = regexp.MustCompile(`^([1-9][0-9]?)d(.*)$`)
)

// ParseDue turns a due date into epoch ms on the server clock: a duration ("30m", "2d", "1d4h"), a wall time "HH:MM" (the next time
// it comes) or a date and time "YYYY-MM-DD HH:MM", both in the agent's zone (utcOffset seconds east of UTC). It must lie ahead, at
// most MaxDue.
func ParseDue(s string, utcOffset int, now time.Time) (int64, bool) {
	if utcOffset < -14*3600 || utcOffset > 14*3600 {
		return 0, false
	}
	var at time.Time
	switch m := dateRE.FindStringSubmatch(s); {
	case clockRE.MatchString(s):
		ms, _ := ParseETA(s, utcOffset, now)
		at = time.UnixMilli(ms)
	case m != nil:
		t, err := time.ParseInLocation("2006-01-02 15:04", m[1]+" "+m[2], time.FixedZone("agent", utcOffset))
		if err != nil {
			return 0, false
		}
		at = t
	default:
		var d time.Duration
		if m := daysRE.FindStringSubmatch(s); m != nil {
			days, _ := strconv.Atoi(m[1])
			s, d = m[2], time.Duration(days)*24*time.Hour
		}
		if s != "" {
			rest, err := time.ParseDuration(s)
			if err != nil {
				return 0, false
			}
			d += rest
		}
		at = now.Add(d)
	}
	if !at.After(now) || at.Sub(now) > MaxDue {
		return 0, false
	}
	return at.UnixMilli(), true
}

// DeliveryState is how a deliverable of the plan stands at now: late past its due date; waiting when the plan waits on the owner;
// at risk when the plan is blocked or has had no update for DeliveryStaleAfter; else on track.
func DeliveryState(p Plan, d Deliverable, now int64) string {
	switch {
	case now >= d.Due:
		return DeliveryLate
	case len(p.Waiting) > 0:
		return DeliveryWaiting
	case p.Blocked != "" || DeliveryStale(p, now):
		return DeliveryAtRisk
	}
	return DeliveryOnTrack
}

// DeliveryStale reports whether the plan has had no update for DeliveryStaleAfter.
func DeliveryStale(p Plan, now int64) bool {
	return now-p.UpdatedAt >= DeliveryStaleAfter.Milliseconds()
}

// DeliveriesToNudge lists the index of each deliverable whose due date passed and that the agent was not asked about for that date.
func (p Plan) DeliveriesToNudge(now int64) (out []int) {
	for i, d := range p.Deliver {
		if now >= d.Due && d.NudgedDue != d.Due {
			out = append(out, i)
		}
	}
	return out
}

// LateDeliverable is the deliverable that was due first among those past their date.
func (p Plan) LateDeliverable(now int64) (best Deliverable, ok bool) {
	for _, d := range p.Deliver {
		if now >= d.Due && (!ok || d.Due < best.Due) {
			best, ok = d, true
		}
	}
	return best, ok
}

// MarkNudged records that the agent was asked about the deliverables at idx for their current dates. It rewrites the body only: the
// plan's update time and its own nudge count stay, so the ask does not read as an update by the agent.
func MarkNudged(ctx context.Context, d pdb.DBTX, p Plan, idx []int) error {
	b := p.Body
	b.Deliver = slices.Clone(b.Deliver)
	for _, i := range idx {
		b.Deliver[i].NudgedDue = b.Deliver[i].Due
	}
	raw, err := json.Marshal(b)
	if err != nil {
		return err
	}
	return db.New(d).SetPlanBody(ctx, db.SetPlanBodyParams{BodyJson: string(raw), AgentID: p.Agent, ConversationID: p.Conversation})
}
