package ask

import (
	"context"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/ask/db"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// closeOne closes an open or dismissed ask for a reason (design §8.1): the snoozes go, the history grows (a withdrawal by
// the asking agent, any other close by the system), the counter drops when the ask was open, and the thin event is written.
// notifyAsker tells the asking agent's inbox too (the ask message was deleted).
func closeOne(ctx context.Context, d pdb.DBTX, p Ports, now time.Time, a Ask, reason string, by int64, notifyAsker bool) error {
	q := db.New(d)
	won, err := q.MarkClosed(ctx, db.MarkClosedParams{Reason: reason, Now: now.UnixMilli(), MessageID: a.ID, Version: a.Version})
	if err != nil {
		return err
	}
	if won == 0 {
		return lost(ctx, d, a.ID)
	}
	if err := q.DeleteSnoozesOf(ctx, a.ID); err != nil {
		return err
	}
	event := "close"
	if reason == ReasonWithdrawn {
		event = "withdraw"
	}
	if err := q.InsertTransition(ctx, db.InsertTransitionParams{MessageID: a.ID, Version: a.Version + 1, Event: event, ToState: Closed, ByIdentity: nullInt(by), At: now.UnixMilli()}); err != nil {
		return err
	}
	if a.State == Open {
		if err := p.Conversations.AddOpenAsks(ctx, d, a.ConversationID, -1); err != nil {
			return err
		}
	}
	seq, err := p.Journal.Write(ctx, d, now, Change{
		Type: EventClosed, Actor: by, Conversation: a.ConversationID, Message: a.ID,
		Payload: map[string]any{"message_id": a.ID, "state": Closed, "version": a.Version + 1, "reason": reason},
	})
	if err != nil {
		return err
	}
	if notifyAsker {
		return p.Inbox.AskResolved(ctx, d, now, a.AskerID, a.ConversationID, a.ID, seq)
	}
	return nil
}

// closeAll closes each ask by message id.
func closeAll(ctx context.Context, d pdb.DBTX, p Ports, now time.Time, ids []int64, reason string, notifyAsker bool) error {
	if len(ids) == 0 {
		return nil
	}
	asks, err := Views(ctx, d, ids)
	if err != nil {
		return err
	}
	for _, id := range ids {
		if err := closeOne(ctx, d, p, now, asks[id], reason, 0, notifyAsker); err != nil {
			return err
		}
	}
	return nil
}

// CloseForRemoval closes the open and the dismissed asks an agent has in a conversation it was removed from or left
// (I-19): each goes to "closed" with the reason "removed", and the history records the system as the one who did it.
func CloseForRemoval(ctx context.Context, d pdb.DBTX, p Ports, now time.Time, conversationID, agentID int64) error {
	ids, err := db.New(d).AsksToCloseOnRemoval(ctx, db.AsksToCloseOnRemovalParams{ConversationID: conversationID, AskerID: agentID})
	if err != nil {
		return err
	}
	return closeAll(ctx, d, p, now, ids, ReasonRemoved, false)
}

// CloseForAgent closes every open and dismissed ask of an agent that was disabled, in every conversation (I-38).
func CloseForAgent(ctx context.Context, d pdb.DBTX, p Ports, now time.Time, agentID int64) error {
	ids, err := db.New(d).AsksOfAskerToClose(ctx, agentID)
	if err != nil {
		return err
	}
	return closeAll(ctx, d, p, now, ids, ReasonRevoked, false)
}

// OwnerReplied records the owner's reply in a thread on the one open ask that thread is for (the ask whose message roots it, else
// the newest ask asked inside it; snoozed ones are open), so a thread shared by two asks never lists the reply twice. The ask stays
// open: it remembers the reply (time and message), the history grows and the asking agent is told to answer in the thread and update
// the same ask. A second reply moves the reply on and tells the agent again.
func OwnerReplied(ctx context.Context, d pdb.DBTX, p Ports, now time.Time, conversationID, threadRoot, replyID, by int64) error {
	q := db.New(d)
	ids, err := q.OpenAskOfThread(ctx, db.OpenAskOfThreadParams{ConversationID: conversationID, ThreadRoot: threadRoot})
	if err != nil || len(ids) == 0 {
		return err
	}
	asks, err := Views(ctx, d, ids)
	if err != nil {
		return err
	}
	for _, id := range ids {
		a := asks[id]
		won, err := q.MarkOwnerReplied(ctx, db.MarkOwnerRepliedParams{Now: now.UnixMilli(), ReplyID: replyID, MessageID: a.ID, Version: a.Version})
		if err != nil {
			return err
		}
		if won == 0 {
			return lost(ctx, d, a.ID)
		}
		if err := q.InsertTransition(ctx, db.InsertTransitionParams{MessageID: a.ID, Version: a.Version + 1, Event: "owner_replied", ToState: Open, ByIdentity: nullInt(by), At: now.UnixMilli()}); err != nil {
			return err
		}
		seq, err := p.Journal.Write(ctx, d, now, Change{
			Type: EventOwnerReplied, Actor: by, Conversation: a.ConversationID, Message: a.ID,
			Payload: map[string]any{"message_id": a.ID, "state": Open, "version": a.Version + 1, "reply_id": replyID},
		})
		if err != nil {
			return err
		}
		if err := p.Inbox.AskResolved(ctx, d, now, a.AskerID, a.ConversationID, a.ID, seq); err != nil {
			return err
		}
	}
	return nil
}

// MessageDeleted closes the ask of a deleted ask message and tells its agent. An answered or closed ask keeps its decision:
// only the message is a tombstone. A message that carries no ask is left alone.
func MessageDeleted(ctx context.Context, d pdb.DBTX, p Ports, now time.Time, messageID int64) error {
	a, err := Get(ctx, d, messageID)
	if err == ErrNotFound || (err == nil && a.State != Open && a.State != Dismissed) {
		return nil
	}
	if err != nil {
		return err
	}
	return closeOne(ctx, d, p, now, a, ReasonDeleted, 0, true)
}

// MessagePurged empties what the ask holds of the message: the question, the options and a custom answer (I-49).
// The state and the history stay.
func MessagePurged(ctx context.Context, d pdb.DBTX, now time.Time, messageID int64) error {
	q := db.New(d)
	if err := q.ScrubAsk(ctx, db.ScrubAskParams{Now: now.UnixMilli(), MessageID: messageID}); err != nil {
		return err
	}
	return q.DeleteOptionsOf(ctx, messageID)
}
