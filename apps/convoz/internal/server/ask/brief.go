package ask

import (
	"context"
	"database/sql"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/ask/db"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// BriefAsk is one ask as the brief shows it. The answer is the label of the chosen option, or the custom text.
type BriefAsk struct {
	ID             int64
	ConversationID int64
	Question       string
	State          string
	Urgent         bool
	CreatedAt      int64
	ResolvedAt     int64
	SnoozedUntil   int64
	Answer         string
}

func answerOf(kind, text sql.NullString, label string) string {
	switch {
	case kind.String == "custom":
		return text.String
	case kind.String == "recommended" && text.String != "": // only a draft ask keeps text with the recommended choice (Send)
		return "Send: " + text.String
	}
	return label
}

// OpenOf lists the open asks of an agent, newest first.
func OpenOf(ctx context.Context, d pdb.DBTX, now time.Time, asker int64, max int) ([]BriefAsk, error) {
	rows, err := db.New(d).BriefOpenAsks(ctx, db.BriefOpenAsksParams{Now: now.UnixMilli(), Asker: asker, MaxRows: int64(max)})
	if err != nil {
		return nil, err
	}
	out := make([]BriefAsk, len(rows))
	for i, r := range rows {
		out[i] = BriefAsk{ID: r.MessageID, ConversationID: r.ConversationID, Question: r.Question, State: "open", Urgent: r.Urgent == 1, CreatedAt: r.CreatedAt, SnoozedUntil: r.SnoozedUntil}
	}
	return out, nil
}

// UnackedOf lists the answers the asking agent has not acked, newest first.
func UnackedOf(ctx context.Context, d pdb.DBTX, asker int64, max int) ([]BriefAsk, error) {
	rows, err := db.New(d).BriefUnackedAnswers(ctx, db.BriefUnackedAnswersParams{Asker: asker, MaxRows: int64(max)})
	if err != nil {
		return nil, err
	}
	out := make([]BriefAsk, len(rows))
	for i, r := range rows {
		out[i] = BriefAsk{ID: r.MessageID, ConversationID: r.ConversationID, Question: r.Question, State: r.State, ResolvedAt: r.ResolvedAt.Int64,
			Answer: answerOf(r.ChosenKind, r.ChosenText, r.ChosenLabel)}
	}
	return out, nil
}

// AnsweredSince lists the asks answered at or after since, newest first. The caller keeps those it may show.
func AnsweredSince(ctx context.Context, d pdb.DBTX, since time.Time, max int) ([]BriefAsk, error) {
	rows, err := db.New(d).BriefDecisions(ctx, db.BriefDecisionsParams{Since: sql.NullInt64{Int64: since.UnixMilli(), Valid: true}, MaxRows: int64(max)})
	if err != nil {
		return nil, err
	}
	out := make([]BriefAsk, len(rows))
	for i, r := range rows {
		out[i] = BriefAsk{ID: r.MessageID, ConversationID: r.ConversationID, Question: r.Question, State: r.State, ResolvedAt: r.ResolvedAt.Int64,
			Answer: answerOf(r.ChosenKind, r.ChosenText, r.ChosenLabel)}
	}
	return out, nil
}
