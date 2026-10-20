package httpapi

import (
	"context"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/authz"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/conversation"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/message"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/prefs"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/search"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/upload"
)

// searchPort keeps the full-text index in step with the messages, in the message transaction: a new or edited message is
// indexed (IndexMessage), a deleted or purged one leaves it (the Cascade methods, I-49). The index holds the plain words of
// the message, the same text the rail preview and `convoz read` show, so a markdown mark is not a word.
type searchPort struct{}

func (searchPort) IndexMessage(ctx context.Context, d pdb.DBTX, _ time.Time, m message.Message) error {
	if m.Kind == "system" || m.Deleted {
		return nil // a system line is not something anyone wrote, and a tombstone has no words
	}
	return search.Index(ctx, d, search.Entry{
		MessageID: m.ID, ConversationID: m.ConversationID, AuthorID: m.AuthorID, Kind: m.Kind, App: m.HasApp,
		Link: search.HasLink(m.Body), CreatedAt: m.CreatedAt, Text: plainText(ctx, d, m),
	})
}

func (searchPort) MessageDeleted(ctx context.Context, d pdb.DBTX, _ time.Time, m message.Message) error {
	return search.Remove(ctx, d, m.ID)
}

func (searchPort) MessagePurged(ctx context.Context, d pdb.DBTX, _ time.Time, m message.Message) error {
	return search.Remove(ctx, d, m.ID)
}

// plainText is the words of a message as search indexes and shows them: its text, and for a message with files their names and, for a
// voice note, the words of its transcript.
func plainText(ctx context.Context, d pdb.DBTX, m message.Message) string {
	by, err := attachmentsOf(ctx, d, []int64{m.ID})
	if err != nil {
		by = nil // a failed read must not stop a post; the entry is made again when the transcript lands
	}
	ups, words := projection(by[m.ID])
	return message.Project(message.Projectable{Format: m.Format, Body: m.Body, Uploads: ups, Transcript: words}, message.Long)
}

// searchScope tells search what the caller may see (I-6): the conversations the caller is in and not in the trash (the owner
// is in all of them), each with the floor from where the caller reads (I-7), the people a from: filter can name, and, for the
// filters that need another module, how to ask it. The conversation module decides who may see what; search applies it.
func searchScope(ctx context.Context, d pdb.DBTX, p authz.Principal, dir directory) (search.Scope, []conversation.Conversation, error) {
	var list []conversation.Conversation
	var err error
	all := p.Role == "owner"
	if !all {
		all, err = isTriage(ctx, d, p)
	}
	switch {
	case err != nil:
	case all:
		list, err = conversation.ListAll(ctx, d)
	default:
		list, err = conversation.ListOf(ctx, d, p.Identity())
	}
	if err != nil {
		return search.Scope{}, nil, err
	}
	sc := search.Scope{
		Pinned:  func() ([]int64, error) { return prefs.Pinned(ctx, d, p.Identity()) },
		Starred: func() ([]int64, error) { return prefs.Starred(ctx, d, p.Identity()) },
		Files:   func() ([]int64, error) { return upload.MessagesWithFiles(ctx, d) },
	}
	var seen []conversation.Conversation
	for _, cv := range list {
		floor, ok, err := canRead(ctx, d, p, cv.ID)
		if err != nil {
			return search.Scope{}, nil, err
		}
		if ok {
			sc.Visible = append(sc.Visible, search.Visible{ID: cv.ID, Title: cv.Title, Floor: floor})
			seen = append(seen, cv)
		}
	}
	for id, e := range dir {
		sc.People = append(sc.People, search.Person{ID: id, Handle: e.Handle})
	}
	return sc, seen, nil
}
