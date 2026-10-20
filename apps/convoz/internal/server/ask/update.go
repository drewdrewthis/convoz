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

// MaxAnswers is the longest summary of answers an update carries.
const MaxAnswers = 1000

// Updating is what the asking agent changes in its open ask. An empty Question, a nil Recommended and an empty OwnersCallReason keep what
// the ask has; Recommended and Alternatives are given together and replace the options as a whole. Answers is the short summary of
// the answers to the owner's questions; it is required once the owner replied in the ask's thread.
type Updating struct {
	ID, By           int64
	Question         string
	Recommended      *Option
	Alternatives     []Option
	OwnersCallReason string
	Answers          string
}

// Update changes an open ask in place (the owner's Q&A in its thread ends in an update, not in a new ask): the content the agent
// gave, the summary of the answers and what changed are stored, the version moves, the owner's reply mark and the snoozes clear so the ask
// comes back to Now's main list, and the history and the thin event say it. Only the asking agent may update, and only while the ask is open.
func Update(ctx context.Context, d pdb.DBTX, p Ports, now time.Time, in Updating) (Ask, error) {
	a, err := Get(ctx, d, in.ID)
	if err != nil {
		return Ask{}, err
	}
	if a.AskerID != in.By {
		return Ask{}, ErrNotAsker
	}
	if a.State != Open {
		return Ask{}, conflict(a)
	}
	next, changed, err := apply(a, in)
	if err != nil {
		return Ask{}, err
	}
	q := db.New(d)
	won, err := q.UpdateAsk(ctx, db.UpdateAskParams{
		Question: next.Question, OwnersCallReason: sql.NullString{String: reasonOf(next), Valid: a.OwnersCall != nil}, Answers: nullText(in.Answers),
		Changed: strings.Join(changed, ", "), Now: now.UnixMilli(), MessageID: a.ID, Version: a.Version,
	})
	if err != nil {
		return Ask{}, err
	}
	if won == 0 {
		return Ask{}, lost(ctx, d, a.ID)
	}
	if contains(changed, "options") {
		if err := q.DeleteOptionsOf(ctx, a.ID); err != nil {
			return Ask{}, err
		}
		for i, o := range next.Options {
			if err := q.InsertOption(ctx, db.InsertOptionParams{MessageID: a.ID, Idx: int64(i), Label: o.Label, Why: o.Why}); err != nil {
				return Ask{}, err
			}
		}
	}
	if contains(changed, "question") {
		if err := p.Messages.SetQuestion(ctx, d, now, a.ID, next.Question); err != nil {
			return Ask{}, err
		}
	}
	if err := q.DeleteSnoozesOf(ctx, a.ID); err != nil {
		return Ask{}, err
	}
	if err := q.InsertTransition(ctx, db.InsertTransitionParams{MessageID: a.ID, Version: a.Version + 1, Event: "updated", ToState: Open, ByIdentity: nullInt(in.By), At: now.UnixMilli()}); err != nil {
		return Ask{}, err
	}
	if _, err := p.Journal.Write(ctx, d, now, Change{
		Type: EventUpdated, Actor: in.By, Conversation: a.ConversationID, Message: a.ID,
		Payload: map[string]any{"message_id": a.ID, "state": Open, "version": a.Version + 1, "urgent": a.Urgent},
	}); err != nil {
		return Ask{}, err
	}
	return Get(ctx, d, a.ID)
}

// apply checks an update against the ask and returns the ask as it will stand, and what changed ("question", "options", "owner's call",
// else "answers"). Nothing to change and no answers is a refusal.
func apply(a Ask, in Updating) (next Ask, changed []string, err error) {
	next = a
	if in.Question != "" && in.Question != a.Question {
		next.Question = in.Question
		if err := (New{Question: in.Question}).checkQuestion(); err != nil {
			return Ask{}, nil, err
		}
		changed = append(changed, "question")
	}
	if in.Recommended != nil || len(in.Alternatives) > 0 {
		if a.Draft != nil {
			return Ask{}, nil, &FieldError{"options", "A draft ask has no options to change."}
		}
		if in.Recommended == nil || len(in.Alternatives) < 1 || len(in.Alternatives) > MaxAlternatives {
			return Ask{}, nil, &FieldError{"alternatives", "Give the recommended option and 1 to 4 alternatives."}
		}
		opts := append([]Option{*in.Recommended}, in.Alternatives...)
		for _, o := range opts {
			if err := checkOption(o); err != nil {
				return Ask{}, nil, err
			}
		}
		if !sameOptions(a.Options, opts) {
			next.Options = opts
			changed = append(changed, "options")
		}
	}
	if r := in.OwnersCallReason; r != "" && a.OwnersCall != nil && r != a.OwnersCall.Reason {
		if utf8.RuneCountInString(r) > 280 {
			return Ask{}, nil, &FieldError{"owners_call", "The reason is at most 280 characters."}
		}
		next.OwnersCall = &OwnersCall{Kind: a.OwnersCall.Kind, Reason: r}
		changed = append(changed, "owner's call")
	}
	answers := strings.TrimSpace(in.Answers)
	switch {
	case utf8.RuneCountInString(in.Answers) > MaxAnswers:
		return Ask{}, nil, &FieldError{"answers", "The answers are at most 1000 characters."}
	case answers == "" && a.OwnerRepliedAt > 0:
		return Ask{}, nil, &FieldError{"answers", "The owner replied in the thread: answer the questions in the thread, then give a short summary with --answers."}
	case answers == "" && len(changed) == 0:
		return Ask{}, nil, &FieldError{"update", "Nothing to update: change the question, the options or the reason, or give --answers."}
	case len(changed) == 0:
		changed = []string{"answers"}
	}
	return next, changed, nil
}

func reasonOf(a Ask) string {
	if a.OwnersCall == nil {
		return ""
	}
	return a.OwnersCall.Reason
}

func sameOptions(a, b []Option) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func contains(list []string, v string) bool {
	for _, s := range list {
		if s == v {
			return true
		}
	}
	return false
}
