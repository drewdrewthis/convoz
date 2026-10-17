package message

import (
	"context"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/message/db"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// AddSystemLine writes a line the conversation says about itself ("@devtool was removed"). It has no author; the words
// are plain text and system JSON holds the ids they came from. It returns the new message id. The caller moves the
// conversation's activity and writes the thin event.
func AddSystemLine(ctx context.Context, d pdb.DBTX, now time.Time, conv int64, words, systemJSON string) (int64, error) {
	return db.New(d).InsertSystemLine(ctx, db.InsertSystemLineParams{ConversationID: conv, Body: words, SystemJson: nullString(systemJSON), CreatedAt: now.UnixMilli()})
}

// NewestID is the id of the newest message of the conversation, system lines included; 0 for none. A person who joins
// "from now" may see only what comes after it.
func NewestID(ctx context.Context, d pdb.DBTX, conv int64) (int64, error) {
	return db.New(d).NewestMessageID(ctx, conv)
}

// SessionsOf maps message ids to the session that wrote them, for the ones an agent session wrote.
func SessionsOf(ctx context.Context, d pdb.DBTX, ids []int64) (map[int64]int64, error) {
	out := map[int64]int64{}
	if len(ids) == 0 {
		return out, nil
	}
	rows, err := db.New(d).SessionsOfMessages(ctx, ids)
	if err != nil {
		return nil, err
	}
	for _, r := range rows {
		out[r.ID] = r.SessionID.Int64
	}
	return out, nil
}

// Thread lists the replies to one root that the reader may see (ids above floor), oldest first.
func Thread(ctx context.Context, d pdb.DBTX, conv, root, floor int64, limit int) ([]Message, error) {
	rows, err := db.New(d).ThreadReplies(ctx, db.ThreadRepliesParams{ConversationID: conv, RootID: nullInt(root), Floor: floor, MaxRows: int64(ClampLimit(limit))})
	if err != nil {
		return nil, err
	}
	out := make([]Message, 0, len(rows))
	for _, r := range rows {
		out = append(out, fromRow(r.ID, r.ConversationID, r.AuthorID, r.Kind, r.Format, r.Body, r.CreatedAt))
	}
	return out, nil
}
