package httpapi

import (
	"context"
	"encoding/json"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/ask"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/event"
)

// The frame an ask event becomes: the ask as the reader sees it now, named ask.changed. A snooze event reaches only the
// person who snoozed.
const askFrame = "ask.changed"

var askEvents = []string{ask.EventCreated, ask.EventAnswered, ask.EventDismissed, ask.EventReopened, ask.EventClosed, ask.EventAcked,
	ask.EventSnoozed, ask.EventUnsnoozed, ask.EventWoke}

func init() {
	for _, t := range askEvents {
		frameHydrators[t] = hydrateAsk
	}
}

// hydrateAsk reads the ask as it is now (an event holds ids only, I-23) for a reader who may see its conversation.
func hydrateAsk(ctx context.Context, s *Server, c *call, dir directory, ev event.Event) (string, []byte, error) {
	if ev.Audience != 0 && ev.Audience != c.p.Identity() {
		return askFrame, nil, nil
	}
	d := s.reader()
	floor, visible, err := canSee(ctx, d, c.p, ev.Conversation)
	if err != nil || !visible || ev.Message <= floor {
		return askFrame, nil, err
	}
	a, err := ask.Get(ctx, d, ev.Message)
	if err == ask.ErrNotFound {
		return askFrame, nil, nil
	}
	if err != nil {
		return askFrame, nil, err
	}
	v, err := s.oneAskView(ctx, d, dir, a, personOf(c), s.Clock.Now())
	if err != nil {
		return askFrame, nil, err
	}
	data, err := json.Marshal(v)
	return askFrame, data, err
}
