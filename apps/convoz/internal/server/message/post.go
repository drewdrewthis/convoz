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
	// ErrPaused means the loop breaker stopped the conversation: agents may not post until a person writes or resumes (I-16).
	ErrPaused = errors.New("the conversation is paused after 20 agent messages in a row")
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

// Reply is the fact "a reply was written", for the module that keeps who is involved in a thread.
type Reply struct {
	Conversation, Root, RootAuthor, Author, ID int64
	// PrevLast is the newest reply before this one, 0 for none: where the thread stood.
	PrevLast int64
	// Mentioned are the identities the reply @mentions.
	Mentioned []int64
}

// Threads keeps who is involved in a thread (readstate module, I-14).
type Threads interface {
	// Replied makes the root's author, the reply's author and the people it @mentions involved, and applies the author's cursor rule.
	Replied(ctx context.Context, d pdb.DBTX, now time.Time, r Reply) error
}

// InboxFanOut queues the new message for one agent (inbox module).
type InboxFanOut interface {
	FanOut(ctx context.Context, d pdb.DBTX, now time.Time, identity, conv, messageID, sourceSeq int64) error
}

// Indexer writes the message into full-text search, inside the same transaction (search module). It is called again with
// the new text after an edit, so the row must be replaced, not added.
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

// Cascade is a module that keeps a copy of a message: search, asks, uploads, apps, transcripts. It is called inside the
// transaction of a delete or a purge, so no copy outlives the message (E-16, I-49). Delete hides: the index row goes, an
// open ask closes, files stop being served. Purge scrubs the bytes.
type Cascade interface {
	MessageDeleted(ctx context.Context, d pdb.DBTX, now time.Time, m Message) error
	MessagePurged(ctx context.Context, d pdb.DBTX, now time.Time, m Message) error
}

// Created is the fact "a message was written": ids only (I-23).
type Created struct {
	Actor, Session, Conversation, Message int64
	ThreadRoot                            int64
	Broadcast                             bool
	IdemKey                               string
}

// Journal writes the thin events of a post.
type Journal interface {
	MessageCreated(ctx context.Context, d pdb.DBTX, now time.Time, c Created) (seq int64, err error)
	ReadMoved(ctx context.Context, d pdb.DBTX, now time.Time, reader, conv, mainID int64) error
}

// Events writes the thin events of everything after the post: a reply, an edit, a delete, a purge, the loop breaker.
type Events interface {
	ThreadUpdated(ctx context.Context, d pdb.DBTX, now time.Time, conv, root, lastReply, replies int64) error
	Edited(ctx context.Context, d pdb.DBTX, now time.Time, actor, conv, id, at int64, idem string) error
	Deleted(ctx context.Context, d pdb.DBTX, now time.Time, actor, conv, id, at int64) error
	Purged(ctx context.Context, d pdb.DBTX, now time.Time, actor, conv, id int64) error
	LoopChanged(ctx context.Context, d pdb.DBTX, now time.Time, actor, conv int64, paused bool) error
	// SystemWritten announces a system line, like a message created (the stream shows it live).
	SystemWritten(ctx context.Context, d pdb.DBTX, now time.Time, conv, id int64) error
}

// Ports are the other modules Post works through, so this module imports none of them. Each later module plugs in its
// own port; a nil port does nothing (a test that does not care about search, uploads or apps leaves it out).
type Ports struct {
	Conversations Conversations
	Reads         Reads
	Threads       Threads
	Inbox         InboxFanOut
	Journal       Journal
	Search        Indexer
	Uploads       UploadBinder
	Apps          AppValidator
	Mentions      Mentions
	Unfurls       UnfurlQueue
	Audit         Audit
	Loop          Loop
	Events        Events
	Cascades      []Cascade
}

// Posted is what Post did. Wake lists the identities whose inbox got an item, for the caller to notify after the commit.
type Posted struct {
	Message  Message
	Replayed bool
	Wake     []int64
	// Paused is true when this post was the one that stopped the conversation (the 20th agent message in a row).
	Paused bool
}

// Post is the whole write of one message, in the caller's transaction (I-4, I-43): the message, the conversation's
// counters, the author's read cursor, one inbox item per other agent participant and the thin events. A repeat of
// the same client id changes nothing and returns Replayed. The author is always the caller (I-40).
//
// An agent's post is refused with ErrPaused while the conversation is paused; its own post counts toward the pause
// and a person's resets the count (I-16). A reply counts like any other message.
func Post(ctx context.Context, d pdb.DBTX, p Ports, now time.Time, draft Draft) (Posted, error) {
	switch access, err := p.Conversations.Access(ctx, d, draft.Conversation); {
	case err != nil:
		return Posted{}, err
	case access == Denied:
		return Posted{}, ErrDenied
	case access == Missing:
		return Posted{}, ErrMissing
	}
	isAgent := draft.Session != 0
	if isAgent && p.Loop != nil {
		paused, err := p.Loop.Paused(ctx, d, draft.Conversation)
		if err != nil {
			return Posted{}, err
		}
		if paused {
			return Posted{}, ErrPaused
		}
	}
	if err := checkRoot(ctx, d, draft); err != nil {
		return Posted{}, err
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
	inMain := draft.ThreadRoot == 0 || draft.Broadcast
	var prevMain int64
	if inMain {
		if prevMain, err = p.Conversations.RecordMainPost(ctx, d, now, draft.Conversation, m.ID, m.Body); err != nil {
			return Posted{}, err
		}
	}
	if draft.ThreadRoot != 0 {
		if err := bumpReplies(ctx, d, p, now, m); err != nil {
			return Posted{}, err
		}
	}
	mentioned, err := afterInsert(ctx, d, p, now, draft, m)
	if err != nil {
		return Posted{}, err
	}
	if draft.ThreadRoot != 0 && p.Threads != nil {
		if err := involve(ctx, d, p, now, draft, m, mentioned); err != nil {
			return Posted{}, err
		}
	}
	seq, err := p.Journal.MessageCreated(ctx, d, now, Created{
		Actor: draft.Author, Session: draft.Session, Conversation: draft.Conversation, Message: m.ID,
		ThreadRoot: draft.ThreadRoot, Broadcast: draft.Broadcast, IdemKey: "message.create:" + draft.ClientID,
	})
	if err != nil {
		return Posted{}, err
	}
	if inMain {
		moved, err := p.Reads.MoveForOwnPost(ctx, d, now, draft.Author, draft.Conversation, prevMain, m.ID)
		if err != nil {
			return Posted{}, err
		}
		if moved {
			if err := p.Journal.ReadMoved(ctx, d, now, draft.Author, draft.Conversation, m.ID); err != nil {
				return Posted{}, err
			}
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
	paused, err := countLoop(ctx, d, p, now, draft, isAgent)
	if err != nil {
		return Posted{}, err
	}
	return Posted{Message: m, Wake: recipients, Paused: paused}, nil
}

// checkRoot refuses a reply whose root is not a top-level, non-system message of the same conversation (I-8).
func checkRoot(ctx context.Context, d pdb.DBTX, draft Draft) error {
	if draft.ThreadRoot == 0 {
		if draft.Broadcast {
			return ErrBadRoot
		}
		return nil
	}
	root, ok, err := get(ctx, d, draft.ThreadRoot)
	switch {
	case err != nil:
		return err
	case !ok || root.ConversationID != draft.Conversation || root.ThreadRootID != 0 || root.Deleted:
		return ErrBadRoot
	case root.Kind == "system":
		return ErrSystemRoot
	}
	return nil
}

func bumpReplies(ctx context.Context, d pdb.DBTX, p Ports, now time.Time, reply Message) error {
	if err := bump(ctx, d, now, reply); err != nil {
		return err
	}
	if p.Events == nil {
		return nil
	}
	root, _, err := get(ctx, d, reply.ThreadRootID)
	if err != nil {
		return err
	}
	return p.Events.ThreadUpdated(ctx, d, now, reply.ConversationID, root.ID, reply.ID, root.ReplyCount)
}

// afterInsert runs the ports that follow a new message in the same transaction: mentions, the search index, the uploads
// it carries, its link preview and its audit line. Any error rolls the whole post back.
func afterInsert(ctx context.Context, d pdb.DBTX, p Ports, now time.Time, draft Draft, m Message) (mentioned []int64, err error) {
	if p.Mentions != nil {
		if mentioned, err = p.Mentions.RecordMentions(ctx, d, now, m); err != nil {
			return nil, err
		}
	}
	if p.Search != nil {
		if err := p.Search.IndexMessage(ctx, d, now, m); err != nil {
			return nil, err
		}
	}
	if len(draft.UploadIDs) > 0 && p.Uploads != nil {
		if err := p.Uploads.BindUploads(ctx, d, now, m, draft.UploadIDs); err != nil {
			return nil, err
		}
	}
	if p.Unfurls != nil {
		if err := p.Unfurls.QueueUnfurl(ctx, d, now, m); err != nil {
			return nil, err
		}
	}
	if p.Audit != nil {
		return mentioned, p.Audit.MessagePosted(ctx, d, now, draft.Session, m)
	}
	return mentioned, nil
}

// involve tells the threads port about a reply: who wrote the root, where the thread stood before it, who it mentions.
func involve(ctx context.Context, d pdb.DBTX, p Ports, now time.Time, draft Draft, reply Message, mentioned []int64) error {
	root, _, err := get(ctx, d, draft.ThreadRoot)
	if err != nil {
		return err
	}
	prev, err := PrevReplyID(ctx, d, draft.ThreadRoot, reply.ID)
	if err != nil {
		return err
	}
	return p.Threads.Replied(ctx, d, now, Reply{
		Conversation: draft.Conversation, Root: draft.ThreadRoot, RootAuthor: root.AuthorID, Author: draft.Author, ID: reply.ID,
		PrevLast: max(prev, draft.ThreadRoot), Mentioned: mentioned,
	})
}
