package httpapi

import (
	"context"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/authz"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/conversation"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/prefs"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/readstate"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

// detailView is the list row of a conversation plus what the details panel shows: who started it, the linked pull
// request, whether the caller muted it, and the adds that wait for a human.
func detailView(ctx context.Context, d pdb.DBTX, p authz.Principal, dir directory, cv conversation.Conversation, floor int64, now time.Time) (wire.Conversation, error) {
	out, err := conversationView(ctx, d, p, dir, cv, floor, now)
	if err != nil {
		return wire.Conversation{}, err
	}
	started := dir.person(cv.CreatedBy)
	out.StartedBy = &started
	if cv.LinkURL != "" {
		out.LinkURL = ptr(cv.LinkURL)
	}
	if p.SessionID == 0 {
		pf, err := prefs.OfConversation(ctx, d, p.Identity(), cv.ID)
		if err != nil {
			return wire.Conversation{}, err
		}
		if pf.MutedUntil != 0 {
			out.MutedUntil = ptr(pf.MutedUntil)
		}
	}
	if _, out.Seen, err = seenIn(ctx, d, dir, cv.ID, 0); err != nil {
		return wire.Conversation{}, err
	}
	if cursor, found, err := readstate.Cursor(ctx, d, p.Identity(), cv.ID); err != nil {
		return wire.Conversation{}, err
	} else if found {
		out.LastRead = ptr(cursor)
	}
	waiting, err := conversation.Pending(ctx, d, cv.ID)
	if err != nil {
		return wire.Conversation{}, err
	}
	for _, seat := range waiting {
		add := wire.PendingAdd{Person: dir.person(seat.IdentityID), At: seat.StatusAt}
		if seat.RequestedBy != 0 {
			add.RequestedBy = ptr(dir.person(seat.RequestedBy))
		}
		out.Pending = append(out.Pending, add)
	}
	return out, nil
}
