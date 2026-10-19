// Package plan is a server module. Plan owns plans and plan_liveness_notes: what each agent is doing in a conversation, what is
// next, what waits on the owner, when it said it would be done, and the quiet notes that an agent stopped responding.
//
// Owner (Drew, conv 2, msg 100): "the agent is actively trying to do something and I should expect another reply soon."
// The rules that turn plans, asks and liveness into one line per conversation are pure (attend.go), so they can be tested alone.
package plan

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/plan/db"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// Limits of one plan (the approved design, tab 3 "Rules").
const (
	MaxText        = 200 // one item's text, in characters
	MaxNext        = 5
	MaxWaiting     = 5
	MaxDonePerCall = 5
	// MaxDoneKept is how much Done history a plan keeps; the panel folds it under "Done · n".
	MaxDoneKept = 20
	// MaxETA is the furthest an estimate may lie ahead.
	MaxETA = 7 * 24 * time.Hour
)

// Timing of the nudge and of the liveness rule. Every one follows the server clock, so the tests move it.
const (
	// StaleAfter is how long a plan with a Doing and no estimate may go without an update before it counts as overdue.
	StaleAfter = 2 * time.Hour
	// NudgeEvery is the gap between two nudges of one miss.
	NudgeEvery = 2 * time.Hour
	// MaxNudges caps the nudges of one miss.
	MaxNudges = 3
	// NotRespondingAfter is how long a message may wait for an agent with no live watch before it shows as not responding.
	NotRespondingAfter = 10 * time.Minute
)

// Step is "step At of Of" of the Doing item.
type Step struct {
	At int `json:"at"`
	Of int `json:"of"`
}

// Waiting is one item that waits on the owner; Since is when it first showed (it keeps that across replacements).
type Waiting struct {
	Text  string `json:"text"`
	Since int64  `json:"since"`
}

// Done is one finished item and when it was reported finished.
type Done struct {
	Text string `json:"text"`
	At   int64  `json:"at"`
}

// Body is the plan's items, stored as one JSON document.
type Body struct {
	Doing      string    `json:"doing,omitempty"`
	DoingSince int64     `json:"doing_since,omitempty"`
	Step       *Step     `json:"step,omitempty"`
	Blocked    string    `json:"blocked,omitempty"`
	Next       []string  `json:"next,omitempty"`
	Waiting    []Waiting `json:"waiting,omitempty"`
	Done       []Done    `json:"done,omitempty"` // newest first
	// ClientID is the id of the request that wrote the plan: the retry of a request whose answer was lost changes nothing (I-24).
	ClientID string `json:"client_id,omitempty"`
}

// Plan is one agent's plan in one conversation.
type Plan struct {
	Agent        int64
	Conversation int64
	Body
	ETA         int64 // epoch ms; 0 for none
	UpdatedAt   int64
	Nudges      int
	NudgedAt    int64
	NudgeAnchor int64
}

// Input is a new plan as the agent sends it, already parsed (ETA is absolute; 0 for none).
type Input struct {
	Doing   string
	Step    *Step
	Blocked string
	ETA     int64
	Next    []string
	Waiting []string
	Done    []string
	// ClientID names the request, so a retry of it is recognised; "" for none.
	ClientID string
}

// Change is what a replacement brought that the owner may want to hear about: items finished, items that newly wait on them.
type Change struct {
	Done       []string
	NewWaiting []string
	// Repeat says the request was a retry of the one that wrote the plan: nothing was written.
	Repeat bool
}

// Quiet reports whether the change is only an edit (no item finished, nothing new waits): no system line, no push.
func (c Change) Quiet() bool { return c.Repeat || len(c.Done) == 0 && len(c.NewWaiting) == 0 }

// ErrNotFound means the agent has no plan in the conversation.
var ErrNotFound = errors.New("plan: not found")

// CheckText reports whether t is one item's text: 1 to MaxText characters, no control characters.
func CheckText(t string) bool {
	n := utf8.RuneCountInString(t)
	return n >= 1 && n <= MaxText && !strings.ContainsFunc(t, unicode.IsControl)
}

// Check validates the lists of an input. field names what is wrong, as the API reports it.
func Check(doing, blocked string, next, waiting, done []string) (field, why string, ok bool) {
	switch {
	case doing != "" && !CheckText(doing):
		return "doing", "doing is at most 200 characters, with no control characters", false
	case blocked != "" && !CheckText(blocked):
		return "blocked", "blocked is at most 200 characters, with no control characters", false
	case len(next) > MaxNext:
		return "next", "next is at most 5 items", false
	case len(waiting) > MaxWaiting:
		return "waiting", "waiting is at most 5 items", false
	case len(done) > MaxDonePerCall:
		return "done", "done is at most 5 items at a time", false
	}
	for name, list := range map[string][]string{"next": next, "waiting": waiting, "done": done} {
		for _, t := range list {
			if !CheckText(t) {
				return name, name + " items are 1 to 200 characters, with no control characters", false
			}
		}
	}
	return "", "", true
}

var stepRE = regexp.MustCompile(`^([1-9][0-9]?)/([1-9][0-9]?)$`)

// ParseStep reads "N/M" with 1 <= N <= M <= 99; "" is no step.
func ParseStep(s string) (*Step, bool) {
	if s == "" {
		return nil, true
	}
	m := stepRE.FindStringSubmatch(s)
	if m == nil {
		return nil, false
	}
	at, _ := strconv.Atoi(m[1])
	of, _ := strconv.Atoi(m[2])
	if at > of {
		return nil, false
	}
	return &Step{At: at, Of: of}, true
}

var clockRE = regexp.MustCompile(`^([01]?[0-9]|2[0-3]):([0-5][0-9])$`)

// ParseETA turns an estimate into epoch ms on the server clock: a duration ("30m", "1h30m") from now, or a wall time "HH:MM" in the
// agent's zone (utcOffset seconds east of UTC), the next time it comes. "" is no estimate.
func ParseETA(s string, utcOffset int, now time.Time) (int64, bool) {
	if s == "" {
		return 0, true
	}
	if m := clockRE.FindStringSubmatch(s); m != nil {
		h, _ := strconv.Atoi(m[1])
		mi, _ := strconv.Atoi(m[2])
		if utcOffset < -14*3600 || utcOffset > 14*3600 {
			return 0, false
		}
		zone := time.FixedZone("agent", utcOffset)
		local := now.In(zone)
		at := time.Date(local.Year(), local.Month(), local.Day(), h, mi, 0, 0, zone)
		if !at.After(now) {
			at = at.AddDate(0, 0, 1)
		}
		return at.UnixMilli(), true
	}
	d, err := time.ParseDuration(s)
	if err != nil || d <= 0 || d > MaxETA {
		return 0, false
	}
	return now.Add(d).UnixMilli(), true
}

// Replace stores the agent's new plan for the conversation whole, keeping the Done history (the new Done items go in front, at most
// MaxDoneKept are kept) and the time each Waiting item first showed. It returns the plan as stored and what changed.
func Replace(ctx context.Context, d pdb.DBTX, now time.Time, agent, conv int64, in Input) (Plan, Change, error) {
	at := now.UnixMilli()
	old, err := Get(ctx, d, agent, conv)
	if err != nil && !errors.Is(err, ErrNotFound) {
		return Plan{}, Change{}, err
	}
	if in.ClientID != "" && old.ClientID == in.ClientID {
		return old, Change{Repeat: true}, nil
	}
	b := Body{Doing: in.Doing, Step: in.Step, Blocked: in.Blocked, Next: slices.Clone(in.Next), ClientID: in.ClientID}
	if b.Doing != "" {
		b.DoingSince = at
		if old.Doing == b.Doing && old.DoingSince != 0 {
			b.DoingSince = old.DoingSince
		}
	}
	var ch Change
	for _, t := range in.Waiting {
		since := at
		if i := slices.IndexFunc(old.Waiting, func(w Waiting) bool { return w.Text == t }); i >= 0 {
			since = old.Waiting[i].Since
		} else {
			ch.NewWaiting = append(ch.NewWaiting, t)
		}
		b.Waiting = append(b.Waiting, Waiting{Text: t, Since: since})
	}
	for i := len(in.Done) - 1; i >= 0; i-- { // the last one given is the newest
		b.Done = append(b.Done, Done{Text: in.Done[i], At: at})
	}
	ch.Done = slices.Clone(in.Done)
	b.Done = append(b.Done, old.Done...)
	if len(b.Done) > MaxDoneKept {
		b.Done = b.Done[:MaxDoneKept]
	}
	raw, err := json.Marshal(b)
	if err != nil {
		return Plan{}, Change{}, err
	}
	eta := sql.NullInt64{Int64: in.ETA, Valid: in.ETA != 0 && b.Doing != ""}
	err = db.New(d).UpsertPlan(ctx, db.UpsertPlanParams{AgentID: agent, ConversationID: conv, BodyJson: string(raw), Eta: eta, UpdatedAt: at})
	if err != nil {
		return Plan{}, Change{}, err
	}
	return Plan{Agent: agent, Conversation: conv, Body: b, ETA: eta.Int64, UpdatedAt: at}, ch, nil
}

// Get reads one plan; ErrNotFound when the agent has none in the conversation.
func Get(ctx context.Context, d pdb.DBTX, agent, conv int64) (Plan, error) {
	r, err := db.New(d).GetPlan(ctx, db.GetPlanParams{AgentID: agent, ConversationID: conv})
	if errors.Is(err, sql.ErrNoRows) {
		return Plan{}, ErrNotFound
	}
	if err != nil {
		return Plan{}, err
	}
	return fromRow(r), nil
}

// OfConversation lists the plans of one conversation, by agent id.
func OfConversation(ctx context.Context, d pdb.DBTX, conv int64) ([]Plan, error) {
	rows, err := db.New(d).PlansOfConversation(ctx, conv)
	return fromRows(rows), err
}

// All lists every plan, by conversation and agent.
func All(ctx context.Context, d pdb.DBTX) ([]Plan, error) {
	rows, err := db.New(d).AllPlans(ctx)
	return fromRows(rows), err
}

func fromRows(rows []db.Plan) []Plan {
	out := make([]Plan, 0, len(rows))
	for _, r := range rows {
		out = append(out, fromRow(r))
	}
	return out
}

func fromRow(r db.Plan) Plan {
	p := Plan{Agent: r.AgentID, Conversation: r.ConversationID, ETA: r.Eta.Int64, UpdatedAt: r.UpdatedAt, Nudges: int(r.Nudges), NudgedAt: r.NudgedAt.Int64, NudgeAnchor: r.NudgeAnchor}
	_ = json.Unmarshal([]byte(r.BodyJson), &p.Body) // the CHECK keeps it valid JSON; a field it lacks reads as empty
	return p
}

// DueAt is when the plan turns overdue by its own clock: its estimate, or StaleAfter after its update when it has a Doing and no
// estimate. 0 for a plan with no Doing.
func (p Plan) DueAt() int64 { return p.dueFrom(p.UpdatedAt) }

// dueFrom is DueAt with anchor as the last update (the plan's, or a later status update of the agent).
func (p Plan) dueFrom(anchor int64) int64 {
	switch {
	case p.Doing == "":
		return 0
	case p.ETA != 0:
		return p.ETA
	}
	return anchor + StaleAfter.Milliseconds()
}

// Overdue says how the plan is overdue at now, given the agent's last update (anchor): "late" past its estimate with no update since,
// "stale" with no estimate and no update for StaleAfter, else "". A blocked plan waits on something else and is never overdue.
func (p Plan) Overdue(anchor, now int64) string {
	if p.Doing == "" || p.Blocked != "" {
		return ""
	}
	if p.ETA != 0 {
		if now >= p.ETA && anchor < p.ETA {
			return "late"
		}
		return ""
	}
	if now >= p.dueFrom(anchor) {
		return "stale"
	}
	return ""
}

// NudgeDue reports whether the agent should be nudged now: the plan is overdue, fewer than MaxNudges went out for this miss, and the
// last one is NudgeEvery old. A miss is one anchor: a newer update starts the count again.
func (p Plan) NudgeDue(anchor, now int64) bool {
	if p.Overdue(anchor, now) == "" {
		return false
	}
	if p.NudgeAnchor != anchor || p.Nudges == 0 {
		return true
	}
	return p.Nudges < MaxNudges && now >= p.NudgedAt+NudgeEvery.Milliseconds()
}

// RecordNudge counts one nudge of the miss that anchor names.
func RecordNudge(ctx context.Context, d pdb.DBTX, p Plan, anchor, now int64) error {
	n := p.Nudges + 1
	if p.NudgeAnchor != anchor {
		n = 1
	}
	return db.New(d).RecordNudge(ctx, db.RecordNudgeParams{Nudges: int64(n), NudgedAt: sql.NullInt64{Int64: now, Valid: true}, NudgeAnchor: anchor, AgentID: p.Agent, ConversationID: p.Conversation})
}

// HasNote reports whether the not-responding note of this stretch was written for the agent in the conversation.
func HasNote(ctx context.Context, d pdb.DBTX, agent, conv int64) (bool, error) {
	return db.New(d).HasNote(ctx, db.HasNoteParams{AgentID: agent, ConversationID: conv})
}

// Noted records that the note was written.
func Noted(ctx context.Context, d pdb.DBTX, now time.Time, agent, conv int64) error {
	return db.New(d).InsertNote(ctx, db.InsertNoteParams{AgentID: agent, ConversationID: conv, NotedAt: now.UnixMilli()})
}

// AnyNote reports whether a stretch of not responding is open for the agent (a read, so the hot paths write only when one is).
func AnyNote(ctx context.Context, d pdb.DBTX, agent int64) (bool, error) {
	return db.New(d).AnyNote(ctx, agent)
}

// EndStretch closes the agent's stretch of not responding (it acked, or holds a watch again) and returns the conversations it was noted in.
func EndStretch(ctx context.Context, d pdb.DBTX, agent int64) ([]int64, error) {
	return db.New(d).DeleteNotes(ctx, agent)
}
