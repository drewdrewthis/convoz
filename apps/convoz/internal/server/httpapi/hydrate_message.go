package httpapi

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/ask"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/event"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/message"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

// hydrator turns the thin event of one type into the frame a reader gets, or nil data for a reader who may not see it.
type hydrator func(ctx context.Context, s *Server, c *call, dir directory, ev event.Event) (name string, data []byte, err error)

// frameHydrators are the hydrators of the modules that own an event type, by full event name. The stream asks this table
// first, so a module adds its frames here and never edits the stream.
var frameHydrators = map[string]hydrator{
	event.MessageCreated: hydrateMessage("message.created"),
	eventEdited:          hydrateMessage("message.edited"),
	eventDeleted:         hydrateMessage("message.deleted"),
	eventPurged:          hydrateMessage("message.purged"),
	eventThreadUpdated:   hydrateThread,
	eventTranscribed:     hydrateMessage("upload.transcribed"),
}

// messageFrame is a message with the conversation it is in, as every message frame carries it.
type messageFrame struct {
	wire.Message
	ConversationID int64  `json:"conversation_id"`
	AuthorHandle   string `json:"author_handle"`
}

// hydrateMessage reads the message as it is now: an edited one with its new text, a deleted or purged one as a tombstone with
// no body (E-16), whatever the event said at the time (an event holds ids only, I-23).
func hydrateMessage(name string) hydrator {
	return func(ctx context.Context, s *Server, c *call, dir directory, ev event.Event) (string, []byte, error) {
		d := s.reader()
		floor, visible, err := canSee(ctx, d, c.p, ev.Conversation)
		if err != nil || !visible {
			return name, nil, err
		}
		m, ok, err := message.GetAny(ctx, d, ev.Message)
		if err != nil || !ok || m.ID <= floor {
			return name, nil, err
		}
		v := viewMessage(dir, m)
		if m.Kind == "ask" { // the card needs its options as soon as the message shows
			a, err := ask.Get(ctx, d, m.ID)
			if err != nil && !errors.Is(err, ask.ErrNotFound) {
				return name, nil, err
			}
			if err == nil {
				base, err := dir.askWithReply(ctx, d, a)
				if err != nil {
					return name, nil, err
				}
				base.App = v.App
				v.AttachAsk(base)
			}
		}
		if err := attachUploads(ctx, d, []*wire.Message{&v}); err != nil {
			return name, nil, err
		}
		if err := attachLastReplies(ctx, d, dir, c.p, ev.Conversation, []*wire.Message{&v}); err != nil {
			return name, nil, err
		}
		data, err := json.Marshal(messageFrame{Message: v, ConversationID: ev.Conversation, AuthorHandle: v.Author.Handle})
		return name, data, err
	}
}

// hydrateThread tells a reader how many replies a thread root has now and when the newest came.
func hydrateThread(ctx context.Context, s *Server, c *call, dir directory, ev event.Event) (string, []byte, error) {
	if _, visible, err := canSee(ctx, s.reader(), c.p, ev.Conversation); err != nil || !visible {
		return "thread.updated", nil, err
	}
	var p struct {
		RootID      int64 `json:"root_id"`
		ReplyCount  int64 `json:"reply_count"`
		LastReplyID int64 `json:"last_reply_id"`
	}
	_ = json.Unmarshal([]byte(ev.Payload), &p)
	frame := map[string]any{"conversation_id": ev.Conversation, "root_id": p.RootID, "reply_count": p.ReplyCount, "last_reply_id": p.LastReplyID}
	if root, ok, err := message.Get(ctx, s.reader(), p.RootID); err != nil {
		return "thread.updated", nil, err
	} else if ok {
		frame["last_reply_at"] = root.LastReplyAt
	}
	if lr, err := lastReplyOf(ctx, s.reader(), dir, c.p, ev.Conversation, p.RootID); err != nil {
		return "thread.updated", nil, err
	} else if lr != nil {
		frame["last_reply"] = lr
	}
	data, err := json.Marshal(frame)
	return "thread.updated", data, err
}
