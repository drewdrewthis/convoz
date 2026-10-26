package httpapi

import (
	"context"
	"slices"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/authz"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/event"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/message"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// messagePorts wires message.Post to the other modules for the caller p. Each port lives in the file of the module that
// implements it (ports_<module>.go); a module that is not built yet has a no-op there, which its work package replaces.
// The ports of this module (mentions, events, the journal) are below.
func messagePorts(p authz.Principal) message.Ports {
	search, uploads, apps, unfurls := searchPort{}, uploadPort{}, appPort{}, unfurlPort{}
	return message.Ports{
		Conversations: conversationPort{p: p}, Reads: readsPort{}, Threads: threadsPort{}, Inbox: inboxPort{}, Places: placesPort{owner: p.SessionID == 0 && p.Role == "owner"}, Asks: askReplyPort{owner: p.SessionID == 0 && p.Role == "owner"}, Journal: postJournal{},
		Search: search, Uploads: uploads, Apps: apps, Mentions: mentionsPort{}, Unfurls: unfurls, Audit: postAuditPort{p},
		Events: messageEvents{},
		// A module that keeps a copy of a message joins the delete and the purge by giving its port the two Cascade methods.
		Cascades: cascadesOf(search, uploads, apps, unfurls, askCascade{}),
	}
}

// triagePorts is messagePorts where the triage right counts: posting a message and reading its edits. Edit,
// delete and every other act keep messagePorts, which asks for a seat.
func triagePorts(p authz.Principal) message.Ports {
	ports := messagePorts(p)
	ports.Conversations = conversationPort{p: p, triage: true}
	return ports
}

// cascadesOf picks the ports that also hold copies of a message.
func cascadesOf(ports ...any) []message.Cascade {
	var out []message.Cascade
	for _, p := range ports {
		if c, ok := p.(message.Cascade); ok {
			out = append(out, c)
		}
	}
	return out
}

// mentionsPort records the mentions of a new message: the handles the body mentions (code, quotes and links excluded) that
// name an identity, now or before a handle change. Nobody is added to a conversation by it (I-18).
type mentionsPort struct{}

func (mentionsPort) RecordMentions(ctx context.Context, d pdb.DBTX, now time.Time, m message.Message) ([]int64, error) {
	handles := message.ParseMentions(m.Body, m.Format)
	if len(handles) == 0 {
		return nil, nil
	}
	dir, err := loadDirectory(ctx, d)
	if err != nil {
		return nil, err
	}
	var ids []int64
	for _, h := range handles {
		// A handle the identity had before still names it (I-51); two handles of one identity make one mention.
		if e, ok := dir.resolve(h); ok && !slices.Contains(ids, e.ID) {
			ids = append(ids, e.ID)
		}
	}
	if err := message.StoreMentions(ctx, d, m.ID, ids); err != nil {
		return nil, err
	}
	return ids, nil
}

// The versioned names of the events of this module.
const (
	eventThreadUpdated = "thread.updated.v1"
	eventEdited        = "message.edited.v1"
	eventDeleted       = "message.deleted.v1"
	eventPurged        = "message.purged.v1"
)

// postJournal writes the thin events of a post.
type postJournal struct{}

func (postJournal) MessageCreated(ctx context.Context, d pdb.DBTX, now time.Time, c message.Created) (int64, error) {
	kind := c.Kind
	if kind == "" {
		kind = "text"
	}
	payload := map[string]any{"id": c.Message, "kind": kind, "conversation_id": c.Conversation}
	if c.ThreadRoot != 0 {
		payload["thread_root_id"] = c.ThreadRoot
		payload["broadcast"] = c.Broadcast
	}
	return event.Write(ctx, d, now, event.Entry{
		Type: event.MessageCreated, Actor: c.Actor, Session: c.Session, Conversation: c.Conversation, Message: c.Message, IdemKey: c.IdemKey, Payload: payload,
	})
}

func (postJournal) ReadMoved(ctx context.Context, d pdb.DBTX, now time.Time, reader, conv, mainID int64) error {
	return messageJournal{}.ReadMoved(ctx, d, now, reader, conv, mainID)
}

// messageEvents writes the events after a post: thin ids only (I-23).
type messageEvents struct{}

func (messageEvents) write(ctx context.Context, d pdb.DBTX, now time.Time, e event.Entry) error {
	_, err := event.Write(ctx, d, now, e)
	return err
}

func (e messageEvents) ThreadUpdated(ctx context.Context, d pdb.DBTX, now time.Time, conv, root, lastReply, replies int64) error {
	return e.write(ctx, d, now, event.Entry{Type: eventThreadUpdated, Conversation: conv, Message: root,
		Payload: map[string]any{"root_id": root, "reply_count": replies, "last_reply_id": lastReply}})
}

func (e messageEvents) Edited(ctx context.Context, d pdb.DBTX, now time.Time, actor, conv, id, at int64, idem string) error {
	return e.write(ctx, d, now, event.Entry{Type: eventEdited, Actor: actor, Conversation: conv, Message: id, IdemKey: idem,
		Payload: map[string]any{"id": id, "edited_at": at}})
}

func (e messageEvents) Deleted(ctx context.Context, d pdb.DBTX, now time.Time, actor, conv, id, at int64) error {
	return e.write(ctx, d, now, event.Entry{Type: eventDeleted, Actor: actor, Conversation: conv, Message: id,
		Payload: map[string]any{"id": id, "deleted_at": at}})
}

func (e messageEvents) Purged(ctx context.Context, d pdb.DBTX, now time.Time, actor, conv, id int64) error {
	return e.write(ctx, d, now, event.Entry{Type: eventPurged, Actor: actor, Conversation: conv, Message: id, Payload: map[string]any{"id": id}})
}

func (e messageEvents) SystemWritten(ctx context.Context, d pdb.DBTX, now time.Time, conv, id int64) error {
	return e.write(ctx, d, now, event.Entry{Type: event.MessageCreated, Conversation: conv, Message: id,
		Payload: map[string]any{"id": id, "kind": "system", "conversation_id": conv}})
}
