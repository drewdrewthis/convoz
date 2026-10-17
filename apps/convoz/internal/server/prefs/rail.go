package prefs

import (
	"context"
	"database/sql"
	"errors"
	"slices"
	"time"

	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/prefs/db"
)

// Forever is muted_until for a mute with no end.
const Forever int64 = 253402300799000

// renormStep spaces the ranks of a renormalized section, so many drags fit before the next one.
const renormStep = 1000.0

// ErrNotInSection means a placement named a neighbour that is not in the section.
var ErrNotInSection = errors.New("that conversation is not in the section")

// Pref is one person's stored prefs of one conversation. Rank is nil until a star or a drag sets it (I-21).
type Pref struct {
	Starred    bool
	Rank       *float64
	MutedUntil int64 // epoch ms; 0 for not muted
}

// RankOf is the sort key of a conversation with these prefs: coalesce(rail_rank, created_at).
func (p Pref) RankOf(createdAt int64) float64 {
	if p.Rank != nil {
		return *p.Rank
	}
	return float64(createdAt)
}

// All reads the person's prefs of every conversation they touched, in one query. A conversation with no row has the zero Pref.
func All(ctx context.Context, d pdb.DBTX, identityID int64) (map[int64]Pref, error) {
	rows, err := db.New(d).ListConversationPrefs(ctx, identityID)
	if err != nil {
		return nil, err
	}
	out := make(map[int64]Pref, len(rows))
	for _, r := range rows {
		p := Pref{Starred: r.StarredAt.Valid, MutedUntil: r.MutedUntil.Int64}
		if r.RailRank.Valid {
			rank := r.RailRank.Float64
			p.Rank = &rank
		}
		out[r.ConversationID] = p
	}
	return out, nil
}

// Row is one conversation of a section with its current rank.
type Row struct {
	ID   int64
	Rank float64
}

// Order sorts a section as the rail shows it: higher rank first, then the newer conversation.
func Order(rows []Row) {
	slices.SortFunc(rows, func(a, b Row) int {
		switch {
		case a.Rank > b.Rank:
			return -1
		case a.Rank < b.Rank:
			return 1
		case a.ID > b.ID:
			return -1
		case a.ID < b.ID:
			return 1
		}
		return 0
	})
}

// without is the section minus one conversation, in rail order.
func without(section []Row, id int64) []Row {
	out := slices.DeleteFunc(slices.Clone(section), func(r Row) bool { return r.ID == id })
	Order(out)
	return out
}

// TopRank is a rank that puts a conversation first in a section: now, or just above the current first when that is later.
func TopRank(section []Row, now time.Time) float64 {
	top := float64(now.UnixMilli())
	for _, r := range section {
		top = max(top, r.Rank+1)
	}
	return top
}

// Place moves conversation id directly below `after` (nil: first) in section and returns the rows whose rank changed. The new rank is
// the midpoint of the two neighbours' ranks; when none fits between them the whole section is renormalized so the order is kept (I-21).
func Place(section []Row, id int64, after *int64, now time.Time) ([]Row, error) {
	rest := without(section, id)
	if after == nil {
		return []Row{{id, TopRank(rest, now)}}, nil
	}
	k := slices.IndexFunc(rest, func(r Row) bool { return r.ID == *after })
	if k < 0 {
		return nil, ErrNotInSection
	}
	upper := rest[k].Rank
	lower := upper - renormStep
	if k+1 < len(rest) {
		lower = rest[k+1].Rank
	}
	if mid := (upper + lower) / 2; mid < upper && mid > lower {
		return []Row{{id, mid}}, nil
	}
	order := slices.Insert(slices.Clone(rest), k+1, Row{ID: id})
	top := rest[0].Rank
	for i := range order {
		order[i].Rank = top - float64(i)*renormStep
	}
	return order, nil
}

// SetStarred stars or unstars a conversation and stores the rank that puts it first in its new section.
func SetStarred(ctx context.Context, d pdb.DBTX, now time.Time, identityID, conversationID int64, starred bool, rank float64) error {
	return db.New(d).UpsertStar(ctx, db.UpsertStarParams{
		IdentityID: identityID, ConversationID: conversationID, StarredAt: sql.NullInt64{Int64: now.UnixMilli(), Valid: starred}, RailRank: sql.NullFloat64{Float64: rank, Valid: true}, At: now.UnixMilli(),
	})
}

// SetRanks stores the ranks of the rows a placement changed.
func SetRanks(ctx context.Context, d pdb.DBTX, now time.Time, identityID int64, rows []Row) error {
	q := db.New(d)
	for _, r := range rows {
		err := q.UpsertRank(ctx, db.UpsertRankParams{IdentityID: identityID, ConversationID: r.ID, RailRank: sql.NullFloat64{Float64: r.Rank, Valid: true}, At: now.UnixMilli()})
		if err != nil {
			return err
		}
	}
	return nil
}

// SetMuted mutes until the epoch ms, or unmutes with 0.
func SetMuted(ctx context.Context, d pdb.DBTX, now time.Time, identityID, conversationID, until int64) error {
	return db.New(d).UpsertMute(ctx, db.UpsertMuteParams{
		IdentityID: identityID, ConversationID: conversationID, MutedUntil: sql.NullInt64{Int64: until, Valid: until != 0}, At: now.UnixMilli(),
	})
}

// Pin pins a message for the person; pinning twice changes nothing. changed says whether this call made the pin.
func Pin(ctx context.Context, d pdb.DBTX, now time.Time, identityID, messageID int64) (changed bool, err error) {
	n, err := db.New(d).InsertPin(ctx, db.InsertPinParams{IdentityID: identityID, MessageID: messageID, At: now.UnixMilli()})
	return n > 0, err
}

// Unpin removes the person's pin; changed is false when there was none.
func Unpin(ctx context.Context, d pdb.DBTX, identityID, messageID int64) (changed bool, err error) {
	n, err := db.New(d).DeletePin(ctx, db.DeletePinParams{IdentityID: identityID, MessageID: messageID})
	return n > 0, err
}

// maxPinned bounds the pins one list reads.
const maxPinned = 500

// PinnedIDs lists the messages the person pinned, newest pin first. The caller keeps those of the conversation it shows.
func PinnedIDs(ctx context.Context, d pdb.DBTX, identityID int64) ([]int64, error) {
	return db.New(d).ListPins(ctx, db.ListPinsParams{IdentityID: identityID, MaxRows: maxPinned})
}
