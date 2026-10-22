package httpapi

import (
	"context"
	"encoding/json"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/event"
)

func init() {
	frameHydrators[eventConversationChanged] = hydrateConversationChanged
}

// hydrateConversationChanged tells the people who can see the conversation that its row changed (an agent marked it stale); the
// page reads the list again. Agents read conversations through their own routes, not the stream.
func hydrateConversationChanged(ctx context.Context, s *Server, c *call, _ directory, ev event.Event) (string, []byte, error) {
	const name = "conversation.changed"
	if ok, err := eventVisible(ctx, s.reader(), c, ev); err != nil || !ok {
		return name, nil, err
	}
	data, err := json.Marshal(map[string]int64{"conversation_id": ev.Conversation})
	return name, data, err
}
