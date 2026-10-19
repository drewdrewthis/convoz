package httpapi

import (
	"context"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/event"
)

func init() {
	frameHydrators[eventPlanChanged] = hydratePlan
}

// hydratePlan tells the people who can see the conversation that a plan in it changed; the page reads the plans again. Agents read
// plans through their own routes, not the stream.
func hydratePlan(ctx context.Context, s *Server, c *call, _ directory, ev event.Event) (string, []byte, error) {
	const name = "plan.changed"
	if c.p.SessionID != 0 {
		return name, nil, nil
	}
	if _, visible, err := canSee(ctx, s.reader(), c.p, ev.Conversation); err != nil || !visible {
		return name, nil, err
	}
	return name, planFrame(ev.Conversation), nil
}
