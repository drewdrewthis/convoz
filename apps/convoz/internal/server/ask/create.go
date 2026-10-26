package ask

import (
	"context"
	"database/sql"
	"encoding/json"
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
	OwnersCall                               OwnersCall  // checked by the caller (wire.OwnersCall.Problem); the table refuses an unknown kind
	App                                      []byte      // the checked app shown with the question (compact JSON); nil for none
	Draft                                    *Draft      // a draft ask: it has no options and no owner's call of its own, the module sets both
	Permission                               *Permission // a permission ask: no options and no owner's call either; the question defaults to the action
}

// question is the question the ask shows: a permission ask asked without one shows its action.
func (n New) question() string {
	if n.Permission != nil && strings.TrimSpace(n.Question) == "" {
		return n.Permission.Action
	}
	return n.Question
}

// Check refuses an ask that is not complete or is too long, naming the field (I-11, AC-13).
func (n New) Check() error {
	if p := n.Permission; p != nil {
		if n.Draft != nil {
			return &FieldError{"permission", "An ask is a permission ask or a draft ask, not both."}
		}
		if err := p.check(); err != nil {
			return err
		}
	}
	n.Question = n.question()
	if err := n.checkQuestion(); err != nil {
		return err
	}
	switch {
	case n.Permission != nil:
		return nil
	case n.Draft != nil:
		return checkDraft(*n.Draft)
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

// checkQuestion judges the question alone: there, and at most 500 characters.
func (n New) checkQuestion() error {
	switch {
	case strings.TrimSpace(n.Question) == "":
		return &FieldError{"question", "Ask a question."}
	case utf8.RuneCountInString(n.Question) > MaxQuestion:
		return &FieldError{"question", "A question has at most 500 characters."}
	}
	return nil
}

// checkDraft judges a draft: the text 1 to 4000 characters, the original at most 2000 and its from-line at most 200.
func checkDraft(d Draft) error {
	switch {
	case strings.TrimSpace(d.Text) == "":
		return &FieldError{"draft", "A draft ask needs the draft text."}
	case utf8.RuneCountInString(d.Text) > MaxCustomText:
		return &FieldError{"draft", "A draft has at most 4000 characters."}
	case utf8.RuneCountInString(d.Original) > MaxOriginal:
		return &FieldError{"original", "The original has at most 2000 characters."}
	case utf8.RuneCountInString(d.OriginalFrom) > MaxOriginalFrom:
		return &FieldError{"original_from", "The from-line of the original has at most 200 characters."}
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
	n.Question = n.question()
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
		OriginLabel: n.OriginLabel, OriginMachine: n.OriginMachine, ClientID: n.ClientID, Question: n.Question, App: n.App,
	})
	if err != nil || replayed {
		if err == nil {
			a, err = Get(ctx, d, id)
		}
		return a, replayed, err
	}
	at := now.UnixMilli()
	row := db.InsertAskParams{
		MessageID: id, ConversationID: n.Conversation, AskerID: n.Asker, AskedBySession: sql.NullInt64{Int64: n.Session, Valid: n.Session != 0},
		Question: n.Question, Urgent: boolInt(n.Urgent), Now: at,
		OwnersCallKind: sql.NullString{String: n.OwnersCall.Kind, Valid: true}, OwnersCallReason: sql.NullString{String: n.OwnersCall.Reason, Valid: true},
	}
	options := append([]Option{n.Recommended}, n.Alternatives...)
	if d := n.Draft; d != nil { // its owner's call is not stored: a reader gets the fixed "in your name" call
		row.OwnersCallKind, row.OwnersCallReason = sql.NullString{}, sql.NullString{}
		row.DraftText, row.OriginalText, row.OriginalFrom = sql.NullString{String: d.Text, Valid: true}, nullText(d.Original), nullText(d.OriginalFrom)
		options = draftOptions
	}
	if pm := n.Permission; pm != nil { // Risk and Undo say what an owner's call said: none is stored
		row.OwnersCallKind, row.OwnersCallReason = sql.NullString{}, sql.NullString{}
		row.Action, row.Risk, row.Undo, row.OneWay, row.Considered = permissionColumns(pm)
		row.Confidence = sql.NullInt64{Int64: int64(pm.Confidence), Valid: true}
		options = permissionOptions
	}
	if err := q.InsertAsk(ctx, row); err != nil {
		return Ask{}, false, err
	}
	for i, o := range options {
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

// permissionColumns is a permission as the asks table keeps it; all NULL for nil (any other ask). The considered lines are a JSON array.
func permissionColumns(pm *Permission) (action, risk, undo sql.NullString, oneWay sql.NullInt64, considered sql.NullString) {
	if pm == nil {
		return
	}
	lines, _ := json.Marshal(pm.Considered) // a []string always marshals
	return sql.NullString{String: pm.Action, Valid: true}, sql.NullString{String: pm.Risk, Valid: true}, nullText(pm.Undo),
		sql.NullInt64{Int64: boolInt(pm.OneWay), Valid: true}, sql.NullString{String: string(lines), Valid: true}
}

func boolInt(b bool) int64 {
	if b {
		return 1
	}
	return 0
}

func nullText(v string) sql.NullString { return sql.NullString{String: v, Valid: v != ""} }

func nullInt(v int64) sql.NullInt64 { return sql.NullInt64{Int64: v, Valid: v != 0} }
