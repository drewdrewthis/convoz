package message

import (
	"context"
	"time"

	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// LoopLimit is how many agent messages in a row pause a conversation (I-16).
const LoopLimit = 20

// Loop is the loop breaker's state in the conversation (I-16). The columns are the conversation module's; the composition
// root implements this over it.
type Loop interface {
	// Paused says whether agents are stopped in conv.
	Paused(ctx context.Context, d pdb.DBTX, conv int64) (bool, error)
	// CountAgentPost adds one agent message (or ask) to the streak; paused is true when it was the LoopLimit-th.
	CountAgentPost(ctx context.Context, d pdb.DBTX, now time.Time, conv int64) (paused bool, err error)
	// Reset sets the streak to 0 and lifts a pause; wasPaused says there was one.
	Reset(ctx context.Context, d pdb.DBTX, conv int64) (wasPaused bool, err error)
}

// countLoop applies a new message to the streak. A person's message resets it; an agent's adds one, and the one that reaches
// the limit pauses the conversation with a system line. A message sent through an app is not a person's (I-46), and the
// app route says so by passing no human.
func countLoop(ctx context.Context, d pdb.DBTX, p Ports, now time.Time, draft Draft, isAgent bool) (paused bool, err error) {
	if p.Loop == nil || draft.ViaApp != nil {
		return false, nil
	}
	if !isAgent {
		lifted, err := p.Loop.Reset(ctx, d, draft.Conversation)
		if err != nil || !lifted {
			return false, err
		}
		return false, loopChanged(ctx, d, p, now, draft.Author, draft.Conversation, false)
	}
	if paused, err = p.Loop.CountAgentPost(ctx, d, now, draft.Conversation); err != nil || !paused {
		return false, err
	}
	if _, err := WriteSystem(ctx, d, p, now, draft.Conversation, SystemLine{T: "conversation.paused", Streak: LoopLimit}); err != nil {
		return false, err
	}
	return true, loopChanged(ctx, d, p, now, draft.Author, draft.Conversation, true)
}

func loopChanged(ctx context.Context, d pdb.DBTX, p Ports, now time.Time, actor, conv int64, paused bool) error {
	if p.Events == nil {
		return nil
	}
	return p.Events.LoopChanged(ctx, d, now, actor, conv, paused)
}

// Resume lifts a pause a person asked for (the Resume button) and says so in the conversation. It does nothing, and says
// false, when the conversation is not paused.
func Resume(ctx context.Context, d pdb.DBTX, p Ports, now time.Time, conv, by int64) (bool, error) {
	if p.Loop == nil {
		return false, nil
	}
	lifted, err := p.Loop.Reset(ctx, d, conv)
	if err != nil || !lifted {
		return false, err
	}
	if _, err := WriteSystem(ctx, d, p, now, conv, SystemLine{T: "conversation.resumed", By: by}); err != nil {
		return false, err
	}
	return true, loopChanged(ctx, d, p, now, by, conv, false)
}
