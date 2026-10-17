package httpapi

import (
	"context"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/message"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/readstate"
)

type readsPort struct{}

func (readsPort) MoveForOwnPost(ctx context.Context, d pdb.DBTX, now time.Time, reader, conv, prevLastMain, mainID int64) (bool, error) {
	return readstate.MoveForOwnPost(ctx, d, now, reader, conv, prevLastMain, mainID)
}

// threadsPort keeps who is involved in a thread (I-14, DA-3): the root's author, the replier and anyone @mentioned in a reply.
type threadsPort struct{}

func (threadsPort) Replied(ctx context.Context, d pdb.DBTX, now time.Time, r message.Reply) error {
	if r.RootAuthor != 0 && r.RootAuthor != r.Author {
		// the root's author is in the thread from its first reply; what came before this reply is read, this one is not
		if err := readstate.Involve(ctx, d, now, r.RootAuthor, r.Conversation, r.Root, r.PrevLast); err != nil {
			return err
		}
	}
	if err := readstate.Involve(ctx, d, now, r.Author, r.Conversation, r.Root, r.ID); err != nil {
		return err
	}
	if err := readstate.MoveThreadForOwnReply(ctx, d, r.Author, r.Conversation, r.Root, r.PrevLast, r.ID); err != nil {
		return err
	}
	for _, who := range r.Mentioned {
		if who == r.Author {
			continue
		}
		// a mention brings the person in with this reply unread
		if err := readstate.Involve(ctx, d, now, who, r.Conversation, r.Root, r.ID-1); err != nil {
			return err
		}
	}
	return nil
}
