package message

import (
	"context"
	"errors"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/message/db"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// Rules of editing and deleting (design §2.3, E-16, E-18).
const (
	// AgentEditWindow is how long after posting an agent may still edit.
	AgentEditWindow = 24 * time.Hour
)

// Errors the edit, delete and purge functions return.
var (
	ErrNotFound    = errors.New("no such message")
	ErrNotAuthor   = errors.New("only the author may do that")
	ErrNotEditable = errors.New("this kind of message cannot be changed")
	ErrTooOld      = errors.New("an agent may edit a message for 24 hours")
)

// Actor is who edits or deletes: an identity, and whether it is an agent or the owner.
type Actor struct {
	Identity int64
	Agent    bool
	Owner    bool
}

// load finds a message the actor may touch: it exists and the actor sees its conversation.
func load(ctx context.Context, d pdb.DBTX, p Ports, id int64) (Message, error) {
	m, ok, err := get(ctx, d, id)
	if err != nil {
		return Message{}, err
	}
	if !ok {
		return Message{}, ErrNotFound
	}
	switch access, err := p.Conversations.Access(ctx, d, m.ConversationID); {
	case err != nil:
		return Message{}, err
	case access == Missing:
		return Message{}, ErrNotFound
	case access == Denied:
		return Message{}, ErrDenied
	}
	return m, nil
}

// Edit replaces the body and format of the actor's own message. The previous text goes to the history. Mentions, the inbox
// and the author's read cursor do not change: an edit never pulls anyone in (E-18). An edit that changes nothing is a
// no-op, so a retry is safe. changed says whether anything was written.
func Edit(ctx context.Context, d pdb.DBTX, p Ports, now time.Time, who Actor, id int64, body, format, clientID string) (m Message, changed bool, err error) {
	m, err = load(ctx, d, p, id)
	if err != nil {
		return Message{}, false, err
	}
	if format == "" {
		format = m.Format
	}
	switch {
	case m.Deleted:
		return Message{}, false, ErrNotFound
	case m.Kind != "text" || m.AnswersAskID != 0 || m.ViaAppID != 0:
		return Message{}, false, ErrNotEditable // before the author: nobody wrote a system line, and no one may change an ask or an answer
	case m.AuthorID != who.Identity:
		return Message{}, false, ErrNotAuthor
	case who.Agent && now.Sub(time.UnixMilli(m.CreatedAt)) > AgentEditWindow:
		return Message{}, false, ErrTooOld
	}
	if err := checkText(body, format); err != nil {
		return Message{}, false, err
	}
	if body == m.Body && format == m.Format {
		return m, false, nil
	}
	q := db.New(d)
	at := now.UnixMilli()
	if err := q.InsertEdit(ctx, db.InsertEditParams{MessageID: id, PrevBody: m.Body, PrevFormat: m.Format, EditedBy: who.Identity, EditedAt: at}); err != nil {
		return Message{}, false, err
	}
	if err := q.ApplyEdit(ctx, db.ApplyEditParams{ID: id, Body: body, Format: format, EditedAt: nullInt(at)}); err != nil {
		return Message{}, false, err
	}
	m.Body, m.Format, m.EditedAt = body, format, at
	if p.Search != nil {
		if err := p.Search.IndexMessage(ctx, d, now, m); err != nil {
			return Message{}, false, err
		}
	}
	if p.Events != nil {
		err = p.Events.Edited(ctx, d, now, who.Identity, m.ConversationID, id, at, "message.edit:"+clientID)
	}
	return m, true, err
}

// PastEdit is one entry of a message's history: the text it had before an edit.
type PastEdit struct {
	Body, Format string
	By           int64
	At           int64
}

// History lists the earlier versions of a message, oldest first. A deleted message has none to show.
func History(ctx context.Context, d pdb.DBTX, p Ports, id int64) ([]PastEdit, error) {
	m, err := load(ctx, d, p, id)
	if err != nil {
		return nil, err
	}
	if m.Deleted {
		return nil, ErrNotFound
	}
	rows, err := db.New(d).ListEdits(ctx, id)
	out := make([]PastEdit, 0, len(rows))
	for _, r := range rows {
		out = append(out, PastEdit{Body: r.PrevBody, Format: r.PrevFormat, By: r.EditedBy, At: r.EditedAt})
	}
	return out, err
}

// Delete turns a message into a tombstone, everywhere at once (E-16): the author may delete their own, the owner any.
// In the same transaction every module that holds a copy hides it. Deleting a deleted message changes nothing.
func Delete(ctx context.Context, d pdb.DBTX, p Ports, now time.Time, who Actor, id int64) (m Message, err error) {
	m, err = load(ctx, d, p, id)
	switch {
	case err != nil:
		return Message{}, err
	case m.Deleted:
		return m, nil
	case m.Kind == "system":
		return Message{}, ErrNotEditable
	case !who.Owner && m.AuthorID != who.Identity:
		return Message{}, ErrNotAuthor
	}
	at := now.UnixMilli()
	if _, err := db.New(d).MarkDeleted(ctx, db.MarkDeletedParams{ID: id, At: nullInt(at), By: nullInt(who.Identity)}); err != nil {
		return Message{}, err
	}
	m.Deleted, m.Body = true, ""
	for _, c := range p.Cascades {
		if err := c.MessageDeleted(ctx, d, now, m); err != nil {
			return Message{}, err
		}
	}
	if p.Events != nil {
		err = p.Events.Deleted(ctx, d, now, who.Identity, m.ConversationID, id, at)
	}
	return m, err
}

// Purge scrubs a message for good (I-49): the body, the app and its result, the edit history and the mentions are emptied,
// and every module that holds a copy scrubs it. A message that was not deleted is deleted first. Only the owner purges;
// the caller has spent the step-up.
func Purge(ctx context.Context, d pdb.DBTX, p Ports, now time.Time, who Actor, id int64) (Message, error) {
	m, err := load(ctx, d, p, id)
	switch {
	case err != nil:
		return Message{}, err
	case m.Kind == "system":
		return Message{}, ErrNotEditable
	}
	if !m.Deleted {
		if m, err = Delete(ctx, d, p, now, who, id); err != nil {
			return Message{}, err
		}
	}
	q := db.New(d)
	at := now.UnixMilli()
	if err := q.ScrubMessage(ctx, db.ScrubMessageParams{ID: id, At: nullInt(at), By: nullInt(who.Identity)}); err != nil {
		return Message{}, err
	}
	if err := q.DeleteEdits(ctx, id); err != nil {
		return Message{}, err
	}
	if err := q.DeleteMentions(ctx, id); err != nil {
		return Message{}, err
	}
	m.Purged = true
	for _, c := range p.Cascades {
		if err := c.MessagePurged(ctx, d, now, m); err != nil {
			return Message{}, err
		}
	}
	if p.Events != nil {
		err = p.Events.Purged(ctx, d, now, who.Identity, m.ConversationID, id)
	}
	return m, err
}

// bump moves the reply counters of a thread root for a new reply.
func bump(ctx context.Context, d pdb.DBTX, now time.Time, reply Message) error {
	return db.New(d).BumpReplies(ctx, db.BumpRepliesParams{ReplyID: nullInt(reply.ID), At: nullInt(now.UnixMilli()), RootID: reply.ThreadRootID})
}
