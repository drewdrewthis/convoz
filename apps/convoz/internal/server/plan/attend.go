package plan

import (
	"maps"
	"slices"
)

// The states of a conversation's line, most urgent first (the approved design: Waiting on you › Blocked › Late › Working › Done;
// the coordinator put Not responding between Blocked and Late for msg 281).
const (
	StateWaiting       = "waiting"
	StateBlocked       = "blocked"
	StateNotResponding = "not_responding"
	StateLoggedOut     = "logged_out"
	StateLate          = "late"
	StateStale         = "stale"
	StateWorking       = "working"
	StateNext          = "next"
	StateDone          = "done"
)

// Liveness of an agent (msg 281).
const (
	LiveOK            = "ok"
	LiveNotResponding = "not_responding"
	LiveLoggedOut     = "logged_out"
)

var rank = map[string]int{
	StateWaiting: 0, StateBlocked: 1, StateNotResponding: 2, StateLoggedOut: 2, StateLate: 3, StateStale: 4, StateWorking: 5, StateNext: 6, StateDone: 7,
}

// Agent is what the line needs to know of one agent.
type Agent struct {
	ID     int64
	Handle string
	// StatusUpdatedAt is the agent's last `convoz status`: an update that also keeps a plan from being late.
	StatusUpdatedAt int64
	Liveness        string
	LastSeenAt      int64
	// Unanswered is, per conversation, since when the oldest message that waits for the agent has waited.
	Unanswered map[int64]int64
}

// Ask is an open ask of an agent, which waits on the owner.
type Ask struct {
	Conversation int64
	Agent        int64
	Question     string
}

// Attention is the line of one conversation: its most urgent state, whose it is and the words that go with it.
type Attention struct {
	Conversation int64
	State        string
	Agent        int64
	Text         string // the item that waits, what blocks, what is being done
	ETA          int64  // late and working: the estimate of the item the line shows
	More         int    // working, late, stale: how many more Now items the plan has
	LastSeenAt   int64  // not_responding: when the agent last made a call
}

// Liveness is the msg 281 rule for one agent: a message has waited NotRespondingAfter or more and the agent holds no watch. With no
// live session (its key was revoked, or its lease ran out) it is logged out rather than not responding.
func Liveness(oldestUnanswered int64, watching, liveSession bool, now int64) string {
	if oldestUnanswered == 0 || watching || now < oldestUnanswered+NotRespondingAfter.Milliseconds() {
		return LiveOK
	}
	if !liveSession {
		return LiveLoggedOut
	}
	return LiveNotResponding
}

// Attend builds the line of every conversation that has something to show, by conversation id, and the
// earliest time after now at which time alone changes a line (0 for never): a client reads the lines again then.
func Attend(now int64, plans []Plan, agents map[int64]Agent, asks []Ask) (out []Attention, nextChange int64) {
	best := map[int64]Attention{}
	var order []int64
	offer := func(a Attention) {
		cur, ok := best[a.Conversation]
		if !ok {
			order = append(order, a.Conversation)
		}
		if !ok || rank[a.State] < rank[cur.State] {
			best[a.Conversation] = a
		}
	}
	soon := func(t int64) {
		if t > now && (nextChange == 0 || t < nextChange) {
			nextChange = t
		}
	}
	for _, p := range plans {
		ag := agents[p.Agent]
		anchor := max(p.UpdatedAt, ag.StatusUpdatedAt)
		a := Attention{Conversation: p.Conversation, Agent: p.Agent}
		switch {
		case len(p.Waiting) > 0:
			a.State, a.Text = StateWaiting, p.Waiting[0].Text
		case p.Blocked != "":
			a.State, a.Text = StateBlocked, p.Blocked
		case len(p.Now) > 0:
			// the line shows the most urgent item: the one that is overdue, else the first
			it, state := p.MostOverdue(anchor, now)
			if state == "" {
				it = p.Now[0]
			}
			a.Text, a.ETA, a.More = it.Text, it.ETA, len(p.Now)-1
			switch state {
			case "late":
				a.State = StateLate
			case "stale":
				a.State = StateStale
			default:
				a.State = StateWorking
			}
		case len(p.Next) > 0:
			a.State, a.Text = StateNext, p.Next[0]
		default:
			a.State = StateDone
		}
		offer(a)
		if p.Blocked == "" {
			for _, it := range p.Now {
				if it.ETA == 0 || anchor < it.ETA {
					soon(it.dueFrom(anchor))
				}
			}
		}
	}
	for _, k := range asks {
		offer(Attention{Conversation: k.Conversation, Agent: k.Agent, State: StateWaiting, Text: k.Question})
	}
	for _, id := range slices.Sorted(maps.Keys(agents)) {
		ag := agents[id]
		for _, conv := range slices.Sorted(maps.Keys(ag.Unanswered)) {
			since := ag.Unanswered[conv]
			ready := since + NotRespondingAfter.Milliseconds()
			if now < ready {
				soon(ready)
				continue
			}
			if ag.Liveness == LiveNotResponding || ag.Liveness == LiveLoggedOut {
				offer(Attention{Conversation: conv, Agent: ag.ID, State: ag.Liveness, LastSeenAt: ag.LastSeenAt})
			}
		}
	}
	slices.Sort(order)
	for _, c := range order {
		out = append(out, best[c])
	}
	return out, nextChange
}
