package httpapi

import (
	"context"
	"maps"
	"slices"
	"strings"
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
		ID: a.ID, ConversationID: a.ConversationID, Asker: dir.person(a.AskerID), Kind: a.Kind(), Question: a.Question, Urgent: a.Urgent, State: a.State,
		CloseReason: a.CloseReason, Options: make([]wire.AskOption, 0, len(a.Options)), Answer: a.Answer(), AnswerVia: a.AnswerVia,
		ResolvedAt: a.ResolvedAt, AckedAt: a.AckedAt, Version: a.Version, CreatedAt: a.CreatedAt,
	}
	if a.OwnersCall != nil {
		v.OwnersCall = &wire.OwnersCall{Kind: a.OwnersCall.Kind, Reason: a.OwnersCall.Reason}
	}
	if a.Draft != nil { // a draft ask has no stored call: it is always the fixed one
		v.OwnersCall = &wire.OwnersCall{Kind: wire.OwnersCallInYourName, Reason: wire.InYourNameReason}
		v.Draft = &wire.AskDraft{Text: a.Draft.Text, Original: a.Draft.Original, OriginalFrom: a.Draft.OriginalFrom}
		if a.Chosen != nil {
			v.Reply = &wire.AskReply{Send: a.Chosen.Kind == ask.Recommended, Text: a.Chosen.Text}
		}
	}
	if a.Permission != nil {
		v.Permission = ptr(wire.AskPermission(*a.Permission))
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
	v.Answers, v.Changed = a.Answers, a.Changed
	for _, h := range a.History {
		row := wire.AskHistoryRow{Version: h.Version, Event: h.Event, ToState: h.ToState, At: h.At}
		if h.By != 0 {
			row.By = ptr(dir.person(h.By))
		}
		v.History = append(v.History, row)
		if h.Event == "updated" {
			v.Revision++
		}
	}
	if v.Revision > 0 {
		v.Revision++
	}
	return v
}

// askViews builds the views of asks for one reader: each with the conversation it is in (id and title) and the thread it was
// asked in. Nothing is hidden by canSee here: the caller has already decided that the reader may see these asks.
// snoozed is the reader's own snooze by ask id; nil for a reader who has none (an agent). reader is the person (0 for an agent):
// it decides the unread replies of each ask's thread, which are counted in one query per conversation.
func askViews(ctx context.Context, d pdb.DBTX, dir directory, list []ask.Ask, snoozed map[int64]int64, reader int64) ([]wire.AskView, error) {
	titles := map[int64]*wire.AskConversation{}
	out := make([]wire.AskView, 0, len(list))
	rootsOf := map[int64][]int64{} // the thread roots to count, by conversation
	rootOf := make([]int64, 0, len(list))
	list = slices.Clone(list)
	if err := ask.MarkReplyAnswered(ctx, d, askThreads{}, list); err != nil {
		return nil, err
	}
	for _, a := range list {
		v, err := dir.askWithReply(ctx, d, a)
		if err != nil {
			return nil, err
		}
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
			root := m
			if m.ThreadRootID != 0 {
				if root, _, err = message.GetAny(ctx, d, m.ThreadRootID); err != nil {
					return nil, err
				}
			}
			v.ReplyCount = root.ReplyCount
			if root.ReplyCount > 0 {
				rootsOf[a.ConversationID] = append(rootsOf[a.ConversationID], root.ID)
			}
			rootOf = append(rootOf, root.ID)
		} else {
			rootOf = append(rootOf, 0)
		}
		v.SnoozedUntil = snoozed[a.ID]
		out = append(out, v)
	}
	unread := map[int64]int64{}
	for conv, roots := range rootsOf {
		counts, err := unreadRepliesOf(ctx, d, reader, conv, roots)
		if err != nil {
			return nil, err
		}
		maps.Copy(unread, counts)
	}
	for i := range out {
		out[i].UnreadReplies = unread[rootOf[i]]
	}
	return out, nil
}

// markedAsk is the ask a with its reply answered flag set, for a caller that reads one ask (askViews marks a list).
func markedAsk(ctx context.Context, d pdb.DBTX, a ask.Ask) (ask.Ask, error) {
	list := []ask.Ask{a}
	err := ask.MarkReplyAnswered(ctx, d, askThreads{}, list)
	return list[0], err
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
	list, err := askViews(ctx, d, dir, []ask.Ask{a}, snoozed, person)
	if err != nil {
		return wire.AskView{}, err
	}
	return list[0], nil
}

// askWithReply is askBase plus the owner's latest reply on an ask that waits on the agent, which is read from its message.
// Once someone else posted after that reply, the ask no longer waits, so the card drops "You replied · waiting on @agent".
func (dir directory) askWithReply(ctx context.Context, d pdb.DBTX, a ask.Ask) (wire.AskView, error) {
	v := dir.askBase(a)
	if !a.WaitingOnAgent() || a.OwnerReplyID == 0 {
		return v, nil
	}
	reply, err := ownerReplyOf(ctx, d, a)
	v.OwnerReply = reply
	return v, err
}

// ownerReplyOf is the owner's latest reply on an open ask: its first words (a voice note's transcript included), cut at
// wire.OwnerReplyExcerpt characters. Nil when the reply message is gone.
func ownerReplyOf(ctx context.Context, d pdb.DBTX, a ask.Ask) (*wire.AskOwnerReply, error) {
	m, found, err := message.GetAny(ctx, d, a.OwnerReplyID)
	if err != nil || !found {
		return nil, err
	}
	text := strings.Join(strings.Fields(plainText(ctx, d, m)), " ")
	if r := []rune(text); len(r) > wire.OwnerReplyExcerpt {
		text = string(r[:wire.OwnerReplyExcerpt]) + "…"
	}
	return &wire.AskOwnerReply{ID: m.ID, Text: text, At: a.OwnerRepliedAt}, nil
}
