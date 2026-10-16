package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"mime"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/conversation"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/event"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/message"
)

// Stream rules (design §13, §5.4).
const (
	heartbeatEvery   = 15 * time.Second
	maxStreamsDevice = 3   // a fourth stream from one device closes the oldest: iOS leaves dead ones behind
	replayBatch      = 500 // events read per round
)

// streamSet tracks the open streams of each device so the oldest can be closed when a device opens too many.
type streamSet struct {
	mu     sync.Mutex
	byDev  map[int64][]*openStream
	nextID int
}

type openStream struct {
	id     int
	cancel context.CancelFunc
}

// add registers a stream of device and closes the oldest ones beyond the cap. The returned func unregisters it.
func (ss *streamSet) add(device int64, cancel context.CancelFunc) (remove func()) {
	ss.mu.Lock()
	defer ss.mu.Unlock()
	if ss.byDev == nil {
		ss.byDev = map[int64][]*openStream{}
	}
	ss.nextID++
	me := &openStream{id: ss.nextID, cancel: cancel}
	list := append(ss.byDev[device], me)
	for len(list) > maxStreamsDevice {
		list[0].cancel()
		list = list[1:]
	}
	ss.byDev[device] = list
	return func() {
		ss.mu.Lock()
		defer ss.mu.Unlock()
		kept := ss.byDev[device][:0]
		for _, o := range ss.byDev[device] {
			if o.id != me.id {
				kept = append(kept, o)
			}
		}
		if len(kept) == 0 {
			delete(ss.byDev, device)
		} else {
			ss.byDev[device] = kept
		}
	}
}

// stream is GET /api/stream: server-sent events for a signed-in person.
//
// Frames are `event: <type>`, `id: <epoch>:<seq>` and `data: <json>`, hydrated from state when sent: an event row
// holds ids only (I-23). `: hb` goes out every 15 s. Last-Event-ID resumes from the next seq; with none, the stream
// starts at the end of the log and the client reads the state it needs over the plain routes. Live frames such as
// "agent.working" have no id and are never replayed. A client that cannot keep up is cut off and reconnects.
func (s *Server) stream(w http.ResponseWriter, r *http.Request, c *call) {
	if !acceptsStream(r.Header.Get("Accept")) {
		writeErr(w, http.StatusNotAcceptable, "not_acceptable", "This route streams text/event-stream.")
		return
	}
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	defer s.streams.add(c.dev.ID, cancel)()
	sub := s.Bus.Subscribe()
	defer sub.Cancel()

	cursor, err := s.streamStart(ctx, r.Header.Get("Last-Event-ID"))
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	rc := http.NewResponseController(w)
	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-store, no-transform")
	h.Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	if _, err := fmt.Fprint(w, ": open\n\n"); err != nil || rc.Flush() != nil {
		return
	}
	tick := time.NewTicker(heartbeatEvery)
	defer tick.Stop()
	for {
		changed := s.Bus.Changed() // before the read, so a commit between the read and the wait still wakes us
		for {
			n, err := s.sendEvents(ctx, w, c, &cursor)
			if err != nil {
				return
			}
			if n < replayBatch {
				break
			}
		}
		if rc.Flush() != nil {
			return
		}
		select {
		case <-changed:
		case f, open := <-sub.C:
			if !open {
				return
			}
			if _, err := fmt.Fprintf(w, "event: %s\ndata: %s\n\n", f.Event, f.Data); err != nil || rc.Flush() != nil {
				return
			}
		case <-tick.C:
			if _, err := fmt.Fprint(w, ": hb\n\n"); err != nil || rc.Flush() != nil {
				return
			}
		case <-ctx.Done():
			return
		}
	}
}

// acceptsStream reports whether the Accept header asks for an event stream. A plain GET (no Accept) is refused
// so that nothing that walks the routes blocks on a stream that never ends.
func acceptsStream(accept string) bool {
	for _, part := range strings.Split(accept, ",") {
		if media, _, err := mime.ParseMediaType(strings.TrimSpace(part)); err == nil && media == "text/event-stream" {
			return true
		}
	}
	return false
}

// streamStart is the seq the stream continues after: the one in Last-Event-ID when it names this log, else the end of the log.
func (s *Server) streamStart(ctx context.Context, lastEventID string) (int64, error) {
	if epoch, seq, ok := strings.Cut(lastEventID, ":"); ok && epoch == event.Epoch {
		if n, err := strconv.ParseInt(seq, 10, 64); err == nil && n >= 0 {
			return n, nil
		}
	}
	return event.MaxSeq(ctx, s.reader())
}

// sendEvents writes the frames for the events after *cursor that the caller may see, and moves *cursor past all of
// them. It returns how many events it read.
func (s *Server) sendEvents(ctx context.Context, w http.ResponseWriter, c *call, cursor *int64) (int, error) {
	d := s.reader()
	events, err := event.Since(ctx, d, *cursor, replayBatch)
	if err != nil || len(events) == 0 {
		return 0, err
	}
	dir, err := loadDirectory(ctx, d)
	if err != nil {
		return 0, err
	}
	for _, ev := range events {
		*cursor = ev.Seq
		name, data, err := s.frameFor(ctx, c, dir, ev)
		if err != nil {
			return 0, err
		}
		if data == nil {
			continue
		}
		if _, err := fmt.Fprintf(w, "event: %s\nid: %s:%d\ndata: %s\n\n", name, event.Epoch, ev.Seq, data); err != nil {
			return 0, err
		}
	}
	return len(events), nil
}

// frameFor hydrates one event for the caller; data is nil for an event the stream does not carry or the caller may not see.
func (s *Server) frameFor(ctx context.Context, c *call, dir directory, ev event.Event) (name string, data []byte, err error) {
	d := s.reader()
	name = strings.TrimSuffix(ev.Type, event.Version)
	switch name {
	case "message.created":
		floor, visible, err := canSee(ctx, d, c.p, ev.Conversation)
		if err != nil || !visible {
			return name, nil, err
		}
		m, ok, err := message.Get(ctx, d, ev.Message)
		if err != nil || !ok || m.ID <= floor {
			return name, nil, err
		}
		wm := dir.message(m)
		data, err = json.Marshal(map[string]any{
			"id": wm.ID, "conversation_id": ev.Conversation, "author_handle": wm.Author.Handle, "author": wm.Author,
			"body": wm.Body, "format": wm.Format, "created_at": wm.CreatedAt,
		})
		return name, data, err
	case "read.moved":
		if ev.Audience != c.p.Identity() {
			return name, nil, nil
		}
		var p struct {
			MainID int64 `json:"main_id"`
		}
		_ = json.Unmarshal([]byte(ev.Payload), &p)
		data, err = json.Marshal(map[string]any{"conversation_id": ev.Conversation, "main_id": p.MainID})
		return name, data, err
	case "conversation.created":
		cv, ok, err := conversation.Get(ctx, d, ev.Conversation)
		if err != nil || !ok {
			return name, nil, err
		}
		floor, visible, err := canSee(ctx, d, c.p, ev.Conversation)
		if err != nil || !visible {
			return name, nil, err
		}
		v, err := conversationView(ctx, d, c.p, dir, cv, floor)
		if err != nil {
			return name, nil, err
		}
		data, err = json.Marshal(v)
		return name, data, err
	}
	return name, nil, nil
}
