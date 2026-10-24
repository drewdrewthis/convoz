package wire

// RoutePlans is the board the web app reads: every plan the caller may see, the agents' liveness and each conversation's line.
const RoutePlans = "/api/plans"

// PlanRequest is PUT /api/conversations/:id/plan: the caller's whole plan for the conversation. The identity comes from the lease.
type PlanRequest struct {
	// Now lists up to 3 items done in parallel, each with its own step and estimate; it replaces Doing, Step and ETA (give one or the other).
	Now   []PlanNowRequest `json:"now,omitempty"`
	Doing string           `json:"doing,omitempty"`
	// Step is "N/M": the Doing item is at step N of M.
	Step string `json:"step,omitempty"`
	// Blocked says what the agent waits on in this conversation (not the owner: that is Waiting).
	Blocked string `json:"blocked,omitempty"`
	// ETA is when the Doing item should be done: a duration from now ("30m", "1h30m") or a wall time "HH:MM" in the zone of UTCOffset.
	ETA string `json:"eta,omitempty"`
	// UTCOffset is the agent's zone, in seconds east of UTC, for an ETA given as "HH:MM".
	UTCOffset int      `json:"utc_offset,omitempty"`
	Next      []string `json:"next,omitempty"`
	Waiting   []string `json:"waiting,omitempty"`
	// Done are items finished since the last plan; they go in front of the Done history.
	Done []string `json:"done,omitempty"`
	// ClientID names the request: a retry with the same one after a lost answer changes nothing (I-24).
	ClientID string `json:"client_id,omitempty"`
}

// PlanNowRequest is one Now item of a request: its text, its step as "N/M" and its estimate as for PlanRequest.ETA.
type PlanNowRequest struct {
	Text string `json:"text"`
	Step string `json:"step,omitempty"`
	ETA  string `json:"eta,omitempty"`
}

// PlanNow is one thing the agent does now, with its own step and estimate.
type PlanNow struct {
	Text  string    `json:"text"`
	Since int64     `json:"since,omitempty"`
	Step  *PlanStep `json:"step,omitempty"`
	ETA   int64     `json:"eta,omitempty"`
}

// PlanStep is "step At of Of".
type PlanStep struct {
	At int `json:"at"`
	Of int `json:"of"`
}

// PlanWaiting is an item that waits on the owner, and since when.
type PlanWaiting struct {
	Text  string `json:"text"`
	Since int64  `json:"since"`
}

// PlanDone is a finished item, and when it was reported finished.
type PlanDone struct {
	Text string `json:"text"`
	At   int64  `json:"at"`
}

// Plan is one agent's plan in one conversation.
type Plan struct {
	ConversationID int64  `json:"conversation_id"`
	IdentityID     int64  `json:"identity_id"`
	Handle         string `json:"handle"`
	// Now lists up to 3 items, each with its own step and estimate. Doing, DoingSince, Step and ETA are the first one, for older readers.
	Now        []PlanNow     `json:"now"`
	Doing      string        `json:"doing"`
	DoingSince int64         `json:"doing_since,omitempty"`
	Step       *PlanStep     `json:"step,omitempty"`
	Blocked    string        `json:"blocked,omitempty"`
	ETA        int64         `json:"eta,omitempty"`
	Next       []string      `json:"next"`
	Waiting    []PlanWaiting `json:"waiting"`
	Done       []PlanDone    `json:"done"` // newest first, at most 20
	UpdatedAt  int64         `json:"updated_at"`
	// DueAt is when the plan turns overdue by its own clock: the ETA, or 2 h after the update for a Doing with no ETA.
	DueAt int64 `json:"due_at,omitempty"`
	// NudgedAt is when Convoz last asked the agent to update this plan; absent when it never did since the plan was written.
	NudgedAt int64 `json:"nudged_at,omitempty"`
}

// PlanAgent is one agent of the board: its status and its liveness.
type PlanAgent struct {
	IdentityID int64  `json:"identity_id"`
	Handle     string `json:"handle"`
	State      string `json:"state"` // its `convoz status` state
	Doing      string `json:"doing"`
	Online     bool   `json:"online"`
	LastSeenAt int64  `json:"last_seen_at,omitempty"`
	// Liveness is ok, not_responding (a message waited 10 min and it holds no watch) or logged_out (and it has no live session).
	Liveness string `json:"liveness"`
	// UnansweredSince is since when the oldest message that waits for the agent has waited, in the conversations of the board.
	UnansweredSince int64 `json:"unanswered_since,omitempty"`
}

// PlanAttention is the line of one conversation: its most urgent state across the agents.
type PlanAttention struct {
	ConversationID int64  `json:"conversation_id"`
	State          string `json:"state"` // waiting, blocked, not_responding, logged_out, late, stale, working, next, done
	Handle         string `json:"handle"`
	Text           string `json:"text"`
	ETA            int64  `json:"eta,omitempty"`
	More           int    `json:"more,omitempty"` // the plan has this many more Now items than the line shows
	LastSeenAt     int64  `json:"last_seen_at,omitempty"`
}

// PlanBoard is GET /api/plans.
type PlanBoard struct {
	Now       int64           `json:"now"`
	Plans     []Plan          `json:"plans"`
	Agents    []PlanAgent     `json:"agents"`
	Asks      []OpenAsk       `json:"asks"`
	Attention []PlanAttention `json:"attention"`
	// NextChangeAt is when time alone changes a line next (server clock); read the board again then.
	NextChangeAt int64 `json:"next_change_at,omitempty"`
}
