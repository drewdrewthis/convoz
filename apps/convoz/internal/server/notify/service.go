package notify

import (
	"context"
	"database/sql"
	"errors"
	"log"
	"net/http"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/notify/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// Event is a stored event as the pipeline reads it (the composition root converts it from the event module).
type Event struct {
	Seq, Actor, Conversation, Message int64
	CreatedAt                         int64 // unix ms
	Type, Payload                     string
}

// Notification is a recorded decision as the sender reads it.
type Notification struct {
	ID, Person, SourceSeq, Conversation, Message int64
	Reason, Topic                                string
	Urgent                                       bool
	CreatedAt                                    int64
}

// Source is what the pipeline reads from the other modules. The composition root implements it; each method runs on the connection it is given.
type Source interface {
	// Events returns up to max events with seq above after, oldest first, and the newest seq of the log.
	Events(ctx context.Context, d pdb.DBTX, after int64, max int) (events []Event, newest int64, err error)
	// Triggers turns one event into what it may notify: nothing for most events.
	Triggers(ctx context.Context, d pdb.DBTX, e Event) ([]Trigger, error)
	// Env reads the person's choices and the data for one trigger.
	Env(ctx context.Context, d pdb.DBTX, t Trigger, now time.Time) (Env, error)
	// Facts reads what one push shows. It is read again at send time, so a push is built from what is true then.
	Facts(ctx context.Context, d pdb.DBTX, n Notification) (Facts, error)
	// DeviceLive reports whether the device still has a session; a push never goes to a signed-out device.
	DeviceLive(ctx context.Context, d pdb.DBTX, device int64) (bool, error)
}

// HTTPClient posts a push. The real one is an http.Client that follows no redirect; the test build swaps in its fake push service.
type HTTPClient interface {
	Do(*http.Request) (*http.Response, error)
}

// Service is the push pipeline of one server.
type Service struct {
	Store    *pdb.Store
	Clock    platform.Clock
	Keys     Keys
	Source   Source
	Client   HTTPClient
	Presence *Presence
	Log      *log.Logger
	// Subject is the VAPID contact: a bare e-mail address such as push@host, with no "mailto:" and no port. The webpush library
	// adds the "mailto:"; a second one makes the VAPID token invalid and Apple rejects it (design §10.3).
	Subject string
	// Paused, when set and true, holds the sender back (the test build uses it to make "before the push is sent" a state a scenario can hold).
	Paused func() bool
}

// consumerName is the key of the push worker in consumer_offsets.
const consumerName = "push"

// batch is how many events one pass of the consumer takes.
const batch = 200

// Consume reads the events after the worker's offset and records what each causes, in one transaction with the new offset: a crash
// replays the batch and the unique key of a notification makes the replay change nothing. On its first run the worker starts at the
// end of the log, so history that came before push existed is never pushed. It reports whether more events are waiting.
func (s *Service) Consume(ctx context.Context) (more bool, err error) {
	if idle, err := s.idle(ctx); err != nil || idle {
		return false, err
	}
	err = s.Store.Writer.Tx(ctx, func(ctx context.Context, tx *pdb.Tx) error {
		d := tx.DBTX()
		now := s.Clock.Now()
		after, err := pdb.New(d).GetConsumerOffset(ctx, consumerName)
		first := errors.Is(err, sql.ErrNoRows)
		if err != nil && !first {
			return err
		}
		events, newest, err := s.Source.Events(ctx, d, after, batch)
		if err != nil {
			return err
		}
		if first {
			return pdb.New(d).SetConsumerOffset(ctx, pdb.SetConsumerOffsetParams{Consumer: consumerName, LastEventID: newest, Now: now.UnixMilli()})
		}
		if len(events) == 0 {
			return nil
		}
		for _, e := range events {
			if now.Sub(time.UnixMilli(e.CreatedAt)) > expiry {
				continue // a stale event is skipped, not pushed an hour late (design §5.3)
			}
			triggers, err := s.Source.Triggers(ctx, d, e)
			if err != nil {
				return err
			}
			for _, t := range triggers {
				if err := s.Record(ctx, d, now, t); err != nil {
					return err
				}
			}
		}
		more = events[len(events)-1].Seq < newest
		return pdb.New(d).SetConsumerOffset(ctx, pdb.SetConsumerOffsetParams{Consumer: consumerName, LastEventID: events[len(events)-1].Seq, Now: now.UnixMilli()})
	})
	return more, err
}

// idle reports, from the read pool, that the worker has an offset and no event is waiting: the common pass takes no write lock.
func (s *Service) idle(ctx context.Context) (bool, error) {
	rd := s.Store.Reader.SQL()
	after, err := pdb.New(rd).GetConsumerOffset(ctx, consumerName)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	events, _, err := s.Source.Events(ctx, rd, after, 1)
	return len(events) == 0, err
}

// Record decides one trigger and writes the decision, and a queued delivery for each device it goes to. The same trigger twice is one notification.
// The ask module calls it for a snooze that woke, inside the transaction that wakes it.
func (s *Service) Record(ctx context.Context, d pdb.DBTX, now time.Time, t Trigger) error {
	env, err := s.Source.Env(ctx, d, t, now)
	if err != nil {
		return err
	}
	subs, err := liveOf(ctx, d, t.Person)
	if err != nil {
		return err
	}
	targets := targetsOf(t, subs)
	if unrecorded(t, targets) {
		return nil
	}
	decision, why := Decide(t, env, len(targets))
	q := db.New(d)
	urgent := int64(0)
	if t.Urgent {
		urgent = 1
	}
	rows, err := q.InsertNotification(ctx, db.InsertNotificationParams{
		IdentityID: t.Person, Reason: t.Reason, SourceSeq: t.SourceSeq,
		ConversationID: sql.NullInt64{Int64: t.Conversation, Valid: t.Conversation != 0},
		MessageID:      sql.NullInt64{Int64: t.Message, Valid: t.Message != 0},
		Topic:          s.Keys.Topic(t.TopicKind, t.TopicID), Urgent: urgent, Decision: decision,
		SuppressedReason: sql.NullString{String: why, Valid: why != ""}, Now: now.UnixMilli(),
	})
	if err != nil || rows == 0 || decision != Send {
		return err // a replay: the first decision stands (I-28)
	}
	id, err := q.NotificationByKey(ctx, db.NotificationByKeyParams{IdentityID: t.Person, Reason: t.Reason, SourceSeq: t.SourceSeq})
	if err != nil {
		return err
	}
	for _, sub := range targets {
		if err := q.InsertDelivery(ctx, db.InsertDeliveryParams{NotificationID: id, SubscriptionID: sub.ID, Now: sql.NullInt64{Int64: now.UnixMilli(), Valid: true}}); err != nil {
			return err
		}
	}
	return nil
}
