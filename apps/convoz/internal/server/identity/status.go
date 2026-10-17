package identity

import (
	"context"
	"database/sql"
	"errors"
	"slices"
	"time"
	"unicode/utf8"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/identity/db"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// MaxStatusText is the longest "doing" and "next" (schema agent_status).
const MaxStatusText = 200

// StatusStates are the states an agent may report. "Offline" is not one: it is an agent with no live session.
var StatusStates = []string{"idle", "working", "blocked", "waiting"}

// Status is what an agent says it is doing. The zero value (never reported) reads as idle since 0.
type Status struct {
	State     string
	Doing     string
	Next      string
	Since     int64 // epoch ms the agent has been in State since
	UpdatedAt int64
}

// ValidStatus reports whether the state is one of the four and the texts fit.
func ValidStatus(state, doing, next string) (field string, ok bool) {
	switch {
	case !slices.Contains(StatusStates, state):
		return "state", false
	case utf8.RuneCountInString(doing) > MaxStatusText:
		return "doing", false
	case utf8.RuneCountInString(next) > MaxStatusText:
		return "next", false
	}
	return "", true
}

// SetStatus stores what the agent reports and returns it as stored: the status is the agent's, shared by all its sessions.
func SetStatus(ctx context.Context, d pdb.DBTX, now time.Time, agentID int64, state, doing, next string) (Status, error) {
	err := db.New(d).UpsertAgentStatus(ctx, db.UpsertAgentStatusParams{AgentID: agentID, State: state, Doing: doing, Next: next, At: now.UnixMilli()})
	if err != nil {
		return Status{}, err
	}
	s, _, err := StatusOf(ctx, d, agentID)
	return s, err
}

// StatusOf reads one agent's status; an agent that never reported is idle and found is false.
func StatusOf(ctx context.Context, d pdb.DBTX, agentID int64) (s Status, found bool, err error) {
	r, err := db.New(d).GetAgentStatus(ctx, agentID)
	if errors.Is(err, sql.ErrNoRows) {
		return Idle(), false, nil
	}
	return Status{State: r.State, Doing: r.Doing, Next: r.Next, Since: r.Since, UpdatedAt: r.UpdatedAt}, err == nil, err
}

// Statuses reads every reported status by agent id; an agent missing from it is idle.
func Statuses(ctx context.Context, d pdb.DBTX) (map[int64]Status, error) {
	rows, err := db.New(d).ListAgentStatuses(ctx)
	if err != nil {
		return nil, err
	}
	out := make(map[int64]Status, len(rows))
	for _, r := range rows {
		out[r.AgentID] = Status{State: r.State, Doing: r.Doing, Next: r.Next, Since: r.Since, UpdatedAt: r.UpdatedAt}
	}
	return out, nil
}

// Idle is the status of an agent that never reported.
func Idle() Status { return Status{State: "idle"} }
