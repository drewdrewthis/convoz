package httpapi

import (
	"context"
	"encoding/json"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/event"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/identity"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/prefs"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

func init() {
	frameHydrators[eventPrefsChanged] = hydratePrefs
	frameHydrators[eventPinChanged] = hydratePin
	frameHydrators[eventStatusChanged] = hydrateStatus
}

// hydratePrefs sends the person's own prefs change to their devices, with the ranks of the section the row is in now, so a second
// device redraws the rail without asking.
func hydratePrefs(ctx context.Context, s *Server, c *call, _ directory, ev event.Event) (string, []byte, error) {
	const name = "prefs.changed"
	if ev.Audience != c.p.Identity() || c.p.SessionID != 0 {
		return name, nil, nil
	}
	d := s.reader()
	list, err := railList(ctx, d, c.p)
	if err != nil {
		return name, nil, err
	}
	all, err := prefs.All(ctx, d, c.p.Identity())
	if err != nil {
		return name, nil, err
	}
	cur := all[ev.Conversation]
	out := wire.PrefsResult{ConversationID: ev.Conversation, Starred: cur.Starred, Ranks: []wire.Rail{}}
	if cur.MutedUntil != 0 {
		out.MutedUntil = ptr(cur.MutedUntil)
	}
	for _, row := range railSection(list, all, cur.Starred) {
		out.Ranks = append(out.Ranks, wire.Rail{ID: row.ID, Rank: row.Rank})
	}
	data, err := json.Marshal(out)
	return name, data, err
}

// hydratePin tells the person's own devices a message was pinned or unpinned.
func hydratePin(_ context.Context, _ *Server, c *call, _ directory, ev event.Event) (string, []byte, error) {
	const name = "pin.changed"
	if ev.Audience != c.p.Identity() || c.p.SessionID != 0 {
		return name, nil, nil
	}
	var p struct {
		Pinned bool `json:"pinned"`
	}
	_ = json.Unmarshal([]byte(ev.Payload), &p)
	data, err := json.Marshal(map[string]any{"conversation_id": ev.Conversation, "message_id": ev.Message, "pinned": p.Pinned})
	return name, data, err
}

// hydrateStatus reads the agent's status as it is now, for the owner's devices only.
func hydrateStatus(ctx context.Context, s *Server, c *call, dir directory, ev event.Event) (string, []byte, error) {
	const name = "agent.status_changed"
	if c.p.SessionID != 0 || c.p.Role != "owner" {
		return name, nil, nil
	}
	st, _, err := identity.StatusOf(ctx, s.reader(), ev.Actor)
	if err != nil {
		return name, nil, err
	}
	data, err := json.Marshal(map[string]any{
		"identity_id": ev.Actor, "handle": dir[ev.Actor].Handle, "state": st.State, "doing": st.Doing, "next": st.Next, "since": st.Since, "updated_at": st.UpdatedAt,
	})
	return name, data, err
}
