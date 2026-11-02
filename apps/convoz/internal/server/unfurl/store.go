package unfurl

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
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
	return cardOf(row.Status, row.Url, row.Kind, row.Site, row.Title, row.Description, row.MetaJson), true, nil
}

func cardOf(status, url, kind string, site, title, desc, meta sql.NullString) Card {
	card := Card{Status: status, URL: url}
	if status == "ok" {
		card.Kind, card.Site, card.Title, card.Description = kind, site.String, title.String, desc.String
		if meta.Valid {
			_ = json.Unmarshal([]byte(meta.String), &card.Meta)
		}
	}
	return card
}

// FindMany is Find for a page of bodies in one query: the card of the first link of each body, by body. A body with no link, or
// whose address was never queued, is absent.
func FindMany(ctx context.Context, d pdb.DBTX, bodies []string) (map[string]Card, error) {
	hashes := map[string][]byte{} // body -> url_hash
	args := []any{}
	for _, b := range bodies {
		if u, ok := FirstURL(b); ok {
			h := key(u)
			hashes[b] = h
			args = append(args, h)
		}
	}
	if len(args) == 0 {
		return nil, nil
	}
	rows, err := d.QueryContext(ctx, `SELECT url_hash, url, status, site, title, description, kind, meta_json FROM unfurls WHERE url_hash IN (?`+strings.Repeat(",?", len(args)-1)+`)`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	byHash := map[string]Card{}
	for rows.Next() {
		var hash []byte
		var status, url, kind string
		var site, title, desc, meta sql.NullString
		if err := rows.Scan(&hash, &url, &status, &site, &title, &desc, &kind, &meta); err != nil {
			return nil, err
		}
		byHash[string(hash)] = cardOf(status, url, kind, site, title, desc, meta)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	out := make(map[string]Card, len(hashes))
	for b, h := range hashes {
		if c, ok := byHash[string(h)]; ok {
			out[b] = c
		}
	}
	return out, nil
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
