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

// The state table of design §8.1. Each function below is one row group: it reads the ask, decides, and either changes it by
// a compare-and-swap on the version (the first writer wins; a loser is told how the ask stands) or says why it cannot.
// A change that does anything writes one history row, takes the snoozes off, moves the counter, tells the asker's inbox
// where the table says so, and writes its thin event. Nothing here moves a read cursor (I-15).

// Answering is the input of Answer. By is the person; Via is "inline" (in the conversation) or "now".
type Answering struct {
	ID, By, Device int64
	Choice         Choice
	IfVersion      int64
	Via            string
}

// Answer answers an open or dismissed ask (the first answer wins). The same person sending the same answer again is
// a no-op that returns the stored result (C-4); any other answer to an answered ask is a Conflict that carries the winner.
// changed is false for the no-op.
func Answer(ctx context.Context, d pdb.DBTX, p Ports, now time.Time, in Answering) (a Ask, changed bool, err error) {
	if a, err = Get(ctx, d, in.ID); err != nil {
		return Ask{}, false, err
	}
	if a.State == Answered && a.ResolvedBy == in.By && sameChoice(a, in.Choice) {
		return a, false, nil
	}
	if err := refuse(a, in.IfVersion); err != nil {
		return Ask{}, false, err
	}
	chosen, text, err := resolve(a, in.Choice)
	if err != nil {
		return Ask{}, false, err
	}
	if a.State == Dismissed {
		if err := askerStillHere(ctx, d, p, a); err != nil {
			return Ask{}, false, err
		}
	}
	q := db.New(d)
	via := in.Via
	if via != "now" {
		via = "inline"
	}
	won, err := q.MarkAnswered(ctx, db.MarkAnsweredParams{
		ChosenKind: chosen.Kind, ChosenIndex: nullInt(int64(chosen.Index)), ChosenText: sql.NullString{String: chosen.Text, Valid: chosen.Text != ""},
		AnswerVia: via, By: in.By, Now: now.UnixMilli(), MessageID: a.ID, Version: a.Version,
	})
	if err != nil {
		return Ask{}, false, err
	}
	if won == 0 {
		return Ask{}, false, lost(ctx, d, a.ID)
	}
	if err := p.settle(ctx, d, now, a, "answer", Answered, in.By, a.State == Open, EventAnswered, map[string]any{
		"chosen_kind": chosen.Kind, "chosen_index": chosen.Index,
	}); err != nil {
		return Ask{}, false, err
	}
	if err := p.Messages.PostAnswer(ctx, d, now, AnswerMessage{Ask: a.ID, Conversation: a.ConversationID, Author: in.By, Device: in.Device, Text: text}); err != nil {
		return Ask{}, false, err
	}
	a, err = Get(ctx, d, in.ID)
	return a, true, err
}

// Dismiss dismisses an open ask. A dismissed ask stays dismissed (a no-op); an answered or closed one is a Conflict.
func Dismiss(ctx context.Context, d pdb.DBTX, p Ports, now time.Time, id, by, ifVersion int64) (a Ask, changed bool, err error) {
	if a, err = Get(ctx, d, id); err != nil {
		return Ask{}, false, err
	}
	if a.State == Dismissed {
		return a, false, nil
	}
	if err := refuse(a, ifVersion); err != nil {
		return Ask{}, false, err
	}
	won, err := db.New(d).MarkDismissed(ctx, db.MarkDismissedParams{By: by, Now: now.UnixMilli(), MessageID: a.ID, Version: a.Version})
	if err != nil {
		return Ask{}, false, err
	}
	if won == 0 {
		return Ask{}, false, lost(ctx, d, a.ID)
	}
	if err := p.settle(ctx, d, now, a, "dismiss", Dismissed, by, true, EventDismissed, nil); err != nil {
		return Ask{}, false, err
	}
	a, err = Get(ctx, d, id)
	return a, true, err
}

// Undismiss reopens a dismissed ask, when its agent is still in the conversation and holds fewer than 20 open asks.
// The dismissal stays in the history, and the agent's ack is cleared.
func Undismiss(ctx context.Context, d pdb.DBTX, p Ports, now time.Time, id, by, ifVersion int64) (a Ask, err error) {
	if a, err = Get(ctx, d, id); err != nil {
		return Ask{}, err
	}
	if a.State != Dismissed {
		return Ask{}, conflict(a)
	}
	if ifVersion != 0 && ifVersion != a.Version {
		return Ask{}, conflict(a)
	}
	if err := askerStillHere(ctx, d, p, a); err != nil {
		return Ask{}, err
	}
	q := db.New(d)
	open, err := q.CountOpenOf(ctx, a.AskerID)
	if err != nil {
		return Ask{}, err
	}
	if open >= MaxOpenPerAsker {
		return Ask{}, &Conflict{Code: CodeAskCap, Ask: a}
	}
	won, err := q.MarkReopened(ctx, db.MarkReopenedParams{Now: now.UnixMilli(), MessageID: a.ID, Version: a.Version})
	if err != nil {
		return Ask{}, err
	}
	if won == 0 {
		return Ask{}, lost(ctx, d, a.ID)
	}
	if err := q.InsertTransition(ctx, db.InsertTransitionParams{MessageID: a.ID, Version: a.Version + 1, Event: "undismiss", ToState: Open, ByIdentity: nullInt(by), At: now.UnixMilli()}); err != nil {
		return Ask{}, err
	}
	if err := p.Conversations.AddOpenAsks(ctx, d, a.ConversationID, 1); err != nil {
		return Ask{}, err
	}
	if _, err := p.Journal.Write(ctx, d, now, Change{
		Type: EventReopened, Actor: by, Conversation: a.ConversationID, Message: a.ID,
		Payload: map[string]any{"message_id": a.ID, "state": Open, "version": a.Version + 1, "by": by},
	}); err != nil {
		return Ask{}, err
	}
	return Get(ctx, d, id)
}

// Withdraw lets the asking agent take back an open or dismissed ask (closed, withdrawn). Anyone else is ErrNotAsker.
func Withdraw(ctx context.Context, d pdb.DBTX, p Ports, now time.Time, id, agent int64) (a Ask, err error) {
	if a, err = Get(ctx, d, id); err != nil {
		return Ask{}, err
	}
	if a.AskerID != agent {
		return Ask{}, ErrNotAsker
	}
	if a.State != Open && a.State != Dismissed {
		return Ask{}, conflict(a)
	}
	if err := closeOne(ctx, d, p, now, a, ReasonWithdrawn, agent, false); err != nil {
		return Ask{}, err
	}
	return Get(ctx, d, id)
}

// settle is what every change out of open (or dismissed) shares once its compare-and-swap won: the snoozes go, the history
// grows, the counter drops when the ask was open, the thin event is written and the asking agent's inbox is told.
func (p Ports) settle(ctx context.Context, d pdb.DBTX, now time.Time, was Ask, event, to string, by int64, wasOpen bool, typ string, extra map[string]any) error {
	q := db.New(d)
	if err := q.DeleteSnoozesOf(ctx, was.ID); err != nil {
		return err
	}
	if err := q.InsertTransition(ctx, db.InsertTransitionParams{MessageID: was.ID, Version: was.Version + 1, Event: event, ToState: to, ByIdentity: nullInt(by), At: now.UnixMilli()}); err != nil {
		return err
	}
	if wasOpen {
		if err := p.Conversations.AddOpenAsks(ctx, d, was.ConversationID, -1); err != nil {
			return err
		}
	}
	payload := map[string]any{"message_id": was.ID, "state": to, "version": was.Version + 1, "by": by}
	for k, v := range extra {
		payload[k] = v
	}
	seq, err := p.Journal.Write(ctx, d, now, Change{Type: typ, Actor: by, Conversation: was.ConversationID, Message: was.ID, Payload: payload})
	if err != nil {
		return err
	}
	return p.Inbox.AskResolved(ctx, d, now, was.AskerID, was.ConversationID, was.ID, seq)
}

// refuse is the check that comes before a change out of open or dismissed: a closed or answered ask is a Conflict that
// carries how it stands, and so is a stale version.
func refuse(a Ask, ifVersion int64) error {
	switch a.State {
	case Open, Dismissed:
	default:
		return conflict(a)
	}
	if ifVersion != 0 && ifVersion != a.Version {
		return conflict(a)
	}
	return nil
}

// askerStillHere is the check before an ask comes back from dismissed: its agent must still be an active participant of the
// conversation and not disabled (409 asker_gone).
func askerStillHere(ctx context.Context, d pdb.DBTX, p Ports, a Ask) error {
	ok, err := p.Conversations.AskerActive(ctx, d, a.ConversationID, a.AskerID)
	if err != nil {
		return err
	}
	if !ok {
		return &Conflict{Code: CodeAskerGone, Ask: a}
	}
	return nil
}

// conflict is the 409 for an ask that cannot take the change: when its agent is gone the code says so, else it is a plain conflict.
func conflict(a Ask) error {
	if a.State == Closed && (a.CloseReason == ReasonRemoved || a.CloseReason == ReasonRevoked) {
		return &Conflict{Code: CodeAskerGone, Ask: a}
	}
	return &Conflict{Code: CodeConflict, Ask: a}
}

// lost is the error of a compare-and-swap another change won: the ask as it stands now.
func lost(ctx context.Context, d pdb.DBTX, id int64) error {
	a, err := Get(ctx, d, id)
	if err != nil {
		return err
	}
	return conflict(a)
}

// resolve checks a choice against the ask's options and says what it is and in which words it is posted.
func resolve(a Ask, c Choice) (Choice, string, error) {
	switch {
	case a.Draft != nil:
		return resolveDraft(a, c)
	case a.Permission != nil:
		return resolvePermission(c)
	}
	switch c.Kind {
	case Recommended:
		return Choice{Kind: Recommended}, a.Options[0].Label, nil
	case Alternative:
		if c.Index < 1 || c.Index >= len(a.Options) {
			return Choice{}, "", &FieldError{"index", "The ask did not offer that alternative."}
		}
		return Choice{Kind: Alternative, Index: c.Index}, a.Options[c.Index].Label, nil
	case Custom:
		text := strings.TrimSpace(c.Text)
		switch {
		case text == "":
			return Choice{}, "", &FieldError{"text", "Write your answer."}
		case utf8.RuneCountInString(text) > MaxCustomText:
			return Choice{}, "", &FieldError{"text", "An answer has at most 4000 characters."}
		}
		return Choice{Kind: Custom, Text: text}, text, nil
	}
	return Choice{}, "", &FieldError{"choice", "Choose recommended, alternative or custom."}
}

// resolveDraft is resolve for a draft ask: Send keeps the final text (the draft itself when the person gave none), Don't send keeps none.
func resolveDraft(a Ask, c Choice) (Choice, string, error) {
	switch c.Kind {
	case Recommended:
		text := draftTextOf(a, c)
		if utf8.RuneCountInString(text) > MaxCustomText {
			return Choice{}, "", &FieldError{"text", "A draft has at most 4000 characters."}
		}
		return Choice{Kind: Recommended, Text: text}, "Send: " + text, nil
	case Alternative:
		if c.Index != 1 {
			return Choice{}, "", &FieldError{"index", "The ask did not offer that alternative."}
		}
		return Choice{Kind: Alternative, Index: 1}, "Don't send", nil
	}
	return Choice{}, "", &FieldError{"choice", "Answer a draft with recommended (send) or alternative 1 (do not send)."}
}

// resolvePermission is resolve for a permission ask: Go takes no text, Not this needs the reason the agent reads.
func resolvePermission(c Choice) (Choice, string, error) {
	text := strings.TrimSpace(c.Text)
	switch c.Kind {
	case Recommended:
		if text != "" {
			return Choice{}, "", &FieldError{"text", "Go takes no text: to say why not, answer Not this."}
		}
		return Choice{Kind: Recommended}, "Go", nil
	case Alternative:
		switch {
		case c.Index != 1:
			return Choice{}, "", &FieldError{"index", "The ask did not offer that alternative."}
		case text == "":
			return Choice{}, "", &FieldError{"text", "Say why not: the agent reads it."}
		case utf8.RuneCountInString(text) > MaxCustomText:
			return Choice{}, "", &FieldError{"text", "A reason has at most 4000 characters."}
		}
		return Choice{Kind: Alternative, Index: 1, Text: text}, "Not this: " + text, nil
	}
	return Choice{}, "", &FieldError{"choice", "Answer a permission ask with recommended (Go) or alternative 1 (Not this) and a reason."}
}

// draftTextOf is the text a Send answer carries: the one the person gave, else the draft.
func draftTextOf(a Ask, c Choice) string {
	if text := strings.TrimSpace(c.Text); text != "" {
		return text
	}
	return a.Draft.Text
}

// sameChoice reports whether an answered ask holds exactly this answer.
func sameChoice(a Ask, c Choice) bool {
	if a.Chosen == nil || a.Chosen.Kind != c.Kind {
		return false
	}
	switch c.Kind {
	case Alternative:
		return a.Chosen.Index == c.Index && (a.Permission == nil || a.Chosen.Text == strings.TrimSpace(c.Text))
	case Custom:
		return a.Chosen.Text == strings.TrimSpace(c.Text)
	case Recommended:
		return a.Draft == nil || a.Chosen.Text == draftTextOf(a, c)
	}
	return true
}
