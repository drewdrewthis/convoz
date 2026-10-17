package httpapi

import (
	"context"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/ask"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/conversation"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/message"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

// askBase turns an ask into what a reader gets, names looked up now. The conversation, the thread and the reader's own
// snooze are added by askViews.
func (dir directory) askBase(a ask.Ask) wire.AskView {
	v := wire.AskView{
		ID: a.ID, ConversationID: a.ConversationID, Asker: dir.person(a.AskerID), Question: a.Question, Urgent: a.Urgent, State: a.State,
		CloseReason: a.CloseReason, Options: make([]wire.AskOption, 0, len(a.Options)), Answer: a.Answer(), AnswerVia: a.AnswerVia,
		ResolvedAt: a.ResolvedAt, AckedAt: a.AckedAt, Version: a.Version, CreatedAt: a.CreatedAt,
	}
	for i, o := range a.Options {
		v.Options = append(v.Options, wire.AskOption{Label: o.Label, Why: o.Why, Recommended: i == 0})
	}
	if a.Chosen != nil {
		v.Chosen = &wire.AskChoice{Kind: a.Chosen.Kind, Index: a.Chosen.Index, Text: a.Chosen.Text}
	}
	if a.ResolvedBy != 0 {
		v.ResolvedBy = ptr(dir.person(a.ResolvedBy))
	}
	for _, h := range a.History {
		row := wire.AskHistoryRow{Version: h.Version, Event: h.Event, ToState: h.ToState, At: h.At}
		if h.By != 0 {
			row.By = ptr(dir.person(h.By))
		}
		v.History = append(v.History, row)
	}
	return v
}

// askViews builds the views of asks for one reader: each with the conversation it is in (id and title) and the thread it was
// asked in. Nothing is hidden by canSee here: the caller has already decided that the reader may see these asks.
// snoozed is the reader's own snooze by ask id; nil for a reader who has none (an agent).
func askViews(ctx context.Context, d pdb.DBTX, dir directory, list []ask.Ask, snoozed map[int64]int64) ([]wire.AskView, error) {
	titles := map[int64]*wire.AskConversation{}
	out := make([]wire.AskView, 0, len(list))
	for _, a := range list {
		v := dir.askBase(a)
		conv, seen := titles[a.ConversationID]
		if !seen {
			c, found, err := conversation.GetAny(ctx, d, a.ConversationID)
			if err != nil {
				return nil, err
			}
			conv = &wire.AskConversation{ID: a.ConversationID}
			if found && c.Title != "" {
				conv.Title = ptr(c.Title)
			}
			titles[a.ConversationID] = conv
		}
		v.Conversation = conv
		if m, found, err := message.GetAny(ctx, d, a.ID); err != nil {
			return nil, err
		} else if found {
			v.ThreadRootID, v.App = m.ThreadRootID, appView(m.App)
		}
		v.SnoozedUntil = snoozed[a.ID]
		out = append(out, v)
	}
	return out, nil
}

// oneAskView is the view of a single ask for a reader, with the reader's snooze when the reader is a person.
func (s *Server) oneAskView(ctx context.Context, d pdb.DBTX, dir directory, a ask.Ask, person int64, now time.Time) (wire.AskView, error) {
	var snoozed map[int64]int64
	if person != 0 {
		var err error
		if snoozed, err = ask.SnoozedUntil(ctx, d, person, now); err != nil {
			return wire.AskView{}, err
		}
	}
	list, err := askViews(ctx, d, dir, []ask.Ask{a}, snoozed)
	if err != nil {
		return wire.AskView{}, err
	}
	return list[0], nil
}
