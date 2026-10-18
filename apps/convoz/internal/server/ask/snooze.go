package ask

import (
	"context"
	"database/sql"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/ask/db"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// Snooze presets (C-9).
const (
	PresetHour     = "1h"
	PresetTonight  = "tonight"
	PresetTomorrow = "tomorrow"
)

// tonightAt and tomorrowAt are the local hours of the two presets.
const (
	tonightAt  = 18
	tomorrowAt = 9
)

// PresetTime is when a preset wakes the ask, read in the person's time zone: 1 hour from now; Tonight 18:00 (6:00 PM) the same day,
// which is not offered from 18:00 (ErrPresetGone); Tomorrow 09:00 the next day.
func PresetTime(preset string, now time.Time, loc *time.Location) (time.Time, error) {
	local := now.In(loc)
	y, m, d := local.Date()
	switch preset {
	case PresetHour:
		return now.Add(time.Hour), nil
	case PresetTonight:
		if local.Hour() >= tonightAt {
			return time.Time{}, ErrPresetGone
		}
		return time.Date(y, m, d, tonightAt, 0, 0, 0, loc), nil
	case PresetTomorrow:
		return time.Date(y, m, d+1, tomorrowAt, 0, 0, 0, loc), nil
	}
	return time.Time{}, &FieldError{"preset", "A preset is 1h, tonight or tomorrow."}
}

// Snooze hides an open ask from one person until a time. It is that person's overlay: the ask, its version and its history
// do not change (I-13), and nobody else sees it. An ask that is not open is a Conflict with the code not_open (C-5).
func Snooze(ctx context.Context, d pdb.DBTX, p Ports, now time.Time, person, id int64, until time.Time) (Ask, error) {
	a, err := Get(ctx, d, id)
	if err != nil {
		return Ask{}, err
	}
	if a.State != Open {
		return Ask{}, &Conflict{Code: CodeNotOpen, Ask: a}
	}
	if !until.After(now) || until.After(now.Add(MaxSnooze)) {
		return Ask{}, &FieldError{"until", "A snooze ends within the next 31 days."}
	}
	if err := db.New(d).UpsertSnooze(ctx, db.UpsertSnoozeParams{MessageID: id, IdentityID: person, UntilAt: until.UnixMilli(), Now: now.UnixMilli()}); err != nil {
		return Ask{}, err
	}
	if _, err := p.Journal.Write(ctx, d, now, Change{
		Type: EventSnoozed, Actor: person, Conversation: a.ConversationID, Message: id, Audience: person,
		Payload: map[string]any{"message_id": id, "until": until.UnixMilli()},
	}); err != nil {
		return Ask{}, err
	}
	return a, nil
}

// Unsnooze takes the snooze off at once. An ask with none is left as it is (a no-op).
func Unsnooze(ctx context.Context, d pdb.DBTX, p Ports, now time.Time, person, id int64) (Ask, error) {
	a, err := Get(ctx, d, id)
	if err != nil {
		return Ask{}, err
	}
	n, err := db.New(d).DeleteSnooze(ctx, db.DeleteSnoozeParams{MessageID: id, IdentityID: person})
	if err != nil || n == 0 {
		return a, err
	}
	_, err = p.Journal.Write(ctx, d, now, Change{
		Type: EventUnsnoozed, Actor: person, Conversation: a.ConversationID, Message: id, Audience: person,
		Payload: map[string]any{"message_id": id},
	})
	return a, err
}

// WakeDue marks the snoozes whose time has come and tells each person (event and notification, reason snooze_wake). The ask
// is back in the person's Now by its time alone; this is the bookkeeping that follows. It returns how many woke.
func WakeDue(ctx context.Context, d pdb.DBTX, p Ports, now time.Time) (int, error) {
	q := db.New(d)
	due, err := q.DueSnoozes(ctx, now.UnixMilli())
	if err != nil {
		return 0, err
	}
	woke := 0
	for _, s := range due {
		a, err := Get(ctx, d, s.MessageID)
		if err != nil {
			return woke, err
		}
		if n, err := q.MarkWoke(ctx, db.MarkWokeParams{Now: sql.NullInt64{Int64: now.UnixMilli(), Valid: true}, MessageID: s.MessageID, IdentityID: s.IdentityID}); err != nil || n == 0 {
			if err != nil {
				return woke, err
			}
			continue
		}
		seq, err := p.Journal.Write(ctx, d, now, Change{
			Type: EventWoke, Conversation: a.ConversationID, Message: a.ID, Audience: s.IdentityID,
			Payload: map[string]any{"message_id": a.ID, "until": s.UntilAt},
		})
		if err != nil {
			return woke, err
		}
		if err := p.Notify.SnoozeWoke(ctx, d, now, s.IdentityID, a.ConversationID, a.ID, seq); err != nil {
			return woke, err
		}
		woke++
	}
	return woke, nil
}

// Due reports whether a snooze has come due and not been marked yet, so a reader can skip the write when there is none.
func Due(ctx context.Context, d pdb.DBTX, now time.Time) (bool, error) {
	rows, err := db.New(d).DueSnoozes(ctx, now.UnixMilli())
	return len(rows) > 0, err
}

// Ack records that the asking agent has seen the result, once: its ack of the ask_resolved item. A repeat changes nothing.
func Ack(ctx context.Context, d pdb.DBTX, p Ports, now time.Time, id, agent, session int64) error {
	a, err := Get(ctx, d, id)
	if err != nil {
		return err
	}
	if a.AskerID != agent {
		return ErrNotAsker
	}
	n, err := db.New(d).AckAsk(ctx, db.AckAskParams{Now: now.UnixMilli(), SessionID: nullInt(session), MessageID: id})
	if err != nil || n == 0 {
		return err
	}
	_, err = p.Journal.Write(ctx, d, now, Change{
		Type: EventAcked, Actor: agent, Session: session, Conversation: a.ConversationID, Message: id,
		Payload: map[string]any{"message_id": id, "session": session},
	})
	return err
}
