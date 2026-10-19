package httpapi

import (
	"context"
	"slices"
	"sync"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/auth"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/conversation"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/event"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/identity"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/inbox"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/message"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/plan"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// watchGrace is how long after its last inbox call an agent still counts as connected: `convoz watch` polls again at once, and a
// plain `convoz inbox` is the agent at work too.
const watchGrace = 30 * time.Second

// watchSet knows which agents hold a long poll of their inbox now, and when each last called it (server clock, ms). It lives in
// memory: after a restart every agent counts as connected again from its next call. The zero value is ready.
type watchSet struct {
	mu   sync.Mutex
	open map[int64]int
	last map[int64]int64
}

// touch records an inbox call; open says whether it starts (+1) or ends (-1) a long poll, or neither (0).
func (ws *watchSet) touch(agent, nowMs int64, open int) {
	ws.mu.Lock()
	defer ws.mu.Unlock()
	if ws.open == nil {
		ws.open, ws.last = map[int64]int{}, map[int64]int64{}
	}
	ws.open[agent] += open
	if ws.open[agent] <= 0 {
		delete(ws.open, agent)
	}
	ws.last[agent] = nowMs
}

// connected reports whether the agent holds a long poll, or called its inbox within watchGrace.
func (ws *watchSet) connected(agent, nowMs int64) bool {
	ws.mu.Lock()
	defer ws.mu.Unlock()
	if ws.open[agent] > 0 {
		return true
	}
	last, ok := ws.last[agent]
	return ok && nowMs-last < watchGrace.Milliseconds()
}

// agentCalled is every inbox call of an agent: it counts as connected, and a stretch of not responding ends when it holds a watch.
func (s *Server) agentCalled(ctx context.Context, agent int64, open int) {
	s.watching.touch(agent, s.Clock.Now().UnixMilli(), open)
	if open > 0 {
		s.endStretch(ctx, agent)
	}
}

// endStretch closes the agent's stretch of not responding: the conversations it was noted in read their lines again. A failure is
// logged; the next ack or watch tries again.
func (s *Server) endStretch(ctx context.Context, agent int64) {
	open, err := plan.AnyNote(ctx, s.reader(), agent)
	if err != nil || !open {
		return
	}
	var convs []int64
	err = s.Store.Writer.Tx(ctx, func(ctx context.Context, tx *pdb.Tx) (err error) {
		convs, err = plan.EndStretch(ctx, tx.DBTX(), agent)
		return err
	})
	if err != nil {
		s.Log.Printf("plan: end stretch: %v", err)
		return
	}
	for _, c := range convs {
		s.publishPlan(c)
	}
}

// publishPlan tells the readers of a conversation to read its plans again.
func (s *Server) publishPlan(conv int64) {
	s.Bus.Publish(platform.Frame{Event: "plan.changed", Data: planFrame(conv), Conversation: conv})
}

// sweepPlans runs the plan jobs that follow the clock: it nudges the agents whose plan is overdue (one status_due item per nudge, at
// most plan.MaxNudges per miss, plan.NudgeEvery apart; never a push), and writes the quiet note of an agent that stopped responding
// (msg 281). It writes only when something is due. The timers call it, and every inbox call, so an agent that polls hears at once.
func (s *Server) sweepPlans(ctx context.Context) error {
	if err := s.nudgeLate(ctx); err != nil {
		return err
	}
	return s.noteUnresponsive(ctx)
}

func (s *Server) nudgeLate(ctx context.Context) error {
	d, now := s.reader(), s.Clock.Now()
	nowMs := now.UnixMilli()
	plans, err := plan.All(ctx, d)
	if err != nil {
		return err
	}
	statuses, err := identity.Statuses(ctx, d)
	if err != nil {
		return err
	}
	for _, p := range plans {
		anchor := max(p.UpdatedAt, statuses[p.Agent].UpdatedAt)
		if !p.NudgeDue(anchor, nowMs) {
			continue
		}
		nudged := false
		err := s.Store.Writer.Tx(ctx, func(ctx context.Context, tx *pdb.Tx) error {
			d := tx.DBTX()
			p, err := plan.Get(ctx, d, p.Agent, p.Conversation) // again, inside the one writer: two sweeps never nudge twice
			if err != nil || !p.NudgeDue(anchor, nowMs) {
				return err
			}
			if member, err := isMember(ctx, d, p.Conversation, p.Agent); err != nil || !member {
				return err
			}
			if open, err := inbox.HasStatusDue(ctx, d, p.Agent, p.Conversation); err != nil || open {
				return err
			}
			seq, err := event.Write(ctx, d, now, event.Entry{Type: eventPlanNudged, Audience: p.Agent, Conversation: p.Conversation,
				Payload: map[string]any{"conversation_id": p.Conversation}})
			if err != nil {
				return err
			}
			if err := inbox.StatusDue(ctx, d, now, p.Agent, p.Conversation, seq); err != nil {
				return err
			}
			nudged = true
			return plan.RecordNudge(ctx, d, p, anchor, nowMs)
		})
		if err != nil {
			return err
		}
		if nudged {
			s.Bus.Notify(p.Agent)
			s.publishPlan(p.Conversation) // the line turns Late now, not at the owner's next read
		}
	}
	return nil
}

func (s *Server) noteUnresponsive(ctx context.Context) error {
	d, now := s.reader(), s.Clock.Now()
	nowMs := now.UnixMilli()
	waiting, err := inbox.Unanswered(ctx, d)
	if err != nil {
		return err
	}
	for _, u := range waiting {
		if nowMs < u.Since+plan.NotRespondingAfter.Milliseconds() || s.watching.connected(u.Identity, nowMs) {
			continue
		}
		if noted, err := plan.HasNote(ctx, d, u.Identity, u.Conversation); err != nil || noted {
			if err != nil {
				return err
			}
			continue
		}
		live, err := auth.LiveSessionCount(ctx, d, u.Identity, now)
		if err != nil {
			return err
		}
		liveness := plan.Liveness(u.Since, false, live > 0, nowMs)
		wrote := false
		err = s.Store.Writer.Tx(ctx, func(ctx context.Context, tx *pdb.Tx) error {
			d := tx.DBTX()
			if noted, err := plan.HasNote(ctx, d, u.Identity, u.Conversation); err != nil || noted {
				return err
			}
			line := message.SystemLine{T: "agent.unresponsive", Identity: u.Identity, Liveness: liveness}
			if _, _, err := sayLine(ctx, d, now, 0, u.Conversation, line); err != nil {
				return err
			}
			wrote = true
			return plan.Noted(ctx, d, now, u.Identity, u.Conversation)
		})
		if err != nil {
			return err
		}
		if wrote {
			s.Bus.Notify()
			s.publishPlan(u.Conversation)
		}
	}
	return nil
}

// isMember reports whether the identity is an active participant of the conversation.
func isMember(ctx context.Context, d pdb.DBTX, conv, who int64) (bool, error) {
	parts, err := conversation.Participants(ctx, d, conv)
	return slices.ContainsFunc(parts, func(p conversation.Participant) bool { return p.IdentityID == who }), err
}
