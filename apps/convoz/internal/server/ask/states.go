package ask

import (
	"context"
	"database/sql"
	"sort"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/ask/db"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// Get reads one ask with its options and its history.
func Get(ctx context.Context, d pdb.DBTX, id int64) (Ask, error) {
	m, err := Views(ctx, d, []int64{id})
	if err != nil {
		return Ask{}, err
	}
	a, ok := m[id]
	if !ok {
		return Ask{}, ErrNotFound
	}
	return a, nil
}

// Views reads the asks with these message ids, each with its options and history, by message id. An id that is no ask is left out.
func Views(ctx context.Context, d pdb.DBTX, ids []int64) (map[int64]Ask, error) {
	out := map[int64]Ask{}
	if len(ids) == 0 {
		return out, nil
	}
	q := db.New(d)
	rows, err := q.AsksByIDs(ctx, ids)
	if err != nil {
		return nil, err
	}
	for _, r := range rows {
		out[r.MessageID] = fromRow(askRow(r))
	}
	if len(out) == 0 {
		return out, nil
	}
	have := make([]int64, 0, len(out))
	for id := range out {
		have = append(have, id)
	}
	opts, err := q.OptionsOf(ctx, have)
	if err != nil {
		return nil, err
	}
	for _, o := range opts {
		a := out[o.MessageID]
		a.Options = append(a.Options, Option{Label: o.Label, Why: o.Why})
		out[o.MessageID] = a
	}
	hist, err := q.HistoryOf(ctx, have)
	if err != nil {
		return nil, err
	}
	for _, h := range hist {
		a := out[h.MessageID]
		a.History = append(a.History, Transition{Version: h.Version, Event: h.Event, ToState: h.ToState, By: h.ByIdentity.Int64, At: h.At})
		out[h.MessageID] = a
	}
	answered, err := q.RepliesAnsweredOf(ctx, have)
	if err != nil {
		return nil, err
	}
	for _, id := range answered {
		a := out[id]
		a.ReplyAnswered = true
		out[id] = a
	}
	return out, nil
}

// askRow is the columns of an ask as the queries read them.
type askRow = db.AskByIDRow

func fromRow(r askRow) Ask {
	a := Ask{
		ID: r.MessageID, ConversationID: r.ConversationID, AskerID: r.AskerID, Question: r.Question, Urgent: r.Urgent == 1,
		Scrubbed: r.ScrubbedAt.Valid, State: r.State, CloseReason: r.CloseReason.String, AnswerVia: r.AnswerVia.String,
		ResolvedBy: r.ResolvedBy.Int64, ResolvedAt: r.ResolvedAt.Int64, AckedAt: r.AckedAt.Int64, OwnerRepliedAt: r.OwnerRepliedAt.Int64, OwnerReplyID: r.OwnerReplyID.Int64,
		Answers: r.Answers.String, Changed: r.Changed.String, Version: r.Version,
		CreatedAt: r.CreatedAt, UpdatedAt: r.UpdatedAt,
	}
	if r.OwnersCallKind.Valid && !r.ScrubbedAt.Valid {
		a.OwnersCall = &OwnersCall{Kind: r.OwnersCallKind.String, Reason: r.OwnersCallReason.String}
	}
	if r.DraftText.Valid && !r.ScrubbedAt.Valid {
		a.Draft = &Draft{Text: r.DraftText.String, Original: r.OriginalText.String, OriginalFrom: r.OriginalFrom.String}
	}
	if r.ChosenKind.Valid {
		a.Chosen = &Choice{Kind: r.ChosenKind.String, Index: int(r.ChosenIndex.Int64), Text: r.ChosenText.String}
	}
	return a
}

// Waiting is what Now lists for one person.
type Waiting struct {
	Open      []Ask           // open, not snoozed and not waiting on the agent: urgent first, then the newest
	Replied   []Ask           // open, not snoozed, and the owner's reply is the last word in its thread: waiting on the agent, the newest reply first
	Snoozed   []Ask           // open and snoozed by this person: the soonest wake first
	Until     map[int64]int64 // the snooze time of each snoozed ask
	Answered  []Ask           // answered since the cut: newest first
	Dismissed []Ask           // dismissed since the cut and still dismissed: newest first
}

// ForNow reads the asks that wait for a person at now, and the ones answered since `since`.
func ForNow(ctx context.Context, d pdb.DBTX, person int64, now time.Time, since int64) (Waiting, error) {
	q := db.New(d)
	open, err := q.OpenAsks(ctx)
	if err != nil {
		return Waiting{}, err
	}
	answered, err := q.AnsweredSince(ctx, sql.NullInt64{Int64: since, Valid: true})
	if err != nil {
		return Waiting{}, err
	}
	dismissed, err := q.DismissedSince(ctx, sql.NullInt64{Int64: since, Valid: true})
	if err != nil {
		return Waiting{}, err
	}
	snoozes, err := q.ActiveSnoozes(ctx, db.ActiveSnoozesParams{IdentityID: person, Now: now.UnixMilli()})
	if err != nil {
		return Waiting{}, err
	}
	until := make(map[int64]int64, len(snoozes))
	for _, s := range snoozes {
		until[s.MessageID] = s.UntilAt
	}
	ids := append(append(append([]int64{}, open...), answered...), dismissed...)
	byID, err := Views(ctx, d, ids)
	if err != nil {
		return Waiting{}, err
	}
	w := Waiting{Until: until}
	for _, id := range open {
		if _, hidden := until[id]; hidden {
			w.Snoozed = append(w.Snoozed, byID[id])
		} else if byID[id].WaitingOnAgent() {
			w.Replied = append(w.Replied, byID[id])
		} else {
			w.Open = append(w.Open, byID[id])
		}
	}
	sort.SliceStable(w.Replied, func(i, j int) bool { return w.Replied[i].OwnerRepliedAt > w.Replied[j].OwnerRepliedAt })
	sortByWake(w.Snoozed, until)
	for _, id := range answered {
		w.Answered = append(w.Answered, byID[id])
	}
	for _, id := range dismissed {
		w.Dismissed = append(w.Dismissed, byID[id])
	}
	return w, nil
}

func sortByWake(list []Ask, until map[int64]int64) {
	for i := 1; i < len(list); i++ {
		for j := i; j > 0 && until[list[j].ID] < until[list[j-1].ID]; j-- {
			list[j], list[j-1] = list[j-1], list[j]
		}
	}
}

// SnoozedUntil is the snooze of one person on these asks that still hides them, by message id.
func SnoozedUntil(ctx context.Context, d pdb.DBTX, person int64, now time.Time) (map[int64]int64, error) {
	rows, err := db.New(d).ActiveSnoozes(ctx, db.ActiveSnoozesParams{IdentityID: person, Now: now.UnixMilli()})
	if err != nil {
		return nil, err
	}
	out := make(map[int64]int64, len(rows))
	for _, r := range rows {
		out[r.MessageID] = r.UntilAt
	}
	return out, nil
}

// OpenCount is how many open asks an agent holds.
func OpenCount(ctx context.Context, d pdb.DBTX, asker int64) (int64, error) {
	return db.New(d).CountOpenOf(ctx, asker)
}
