package ask

import (
	"context"
	"database/sql"
	"encoding/json"
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
	return out, nil
}

// MarkReplyAnswered sets ReplyAnswered on the asks of list whose owner reply someone else answered after (the thread's rule is
// Threads.RepliesAnswered). It is kept off Views so a caller that reads asks in bulk pays one thread query for all of them.
func MarkReplyAnswered(ctx context.Context, d pdb.DBTX, t Threads, list []Ask) error {
	var replies []int64
	for _, a := range list {
		if a.OwnerReplyID != 0 {
			replies = append(replies, a.OwnerReplyID)
		}
	}
	if len(replies) == 0 {
		return nil
	}
	answered, err := t.RepliesAnswered(ctx, d, replies)
	if err != nil {
		return err
	}
	done := make(map[int64]bool, len(answered))
	for _, id := range answered {
		done[id] = true
	}
	for i := range list {
		if done[list[i].OwnerReplyID] {
			list[i].ReplyAnswered = true
		}
	}
	return nil
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
	if r.Action.Valid && !r.ScrubbedAt.Valid {
		a.Permission = &Permission{Action: r.Action.String, Risk: r.Risk.String, Undo: r.Undo.String, OneWay: r.OneWay.Int64 == 1, Confidence: int(r.Confidence.Int64)}
		_ = json.Unmarshal([]byte(r.Considered.String), &a.Permission.Considered) // written by permissionColumns, always an array
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
func ForNow(ctx context.Context, d pdb.DBTX, t Threads, person int64, now time.Time, since int64) (Waiting, error) {
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
	openAsks := make([]Ask, 0, len(open))
	for _, id := range open {
		openAsks = append(openAsks, byID[id])
	}
	if err := MarkReplyAnswered(ctx, d, t, openAsks); err != nil {
		return Waiting{}, err
	}
	w := Waiting{Until: until}
	for _, a := range openAsks {
		if _, hidden := until[a.ID]; hidden {
			w.Snoozed = append(w.Snoozed, a)
		} else if a.WaitingOnAgent() {
			w.Replied = append(w.Replied, a)
		} else {
			w.Open = append(w.Open, a)
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
