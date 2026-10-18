package httpapi

import (
	"context"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/authz"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/conversation"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/prefs"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

// The versioned names of the events of the prefs and status work.
const (
	eventPrefsChanged  = "prefs.changed.v1"
	eventPinChanged    = "pin.changed.v1"
	eventStatusChanged = "agent.status_changed.v1"
)

// railList is the conversations of the caller's rail: the owner's are all of them, anyone else's the ones they are in.
func railList(ctx context.Context, d pdb.DBTX, p authz.Principal) ([]conversation.Conversation, error) {
	if p.Role == "owner" {
		return conversation.ListAll(ctx, d)
	}
	return conversation.ListOf(ctx, d, p.Identity())
}

// railSection is the rows of one section (Starred or not) of a person's rail, in rail order.
func railSection(list []conversation.Conversation, all map[int64]prefs.Pref, starred bool) []prefs.Row {
	var rows []prefs.Row
	for _, cv := range list {
		if pf := all[cv.ID]; pf.Starred == starred {
			rows = append(rows, prefs.Row{ID: cv.ID, Rank: pf.RankOf(cv.CreatedAt)})
		}
	}
	prefs.Order(rows)
	return rows
}

// withRail fills in what the caller's own prefs say about the rows (star, rank, mute) with one read. An agent's rows keep the
// defaults: prefs are personal (I-22) and an agent has none.
func (s *Server) withRail(ctx context.Context, d pdb.DBTX, p authz.Principal, views ...*wire.Conversation) error {
	if p.SessionID != 0 || len(views) == 0 {
		return nil
	}
	all, err := prefs.All(ctx, d, p.Identity())
	if err != nil {
		return err
	}
	for _, v := range views {
		pf := all[v.ID]
		v.Starred = pf.Starred
		v.Rank = pf.RankOf(v.CreatedAt)
		if pf.MutedUntil != 0 {
			v.MutedUntil = ptr(pf.MutedUntil)
		}
	}
	return nil
}
