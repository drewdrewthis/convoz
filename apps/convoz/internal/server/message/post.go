package message

import (
	"context"
	"errors"
	"time"

	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// Access is what the poster may do in a conversation.
type Access int

// The answers of Conversations.Access. An agent is told Denied whether or not the conversation exists.
const (
	Allowed Access = iota
	Denied
	Missing
)

// Errors Post returns beside the ones of the body.
var (
	ErrDenied  = errors.New("not a participant of that conversation")
	ErrMissing = errors.New("no such conversation")
)

// Conversations is what Post needs from the conversation side.
type Conversations interface {
	// Access says whether the poster may write in conv.
	Access(ctx context.Context, d pdb.DBTX, conv int64) (Access, error)
	// RecordMainPost moves the counters for a new main message, names a nameless conversation and returns the
	// newest main message id from before this one.
	RecordMainPost(ctx context.Context, d pdb.DBTX, now time.Time, conv, messageID int64, body string) (prevLastMain int64, err error)
	// AgentRecipients lists the enabled agent participants other than author: the identities that get an inbox item.
	AgentRecipients(ctx context.Context, d pdb.DBTX, conv, author int64) ([]int64, error)
}

// Reads moves the author's read cursor.
type Reads interface {
	// MoveForOwnPost applies the own-post rule (DA-2, I-15) and reports whether the cursor moved.
	MoveForOwnPost(ctx context.Context, d pdb.DBTX, now time.Time, reader, conv, prevLastMain, mainID int64) (bool, error)
}

// InboxFanOut queues the new message for one agent (inbox module).
type InboxFanOut interface {
	FanOut(ctx context.Context, d pdb.DBTX, now time.Time, identity, conv, messageID, sourceSeq int64) error
}

// Indexer writes the message into full-text search, inside the same transaction (search module).
type Indexer interface {
	IndexMessage(ctx context.Context, d pdb.DBTX, now time.Time, m Message) error
}

// UploadBinder binds the uploads a message carries to it, once and only in its own conversation (upload module).
type UploadBinder interface {
	BindUploads(ctx context.Context, d pdb.DBTX, now time.Time, m Message, uploadIDs []string) error
}

// AppValidator checks the app a message carries before anything is written (appkit module).
type AppValidator interface {
	ValidateApp(ctx context.Context, d pdb.DBTX, author int64, app []byte) error
}

// Mentions records who the message mentions and returns their identity ids.
type Mentions interface {
	RecordMentions(ctx context.Context, d pdb.DBTX, now time.Time, m Message) ([]int64, error)
}

// UnfurlQueue queues the preview card of the message's first link (unfurl module).
type UnfurlQueue interface {
	QueueUnfurl(ctx context.Context, d pdb.DBTX, now time.Time, m Message) error
}

// Audit writes the audit line of a post, where the audit rules want one (audit module).
type Audit interface {
	MessagePosted(ctx context.Context, d pdb.DBTX, now time.Time, session int64, m Message) error
}

// Created is the fact "a message was written": ids only (I-23).
type Created struct {
	Actor, Session, Conversation, Message int64
	IdemKey                               string
}

// Journal writes the thin events of a post.
type Journal interface {
	MessageCreated(ctx context.Context, d pdb.DBTX, now time.Time, c Created) (seq int64, err error)
	ReadMoved(ctx context.Context, d pdb.DBTX, now time.Time, reader, conv, mainID int64) error
}

// Ports are the other modules Post works through, so this module imports none of them. Each later module plugs in its
// own port; a nil port does nothing (a test that does not care about search, uploads or apps leaves it out).
type Ports struct {
	Conversations Conversations
	Reads         Reads
	Inbox         InboxFanOut
	Journal       Journal
	Search        Indexer
	Uploads       UploadBinder
	Apps          AppValidator
	Mentions      Mentions
	Unfurls       UnfurlQueue
	Audit         Audit
}

// Posted is what Post did. Wake lists the identities whose inbox got an item, for the caller to notify after the commit.
type Posted struct {
	Message  Message
	Replayed bool
	Wake     []int64
}

// Post is the whole write of one message, in the caller's transaction (I-4, I-43): the message, the conversation's
// counters, the author's read cursor, one inbox item per other agent participant and the thin events. A repeat of
// the same client id changes nothing and returns Replayed. The author is always the caller (I-40).
func Post(ctx context.Context, d pdb.DBTX, p Ports, now time.Time, draft Draft) (Posted, error) {
	switch access, err := p.Conversations.Access(ctx, d, draft.Conversation); {
	case err != nil:
		return Posted{}, err
	case access == Denied:
		return Posted{}, ErrDenied
	case access == Missing:
		return Posted{}, ErrMissing
	}
	if len(draft.App) > 0 && p.Apps != nil {
		if err := p.Apps.ValidateApp(ctx, d, draft.Author, draft.App); err != nil {
			return Posted{}, err
		}
	}
	m, replayed, err := insert(ctx, d, now, draft)
	if err != nil || replayed {
		return Posted{Message: m, Replayed: replayed}, err
	}
	prevMain, err := p.Conversations.RecordMainPost(ctx, d, now, draft.Conversation, m.ID, m.Body)
	if err != nil {
		return Posted{}, err
	}
	if err := afterInsert(ctx, d, p, now, draft, m); err != nil {
		return Posted{}, err
	}
	seq, err := p.Journal.MessageCreated(ctx, d, now, Created{
		Actor: draft.Author, Session: draft.Session, Conversation: draft.Conversation, Message: m.ID, IdemKey: "message.create:" + draft.ClientID,
	})
	if err != nil {
		return Posted{}, err
	}
	moved, err := p.Reads.MoveForOwnPost(ctx, d, now, draft.Author, draft.Conversation, prevMain, m.ID)
	if err != nil {
		return Posted{}, err
	}
	if moved {
		if err := p.Journal.ReadMoved(ctx, d, now, draft.Author, draft.Conversation, m.ID); err != nil {
			return Posted{}, err
		}
	}
	recipients, err := p.Conversations.AgentRecipients(ctx, d, draft.Conversation, draft.Author)
	if err != nil {
		return Posted{}, err
	}
	for _, who := range recipients {
		if err := p.Inbox.FanOut(ctx, d, now, who, draft.Conversation, m.ID, seq); err != nil {
			return Posted{}, err
		}
	}
	return Posted{Message: m, Wake: recipients}, nil
}

// afterInsert runs the ports that follow a new message in the same transaction: mentions, the search index, the uploads
// it carries, its link preview and its audit line. Any error rolls the whole post back.
func afterInsert(ctx context.Context, d pdb.DBTX, p Ports, now time.Time, draft Draft, m Message) error {
	if p.Mentions != nil {
		if _, err := p.Mentions.RecordMentions(ctx, d, now, m); err != nil {
			return err
		}
	}
	if p.Search != nil {
		if err := p.Search.IndexMessage(ctx, d, now, m); err != nil {
			return err
		}
	}
	if len(draft.UploadIDs) > 0 && p.Uploads != nil {
		if err := p.Uploads.BindUploads(ctx, d, now, m, draft.UploadIDs); err != nil {
			return err
		}
	}
	if p.Unfurls != nil {
		if err := p.Unfurls.QueueUnfurl(ctx, d, now, m); err != nil {
			return err
		}
	}
	if p.Audit != nil {
		return p.Audit.MessagePosted(ctx, d, now, draft.Session, m)
	}
	return nil
}
