package search

import (
	"context"
	"encoding/json"
	"regexp"

	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/search/db"
)

// Entry is one message as search stores it: its words, and the facts a filter reads.
type Entry struct {
	MessageID, ConversationID, AuthorID int64
	Kind                                string // "text" or "ask"
	App, Link                           bool
	CreatedAt                           int64
	// Text is the plain words of the message, what a query matches.
	Text string
}

// FTS5 sqlc cannot parse (design §9, "FTS SQL as Go literals"), kept here as plain literals.
const (
	ftsDelete   = `DELETE FROM messages_fts WHERE rowid = ?`
	ftsInsert   = `INSERT INTO messages_fts (rowid, text) VALUES (?, ?)`
	ftsOptimize = `INSERT INTO messages_fts (messages_fts) VALUES ('optimize')`
)

// Index writes the message into the index, or replaces what an earlier call wrote (an edit). It runs in the message's
// transaction, so a message and its entry exist together or not at all (I-4).
func Index(ctx context.Context, d pdb.DBTX, e Entry) error {
	err := db.New(d).UpsertEntry(ctx, db.UpsertEntryParams{
		MessageID: e.MessageID, ConversationID: e.ConversationID, AuthorID: e.AuthorID, Kind: e.Kind,
		IsApp: flag(e.App), HasLink: flag(e.Link), CreatedAt: e.CreatedAt,
	})
	if err != nil {
		return err
	}
	// A contentless table is replaced by deleting the row and inserting it again.
	if _, err := d.ExecContext(ctx, ftsDelete, e.MessageID); err != nil {
		return err
	}
	_, err = d.ExecContext(ctx, ftsInsert, e.MessageID, e.Text)
	return err
}

// Remove takes a message out of the index: a deleted or purged message is found by nobody. Removing one that is not there
// changes nothing.
func Remove(ctx context.Context, d pdb.DBTX, messageID int64) error {
	return db.New(d).DeleteEntry(ctx, messageID)
}

// Optimize rewrites the index so the words of removed messages leave its segments too. Removing a row only hides it: its
// words stay in the segment files until a merge (design §14 "Residue"). The nightly maintenance of the ops module runs this.
func Optimize(ctx context.Context, d pdb.DBTX) error {
	_, err := d.ExecContext(ctx, ftsOptimize)
	return err
}

var linkRE = regexp.MustCompile(`https?://\S`)

// HasLink reports whether the text holds a link, for the filter has:link.
func HasLink(text string) bool { return linkRE.MatchString(text) }

func flag(b bool) int64 {
	if b {
		return 1
	}
	return 0
}

// Move points the entries of messages at another conversation: a thread that became a conversation takes its replies along.
func Move(ctx context.Context, d pdb.DBTX, ids []int64, to int64) error {
	list, err := json.Marshal(ids)
	if err != nil {
		return err
	}
	return db.New(d).MoveEntries(ctx, db.MoveEntriesParams{ToConversation: to, Ids: string(list)})
}
