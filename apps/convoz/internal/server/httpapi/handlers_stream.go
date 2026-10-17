package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"mime"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/auth"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/conversation"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/event"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/message"
)

// Stream rules (design §13, §5.4).
const (
	heartbeatEvery   = 15 * time.Second
	maxStreamsDevice = 3   // a fourth stream from one device closes the oldest: iOS leaves dead ones behind
	replayBatch      = 500 // events read per round
	// maxBacklog is how many events a live stream may have waiting before it is told to start over: a reader that stopped
	// reading holds the writer, and the events pile up behind it (design §5.3 backpressure). The same bound is the
	// buffer of the live-only frames on the bus (platform.frameBuffer).
	maxBacklog = 256
	// writeLimit is how long one write may take before the stream is given up as dead. The next heartbeat is 15 s away, so a
	// healthy but slow link is not cut by it.
	writeLimit = 45 * time.Second
	// reconnectHint is the EventSource retry the stream asks for, in milliseconds.
	reconnectHint = 1000
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

// cancelDevice closes every open stream of device: its session ended.
func (ss *streamSet) cancelDevice(device int64) {
	ss.mu.Lock()
	defer ss.mu.Unlock()
	for _, o := range ss.byDev[device] {
		o.cancel()
	}
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
// holds ids only (I-23). Each frame's data also names `prev_seq_for_you`, the seq of the frame sent before it on this
// stream (or where the stream resumed), so a client that holds frame n+1 and not n knows it missed something.
// `: hb` goes out every 15 s. Last-Event-ID resumes from the next seq; with none, the stream starts at the end of the
// log and the client reads the state it needs over the plain routes. Live frames such as "agent.working" have no id and
// are never replayed, and reach only a reader who may see their conversation.
//
// A client that cannot keep up gets `reset` with reason "slow" and the stream ends: when more than maxBacklog events wait
// behind a writer that stopped, or its live frames overflowed their buffer. The client loads a snapshot and starts again.
//
// The stream ends when the device session does: it is checked again on every wake, every live frame and every
// heartbeat, and logout or deleting the device closes the device's streams at once. After that no body is written.
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
	out := sseOut{w: w, rc: http.NewResponseController(w), now: s.Clock.Now}
	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-store, no-transform")
	h.Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	if out.write("retry: %d\n: open\n\n", reconnectHint) != nil {
		return
	}
	tick := time.NewTicker(s.heartbeat)
	defer tick.Stop()
	prev, live := cursor, false // live: the first catch-up is done, so a growing backlog now means a reader that stopped
	for {
		changed := s.Bus.Changed() // before the read, so a commit between the read and the wait still wakes us
		if !s.deviceLive(ctx, c) {
			return
		}
		for {
			if live && s.behind(ctx, cursor) > maxBacklog {
				_ = out.reset("slow")
				return
			}
			n, err := s.sendEvents(ctx, out, c, &cursor, &prev)
			if err != nil {
				return
			}
			if n < replayBatch {
				break
			}
		}
		live = true
		select {
		case <-changed:
		case f, open := <-sub.C:
			if !open {
				_ = out.reset("slow") // the bus closes a subscriber that fell behind its buffer
				return
			}
			if !s.deviceLive(ctx, c) {
				return
			}
			if f.Conversation == 0 {
				continue // fail closed: a frame must name its conversation
			}
			if _, visible, err := canSee(ctx, s.reader(), c.p, f.Conversation); err != nil {
				return
			} else if !visible {
				continue
			}
			if out.write("event: %s\ndata: %s\n\n", f.Event, f.Data) != nil {
				return
			}
		case <-tick.C:
			if !s.deviceLive(ctx, c) {
				return
			}
			if out.write(": hb\n\n") != nil {
				return
			}
		case <-ctx.Done():
			return
		}
	}
}

// sseOut writes one stream. Every write has a deadline, so a client that never reads cannot hold the handler for ever.
type sseOut struct {
	w   http.ResponseWriter
	rc  *http.ResponseController
	now func() time.Time
}

// write sends one piece of the stream and flushes it.
func (o sseOut) write(format string, args ...any) error {
	_ = o.rc.SetWriteDeadline(o.now().Add(writeLimit)) // a writer with no deadlines simply has no limit
	if _, err := fmt.Fprintf(o.w, format, args...); err != nil {
		return err
	}
	return o.rc.Flush()
}

// reset tells the client to drop what it holds of the stream and load a snapshot.
func (o sseOut) reset(reason string) error {
	return o.write("event: reset\ndata: {\"reason\":%q}\n\n", reason)
}

// behind is how many events were written after the stream's cursor; a failed read counts as none, the next wake asks again.
func (s *Server) behind(ctx context.Context, cursor int64) int64 {
	head, err := event.MaxSeq(ctx, s.reader())
	if err != nil {
		return 0
	}
	return head - cursor
}

// deviceLive reports whether the device session behind the stream still works. A read that fails counts as no:
// the client reconnects and is told then.
func (s *Server) deviceLive(ctx context.Context, c *call) bool {
	_, ok, err := auth.LookupDevice(ctx, s.reader(), c.token, s.Clock.Now())
	return err == nil && ok
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
	if epoch, seq, ok := event.ParseCursor(lastEventID); ok && epoch == event.Epoch {
		return seq, nil
	}
	return event.MaxSeq(ctx, s.reader())
}

// sendEvents writes the frames for the events after *cursor that the caller may see, and moves *cursor past all of
// them. *prev is the seq of the last frame written (each frame names it). It returns how many events it read.
func (s *Server) sendEvents(ctx context.Context, out sseOut, c *call, cursor, prev *int64) (int, error) {
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
		if err := out.write("event: %s\nid: %s\ndata: %s\n\n", name, event.FormatCursor(ev.Seq), withPrev(data, *prev)); err != nil {
			return 0, err
		}
		*prev = ev.Seq
	}
	return len(events), nil
}

// withPrev adds `prev_seq_for_you` to the JSON object a frame carries.
func withPrev(object []byte, prev int64) []byte {
	return fmt.Appendf(object[:len(object)-1:len(object)-1], `,"prev_seq_for_you":%d}`, prev)
}

// frameFor hydrates one event for the caller; data is nil for an event the stream does not carry or the caller may not see.
func (s *Server) frameFor(ctx context.Context, c *call, dir directory, ev event.Event) (name string, data []byte, err error) {
	d := s.reader()
	switch ev.Type {
	case event.MessageCreated:
		name = "message.created"
	case event.ReadMoved:
		name = "read.moved"
	case event.ConversationCreated:
		name = "conversation.created"
	default:
		return "", nil, nil
	}
	if ok, err := eventVisible(ctx, d, c, ev); err != nil || !ok {
		return name, nil, err
	}
	switch ev.Type {
	case event.MessageCreated:
		m, ok, err := message.Get(ctx, d, ev.Message)
		if err != nil || !ok {
			return name, nil, err
		}
		wm := dir.message(m)
		data, err = json.Marshal(map[string]any{
			"id": wm.ID, "conversation_id": ev.Conversation, "author_handle": wm.Author.Handle, "author": wm.Author,
			"body": wm.Body, "format": wm.Format, "created_at": wm.CreatedAt,
		})
		return name, data, err
	case event.ReadMoved:
		var p struct {
			MainID int64 `json:"main_id"`
		}
		_ = json.Unmarshal([]byte(ev.Payload), &p)
		data, err = json.Marshal(map[string]any{"conversation_id": ev.Conversation, "main_id": p.MainID})
		return name, data, err
	default: // event.ConversationCreated
		cv, ok, err := conversation.Get(ctx, d, ev.Conversation)
		if err != nil || !ok {
			return name, nil, err
		}
		floor, _, err := canSee(ctx, d, c.p, ev.Conversation)
		if err != nil {
			return name, nil, err
		}
		v, err := conversationView(ctx, d, c.p, dir, cv, floor)
		if err != nil {
			return name, nil, err
		}
		data, err = json.Marshal(v)
		return name, data, err
	}
}
