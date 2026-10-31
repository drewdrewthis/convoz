package httpapi

// Fresh plans without the owner asking (owner, conv 179 msg 10021: "I feel like I shouldn't have to ask for updates all the time...").
// Two triggers ask the agent itself through its inbox, as nudgeLate and nudgeDeliveries do: an agent at work in a conversation whose
// plan there is plan.BehindAfter old (or missing after that long at work), and a plan whose delivery shows At risk because it had no update for a day. Both
// hold while an ask is open and rest after any plan ask in the conversation.

import (
	"context"
	"errors"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/event"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/identity"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/inbox"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/message"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/plan"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// askIfBehind runs after an agent's post is stored and asks the agent to update its plan when it is behind (planBehind). A failure
// is logged, never the post's.
func (s *Server) askIfBehind(ctx context.Context, agent, conv int64) {
	if behind, err := planBehind(ctx, s.reader(), s.Clock.Now(), agent, conv); err != nil || !behind { // the common case never writes
		s.logAskErr(ctx, err)
		return
	}
	asked := false
	err := s.Store.Writer.Tx(ctx, func(ctx context.Context, tx *pdb.Tx) error {
		d, now := tx.DBTX(), s.Clock.Now()
		behind, err := planBehind(ctx, d, now, agent, conv) // again, inside the one writer
		if err != nil || !behind {
			return err
		}
		asked, err = askPlan(ctx, d, now, agent, conv, plan.AskRest)
		return err
	})
	s.logAskErr(ctx, err)
	if asked {
		s.Bus.Notify(agent)
	}
}

// planBehind reports whether an agent is at work in the conversation with a plan that is behind (a plan with nothing in Now, or one that
// waits on the owner or is blocked, never is: it waits on someone else or is finished): plan.ActivePosts posts there within
// plan.AskRest, all after its plan's update, while that update is plan.BehindAfter old. With no plan, the owner must have written in the conversation within plan.HumanWithin, and the age runs from the first of
// those posts: an agent that just joined and answers a few questions is not behind yet.
func planBehind(ctx context.Context, d pdb.DBTX, now time.Time, agent, conv int64) (bool, error) {
	nowMs, behind := now.UnixMilli(), plan.BehindAfter.Milliseconds()
	since, noPlan := int64(0), false
	p, err := plan.Get(ctx, d, agent, conv)
	switch {
	case err == nil:
		if len(p.Now) == 0 || len(p.Waiting) > 0 || p.Blocked != "" { // done, or waiting on someone else, or blocked: nothing is behind
			return false, nil
		}
		if since = p.UpdatedAt; nowMs-since < behind {
			return false, nil
		}
	case !errors.Is(err, plan.ErrNotFound):
		return false, err
	default: // no plan: only where the work is for a person (a feed of one-line posts that no one wrote in is not asked)
		noPlan = true
		owner, err := identity.Owner(ctx, d)
		if err != nil {
			return false, err
		}
		if asked, err := message.PostedSince(ctx, d, owner.ID, conv, now.Add(-plan.HumanWithin).UnixMilli()); err != nil || !asked {
			return false, err
		}
	}
	posts, first, err := message.RecentPosts(ctx, d, agent, conv, max(since, now.Add(-plan.AskRest).UnixMilli()), noPlan) // thread replies count toward a late plan, not toward asking for a first one
	if err != nil || posts < plan.ActivePosts {
		return false, err
	}
	if since == 0 {
		since = first
	}
	return nowMs-since >= behind, nil
}

func (s *Server) logAskErr(ctx context.Context, err error) {
	if err != nil && ctx.Err() == nil {
		s.Log.Printf("plan: ask an agent at work: %v", err)
	}
}

// nudgeAtRisk asks the agent of each plan whose delivery shows At risk for want of an update (plan.Plan.QuietAtRisk), at most once
// per plan.DeliveryStaleAfter.
func (s *Server) nudgeAtRisk(ctx context.Context) error {
	nowMs := s.Clock.Now().UnixMilli()
	plans, err := plan.All(ctx, s.reader())
	if err != nil {
		return err
	}
	for _, p := range plans {
		if !p.QuietAtRisk(nowMs) {
			continue
		}
		asked := false
		err := s.Store.Writer.Tx(ctx, func(ctx context.Context, tx *pdb.Tx) error {
			d, now := tx.DBTX(), s.Clock.Now()
			p, err := plan.Get(ctx, d, p.Agent, p.Conversation) // again, inside the one writer: two sweeps never ask twice
			if err != nil || !p.QuietAtRisk(now.UnixMilli()) {
				return ignoreNotFound(err)
			}
			if member, err := isMember(ctx, d, p.Conversation, p.Agent); err != nil || !member {
				return err
			}
			asked, err = askPlan(ctx, d, now, p.Agent, p.Conversation, plan.DeliveryStaleAfter)
			return err
		})
		if err != nil {
			return err
		}
		if asked {
			s.Bus.Notify(p.Agent)
		}
	}
	return nil
}

// askPlan writes one status_due ask about the plan (a plan.nudged event, so its text is the plan ask), unless an ask is still open
// or the last one in the conversation is younger than rest. It reports whether it asked; the caller wakes the agent.
func askPlan(ctx context.Context, d pdb.DBTX, now time.Time, agent, conv int64, rest time.Duration) (bool, error) {
	if open, err := inbox.HasStatusDue(ctx, d, agent, conv); err != nil || open {
		return false, err
	}
	last, err := inbox.LastStatusDueAt(ctx, d, agent, conv)
	if err != nil || now.UnixMilli()-last < rest.Milliseconds() {
		return false, err
	}
	seq, err := event.Write(ctx, d, now, event.Entry{Type: eventPlanNudged, Audience: agent, Conversation: conv, Payload: map[string]any{"conversation_id": conv}})
	if err != nil {
		return false, err
	}
	return true, inbox.StatusDue(ctx, d, now, agent, conv, seq)
}

// nudgeQuietWaits asks the agent of each plan whose wait on the owner is stale (plan.Plan.WaitStale): the wait left his feed, so the
// agent refreshes or ends it. At most once per plan.WaitStaleAfter.
func (s *Server) nudgeQuietWaits(ctx context.Context) error {
	plans, err := plan.All(ctx, s.reader())
	if err != nil {
		return err
	}
	for _, p := range plans {
		if !p.WaitStale(s.Clock.Now()) {
			continue
		}
		asked := false
		err := s.Store.Writer.Tx(ctx, func(ctx context.Context, tx *pdb.Tx) error {
			d, now := tx.DBTX(), s.Clock.Now()
			p, err := plan.Get(ctx, d, p.Agent, p.Conversation) // again, inside the one writer: two sweeps never ask twice
			if err != nil || !p.WaitStale(now) {
				return ignoreNotFound(err)
			}
			if member, err := isMember(ctx, d, p.Conversation, p.Agent); err != nil || !member {
				return err
			}
			asked, err = askPlan(ctx, d, now, p.Agent, p.Conversation, plan.WaitStaleAfter)
			return err
		})
		if err != nil {
			return err
		}
		if asked {
			s.Bus.Notify(p.Agent)
		}
	}
	return nil
}
