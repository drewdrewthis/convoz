package unfurl

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"time"

	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/unfurl/db"
)

const maxAttempts = 3

// Queue records the first link of a new message for the worker. It makes no
// network call (the post transaction must not wait on a site); the worker fetches after the commit. Another message with the
// same address shares the row.
func Queue(ctx context.Context, d pdb.DBTX, body string) error {
	u, ok := FirstURL(body)
	if !ok {
		return nil
	}
	return db.New(d).Enqueue(ctx, db.EnqueueParams{UrlHash: key(u), Url: u.String()})
}

// Find is the card of the first link of a body, as far as the worker has got. found is false when the body has no link
// or the address was never queued.
func Find(ctx context.Context, d pdb.DBTX, body string) (card Card, found bool, err error) {
	u, ok := FirstURL(body)
	if !ok {
		return Card{}, false, nil
	}
	row, err := db.New(d).Lookup(ctx, key(u))
	if errors.Is(err, sql.ErrNoRows) {
		return Card{}, false, nil
	}
	if err != nil {
		return Card{}, false, err
	}
	card = Card{Status: row.Status, URL: row.Url}
	if row.Status == "ok" {
		card.Kind, card.Site, card.Title, card.Description = row.Kind, row.Site.String, row.Title.String, row.Description.String
		if row.MetaJson.Valid {
			_ = json.Unmarshal([]byte(row.MetaJson.String), &card.Meta)
		}
	}
	return card, true, nil
}

// Job is one address waiting for the worker.
type Job struct {
	hash     []byte
	URL      string
	attempts int64
}

// Due lists up to max addresses that are pending and not waiting for a retry.
func Due(ctx context.Context, d pdb.DBTX, now time.Time, max int) ([]Job, error) {
	rows, err := db.New(d).Due(ctx, db.DueParams{Now: sql.NullInt64{Int64: now.UnixMilli(), Valid: true}, Max: int64(max)})
	jobs := make([]Job, len(rows))
	for i, r := range rows {
		jobs[i] = Job{hash: r.UrlHash, URL: r.Url, attempts: r.Attempts}
	}
	return jobs, err
}

// Settle records what a fetch came to. A card is final for now; a refused address or a page that cannot be a card ends
// "unavailable" at once; any other failure waits and tries again, up to three times.
func Settle(ctx context.Context, d pdb.DBTX, now time.Time, j Job, card Card, fetchErr error) error {
	at := sql.NullInt64{Int64: now.UnixMilli(), Valid: true}
	p := db.SettleParams{UrlHash: j.hash, Attempts: j.attempts + 1, Kind: "generic", FetchedAt: at}
	switch {
	case fetchErr == nil:
		p.Status, p.Kind = "ok", card.Kind
		p.Site = sql.NullString{String: card.Site, Valid: true}
		p.Title = sql.NullString{String: card.Title, Valid: true}
		p.Description = sql.NullString{String: card.Description, Valid: card.Description != ""}
		if card.Meta != nil {
			text, err := json.Marshal(card.Meta)
			if err != nil {
				return err
			}
			p.MetaJson = sql.NullString{String: string(text), Valid: true}
		}
		p.RefreshAfter = sql.NullInt64{Int64: now.Add(24 * time.Hour).UnixMilli(), Valid: true}
	case Permanent(fetchErr) || p.Attempts >= maxAttempts:
		p.Status = "unavailable"
	default:
		p.Status = "pending"
		p.RefreshAfter = sql.NullInt64{Int64: now.Add(time.Duration(p.Attempts) * 20 * time.Second).UnixMilli(), Valid: true}
	}
	return db.New(d).Settle(ctx, p)
}
