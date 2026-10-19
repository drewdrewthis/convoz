package httpapi

import (
	"net/http"
	"sync"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/identity"
)

// runnerSet holds, per agent, which session runs `convoz run` for it, so the server (not each box) keeps a TUI or a second
// `convoz watch` from taking the same agent's inbox. Promised to the owner in conv 30, reply 953: "while `convoz run` serves a handle,
// any other `convoz watch` for that handle is refused". It lives in memory: after a restart the runner's next poll makes it again.
//
// The lock is tied to the runner's session, not to its open polls: a runner is busy with an item for minutes between polls, and the
// calls of the runner and of its commands (which use its session) keep it. It is let go when the session ends, or watchGrace after
// the runner's last call. The zero value is ready.
type runnerSet struct {
	mu     sync.Mutex
	agents map[int64]*agentRun
}

type agentRun struct {
	session   int64  // the runner's session, 0 when no runner holds the agent
	machine   string // where it runs, for the refusal
	open      int    // polls the runner holds open now
	last      int64  // the runner session's last call (server clock, ms)
	watchOpen int    // long polls of any other session
	watchLast int64
}

// verdict is what a long poll gets from the runner set.
type verdict int

const (
	pollAllowed     verdict = iota
	pollRunnerHolds         // another session's runner holds the agent
	pollWatchOpen           // a runner asked while a watch of another session is open
)

func (a *agentRun) held(now int64) bool {
	return a.session != 0 && (a.open > 0 || now-a.last < watchGrace.Milliseconds())
}

// admit decides a long poll (a poll with wait, or any poll of a runner) of session for agent. When it allows it, the returned func
// must be called when the poll ends. runner is true for `convoz run`'s own polls. On a refusal machine names where the runner is.
func (rs *runnerSet) admit(agent, session int64, runner bool, machine string, now int64) (v verdict, holder string, leave func(now int64)) {
	rs.mu.Lock()
	defer rs.mu.Unlock()
	if rs.agents == nil {
		rs.agents = map[int64]*agentRun{}
	}
	a := rs.agents[agent]
	if a == nil {
		a = &agentRun{}
		rs.agents[agent] = a
	}
	switch {
	case runner:
		if a.held(now) && a.session != session && a.machine != machine { // the same machine is the same runner: its local lock allows one
			return pollRunnerHolds, a.machine, nil
		}
		if a.watchOpen > 0 || (a.watchLast > 0 && now-a.watchLast < watchGrace.Milliseconds()) {
			return pollWatchOpen, "", nil
		}
		if a.session != session { // a new runner session takes over
			a.session, a.open = session, 0
		}
		a.machine, a.last = machine, now
		a.open++
		return pollAllowed, "", func(end int64) {
			rs.mu.Lock()
			defer rs.mu.Unlock()
			if a.session == session { // not after release or a takeover: those reset the count
				a.open = max(a.open-1, 0)
				a.last = max(a.last, end)
			}
		}
	case a.held(now) && a.session != session:
		return pollRunnerHolds, a.machine, nil
	case a.session == session: // the runner's own command watching: it is the runner
		a.last = now
		return pollAllowed, "", func(int64) {}
	}
	a.watchOpen++
	a.watchLast = now
	return pollAllowed, "", func(end int64) {
		rs.mu.Lock()
		defer rs.mu.Unlock()
		a.watchOpen = max(a.watchOpen-1, 0)
		a.watchLast = max(a.watchLast, end)
	}
}

// touch records a call of session: it keeps its runner lock alive.
func (rs *runnerSet) touch(agent, session int64, now int64) {
	rs.mu.Lock()
	defer rs.mu.Unlock()
	if a := rs.agents[agent]; a != nil && a.session == session {
		a.last = now
	}
}

// release lets go of the lock when the runner's session ends.
func (rs *runnerSet) release(agent, session int64) {
	rs.mu.Lock()
	defer rs.mu.Unlock()
	if a := rs.agents[agent]; a != nil && a.session == session {
		a.session, a.open = 0, 0
	}
}

// admitPoll applies the runner lock to an inbox call. A long poll (wait above 0) or a runner's poll is admitted or refused with 409;
// any other call only keeps the runner's lock alive. leave must be called when the call ends.
func (s *Server) admitPoll(w http.ResponseWriter, r *http.Request, c *call, long, runner bool) (leave func(), ok bool) {
	now, agent := s.Clock.Now().UnixMilli(), c.lease.IdentityID
	if !long && !runner {
		s.runners.touch(agent, c.lease.SessionID, now)
		return func() {}, true
	}
	v, holder, done := s.runners.admit(agent, c.lease.SessionID, runner, c.lease.Machine, now)
	if v == pollAllowed {
		return func() { done(s.Clock.Now().UnixMilli()) }, true
	}
	handle := ""
	if who, found, err := identity.ByID(r.Context(), s.reader(), agent); err != nil {
		s.internalError(w, r, err)
		return nil, false
	} else if found {
		handle = who.Handle
	}
	if v == pollRunnerHolds {
		writeErr(w, http.StatusConflict, "runner_holds", "@"+handle+" is served by convoz run on "+holder)
	} else {
		writeErr(w, http.StatusConflict, "watch_open", "@"+handle+" already has a convoz watch open")
	}
	return nil, false
}
