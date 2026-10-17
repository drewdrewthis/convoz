package ask

import (
	"context"
	"database/sql"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/ask/db"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// New is an ask to open. The first option is the recommended one (I-11); the author is always the calling agent (I-40).
type New struct {
	Conversation, ThreadRoot, Asker, Session int64
	OriginLabel, OriginMachine               string
	ClientID, Question                       string
	Recommended                              Option
	Alternatives                             []Option
	Urgent                                   bool
}

// Check refuses an ask that is not complete or is too long, naming the field (I-11, AC-13).
func (n New) Check() error {
	q := strings.TrimSpace(n.Question)
	switch {
	case q == "":
		return &FieldError{"question", "Ask a question."}
	case utf8.RuneCountInString(n.Question) > MaxQuestion:
		return &FieldError{"question", "A question has at most 500 characters."}
	case len(n.Alternatives) < 1 || len(n.Alternatives) > MaxAlternatives:
		return &FieldError{"alternatives", "Give 1 to 4 alternatives."}
	}
	if err := checkOption(n.Recommended); err != nil {
		return err
	}
	for _, o := range n.Alternatives {
		if err := checkOption(o); err != nil {
			return err
		}
	}
	return nil
}

// checkOption judges one option; a reason that is empty or too long is the field "why", a label the field "label".
func checkOption(o Option) error {
	switch {
	case strings.TrimSpace(o.Label) == "" || utf8.RuneCountInString(o.Label) > MaxLabel:
		return &FieldError{"label", "Every option has a label of 1 to 120 characters."}
	case strings.TrimSpace(o.Why) == "" || utf8.RuneCountInString(o.Why) > MaxWhy:
		return &FieldError{"why", "Every option has a reason of 1 to 280 characters."}
	}
	return nil
}

// Create opens an ask in the caller's transaction: the ask message, the ask and its options, sealed (I-10, I-11), the
// first history row, the counter and the thin event. A repeat of the client id changes nothing and returns the first ask (I-24).
func Create(ctx context.Context, d pdb.DBTX, p Ports, now time.Time, n New) (a Ask, replayed bool, err error) {
	if err := n.Check(); err != nil {
		return Ask{}, false, err
	}
	q := db.New(d)
	open, err := q.CountOpenOf(ctx, n.Asker)
	if err != nil {
		return Ask{}, false, err
	}
	if open >= MaxOpenPerAsker {
		return Ask{}, false, ErrCap
	}
	id, replayed, err := p.Messages.PostAsk(ctx, d, now, AskMessage{
		Conversation: n.Conversation, ThreadRoot: n.ThreadRoot, Author: n.Asker, Session: n.Session,
		OriginLabel: n.OriginLabel, OriginMachine: n.OriginMachine, ClientID: n.ClientID, Question: n.Question,
	})
	if err != nil || replayed {
		if err == nil {
			a, err = Get(ctx, d, id)
		}
		return a, replayed, err
	}
	at := now.UnixMilli()
	if err := q.InsertAsk(ctx, db.InsertAskParams{
		MessageID: id, ConversationID: n.Conversation, AskerID: n.Asker, AskedBySession: sql.NullInt64{Int64: n.Session, Valid: n.Session != 0},
		Question: n.Question, Urgent: boolInt(n.Urgent), Now: at,
	}); err != nil {
		return Ask{}, false, err
	}
	for i, o := range append([]Option{n.Recommended}, n.Alternatives...) {
		if err := q.InsertOption(ctx, db.InsertOptionParams{MessageID: id, Idx: int64(i), Label: o.Label, Why: o.Why}); err != nil {
			return Ask{}, false, err
		}
	}
	if err := q.SealAsk(ctx, id); err != nil {
		return Ask{}, false, err
	}
	if err := q.InsertTransition(ctx, db.InsertTransitionParams{MessageID: id, Version: 1, Event: "create", ToState: Open, ByIdentity: nullInt(n.Asker), At: at}); err != nil {
		return Ask{}, false, err
	}
	if err := p.Conversations.AddOpenAsks(ctx, d, n.Conversation, 1); err != nil {
		return Ask{}, false, err
	}
	if _, err := p.Journal.Write(ctx, d, now, Change{
		Type: EventCreated, Actor: n.Asker, Session: n.Session, Conversation: n.Conversation, Message: id,
		Payload: map[string]any{"message_id": id, "urgent": n.Urgent},
	}); err != nil {
		return Ask{}, false, err
	}
	a, err = Get(ctx, d, id)
	return a, false, err
}

func boolInt(b bool) int64 {
	if b {
		return 1
	}
	return 0
}

func nullInt(v int64) sql.NullInt64 { return sql.NullInt64{Int64: v, Valid: v != 0} }
