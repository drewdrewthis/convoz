package httpapi

import (
	"context"
	"encoding/json"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/conversation"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/event"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/message"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// Event types the conversation routes write (thin: ids and enums only, I-23). The stream skips types it does not carry.
const (
	eventParticipantChanged  = "participant.changed.v1"
	eventConversationChanged = "conversation.changed.v1"
)

// sayLine writes a line the conversation says about itself, moves the conversation up the list and records the
// thin event that makes the stream send it. kind and ids go to the line's system JSON. It returns the line's id and
// the event's seq.
func sayLine(ctx context.Context, d pdb.DBTX, now time.Time, actor, conv int64, words, kind string, ids map[string]int64) (lineID, seq int64, err error) {
	raw, err := json.Marshal(struct {
		Type string           `json:"type"`
		IDs  map[string]int64 `json:"ids,omitempty"`
	}{kind, ids})
	if err != nil {
		return 0, 0, err
	}
	if lineID, err = message.AddSystemLine(ctx, d, now, conv, words, string(raw)); err != nil {
		return 0, 0, err
	}
	if err = conversation.Touch(ctx, d, now, conv); err != nil {
		return 0, 0, err
	}
	seq, err = event.Write(ctx, d, now, event.Entry{
		Type: event.MessageCreated, Actor: actor, Conversation: conv, Message: lineID,
		Payload: map[string]any{"id": lineID, "kind": "system", "conversation_id": conv},
	})
	return lineID, seq, err
}

// journalChange records that someone's standing in a conversation changed.
func journalChange(ctx context.Context, d pdb.DBTX, now time.Time, actor, conv, who int64, status string) (int64, error) {
	return event.Write(ctx, d, now, event.Entry{
		Type: eventParticipantChanged, Actor: actor, Conversation: conv,
		Payload: map[string]any{"conversation_id": conv, "identity_id": who, "status": status},
	})
}
