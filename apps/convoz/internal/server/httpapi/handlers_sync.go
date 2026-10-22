package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"slices"
	"strconv"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/event"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// Sync rules (design §12.3, §13).
const (
	syncBatch   = 500 // events scanned per answer
	maxSyncWait = 25  // seconds a long poll is held: under common proxy and NAT idle limits
)

// syncEvent is one stored event as GET /api/sync returns it. Events are thin (I-23): ids and enums, never content.
type syncEvent struct {
	Seq          int64           `json:"seq"`
	Type         string          `json:"type"`
	Conversation int64           `json:"conversation_id,omitempty"`
	Message      int64           `json:"message_id,omitempty"`
	Payload      json.RawMessage `json:"payload"`
}

// eventVisible reports whether the caller may see the event: a conversation event by canSee and the visibility floor, an ask event by canSee and the floor (a snooze by its person alone), a read
// cursor move by its reader alone. An event of a type the chat does not show a person is not visible. The stream and the
// delta both ask this, so they cannot disagree.
func eventVisible(ctx context.Context, d pdb.DBTX, c *call, ev event.Event) (bool, error) {
	if slices.Contains(askEvents, ev.Type) {
		// The delta tells a client that an ask changed while its stream was down; the client reads the ask itself.
		if ev.Audience != 0 && ev.Audience != c.p.Identity() {
			return false, nil
		}
		floor, ok, err := canSee(ctx, d, c.p, ev.Conversation)
		return ok && ev.Message > floor, err
	}
	switch ev.Type {
	case eventPlanChanged:
		// A plan item may have started or stopped waiting on the owner while the stream was down; the client reads the plans itself.
		_, ok, err := canSee(ctx, d, c.p, ev.Conversation)
		return ok, err
	case event.MessageCreated:
		floor, ok, err := canSee(ctx, d, c.p, ev.Conversation)
		return ok && ev.Message > floor, err
	case event.ConversationCreated:
		_, ok, err := canSee(ctx, d, c.p, ev.Conversation)
		return ok, err
	case eventConversationChanged:
		// A row changed (an agent marked it stale): a person's client reads the list again. Agents read conversations themselves.
		if c.p.SessionID != 0 {
			return false, nil
		}
		_, ok, err := canSee(ctx, d, c.p, ev.Conversation)
		return ok, err
	case event.ReadMoved:
		return ev.Audience == c.p.Identity(), nil
	}
	return false, nil
}

// visibleSince reads the events after seq and keeps the ones the caller may see. scanned is the highest seq looked at, visible
// or not, so a caller whose newest events are not for it still moves forward; more says the scan stopped at its limit.
func visibleSince(ctx context.Context, d pdb.DBTX, c *call, seq int64) (events []syncEvent, scanned int64, more bool, err error) {
	raw, err := event.Since(ctx, d, seq, syncBatch)
	if err != nil {
		return nil, 0, false, err
	}
	scanned, events = seq, []syncEvent{}
	for _, ev := range raw {
		scanned = ev.Seq
		if ok, err := eventVisible(ctx, d, c, ev); err != nil {
			return nil, 0, false, err
		} else if ok {
			events = append(events, syncEvent{Seq: ev.Seq, Type: ev.Type, Conversation: ev.Conversation, Message: ev.Message, Payload: json.RawMessage(ev.Payload)})
		}
	}
	return events, scanned, len(raw) == syncBatch, nil
}

// syncDelta is GET /api/sync?cursor=<epoch>:<seq>&wait=<seconds>: the events after the cursor that the caller may see.
// With wait and nothing new it holds the request (the long-poll fallback of a stream that keeps failing) until a commit,
// the wait or the end of the caller's session. A cursor of another epoch, or ahead of the log (a restored copy), gets a
// reset: the client loads GET /api/sync/snapshot and reads its state again.
func (s *Server) syncDelta(w http.ResponseWriter, r *http.Request, c *call) {
	epoch, seq, ok := event.ParseCursor(r.URL.Query().Get("cursor"))
	if !ok {
		writeFieldErr(w, http.StatusBadRequest, "invalid_request", "cursor", "The cursor looks like 1:57.")
		return
	}
	wait := 0
	if raw := r.URL.Query().Get("wait"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 0 || n > maxSyncWait {
			writeFieldErr(w, http.StatusBadRequest, "invalid_request", "wait", "Wait is 0 to 25 seconds.")
			return
		}
		wait = n
	}
	ctx, d := r.Context(), s.reader()
	head, err := event.MaxSeq(ctx, d)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	if epoch != event.Epoch || seq > head {
		writeJSON(w, http.StatusOK, map[string]any{"reset": true, "reason": "epoch"})
		return
	}
	held := time.NewTimer(time.Duration(wait) * time.Second)
	defer held.Stop()
	for {
		changed := s.Bus.Changed() // before the read, so a commit between the read and the wait still wakes us
		events, scanned, more, err := visibleSince(ctx, d, c, seq)
		if err != nil {
			s.internalError(w, r, err)
			return
		}
		if len(events) > 0 || wait == 0 || !s.deviceLive(ctx, c) {
			writeJSON(w, http.StatusOK, map[string]any{"cursor": event.FormatCursor(scanned), "events": events, "more": more})
			return
		}
		seq = scanned // the events scanned and skipped are not read again on the next wake
		select {
		case <-changed:
		case <-held.C:
			writeJSON(w, http.StatusOK, map[string]any{"cursor": event.FormatCursor(seq), "events": events, "more": false})
			return
		case <-ctx.Done():
			return
		}
	}
}

// syncSnapshot is GET /api/sync/snapshot: where the log stands now. A client that was reset reads its state over the plain
// routes after this, so whatever it reads is at least as new as the cursor, and continues from it.
func (s *Server) syncSnapshot(w http.ResponseWriter, r *http.Request, _ *call) {
	head, err := event.MaxSeq(r.Context(), s.reader())
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"epoch": event.Epoch, "as_of_seq": head, "cursor": event.FormatCursor(head)})
}

// ping is GET /api/ping: the smallest answer there is, for a client to time the link.
func (s *Server) ping(w http.ResponseWriter, _ *http.Request, _ *call) {
	writeJSON(w, http.StatusOK, map[string]int64{"t": s.Clock.Now().UnixMilli()})
}
