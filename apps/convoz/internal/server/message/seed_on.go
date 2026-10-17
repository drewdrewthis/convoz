//go:build testhooks

package message

import (
	"context"
	"time"

	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// Seed writes count plain messages by author straight into the messages table. It is the test build's way to a data dir
// with a million messages: only this module may write messages, and a million posts over HTTP would take longer than the
// scenario that needs them. The conversation's counters are not moved: the fixture is read for start-up time, not for counts.
func Seed(ctx context.Context, d pdb.DBTX, now time.Time, conversation, author int64, count int) error {
	_, err := d.ExecContext(ctx, `
		WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
		INSERT INTO messages (conversation_id, author_id, kind, format, body, created_at)
		SELECT ?2, ?3, 'text', 'plain',
		       'Seeded message ' || n.i || ' about the search filters and the release window', ?4 + n.i
		FROM n`, count, conversation, author, now.UnixMilli())
	return err
}
