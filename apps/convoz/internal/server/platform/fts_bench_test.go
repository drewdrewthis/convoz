package platform_test

import (
	"context"
	"database/sql"
	"fmt"
	"math/rand/v2"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

const (
	benchRows     = 1_000_000
	benchVocab    = 20_000
	benchWords    = 10
	benchBatch    = 500
	benchSamples  = 1_000
	insertBudget  = 10.0 // ms, p95
	searchBudget  = 50.0 // ms, p95
	fixtureMarker = "fixture_rows"
)

func word(i int) string { return fmt.Sprintf("w%dx", i) }

func sentence(r *rand.Rand) string {
	ws := make([]string, benchWords)
	for i := range ws {
		// Squaring skews picks toward low ids, so a few words are common like real text.
		f := r.Float64()
		ws[i] = word(int(f * f * benchVocab))
	}
	return strings.Join(ws, " ")
}

func p95ms(d []time.Duration) float64 {
	slices.Sort(d)
	return float64(d[(len(d)*95+99)/100-1]) / float64(time.Millisecond)
}

// buildFixture fills a contentless_delete FTS5 table with benchRows rows in batched
// transactions. It writes a marker last, so a half-built file is never reused.
func buildFixture(tb testing.TB, store *db.Store) {
	ctx := context.Background()
	must(tb, store.Writer.SQLTx(ctx, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, "CREATE VIRTUAL TABLE docs USING fts5(body, content='', contentless_delete=1)"); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx, "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT) STRICT")
		return err
	}))
	r := rand.New(rand.NewPCG(1, 2))
	const perTx = 50_000
	for start := 0; start < benchRows; start += perTx {
		must(tb, store.Writer.SQLTx(ctx, func(tx *sql.Tx) error {
			for i := start; i < start+perTx; i += benchBatch {
				var sb strings.Builder
				sb.WriteString("INSERT INTO docs(rowid, body) VALUES ")
				for j := i; j < i+benchBatch; j++ {
					if j > i {
						sb.WriteByte(',')
					}
					fmt.Fprintf(&sb, "(%d,'%s')", j+1, sentence(r))
				}
				if _, err := tx.ExecContext(ctx, sb.String()); err != nil {
					return err
				}
			}
			return nil
		}))
	}
	must(tb, store.Writer.SQLTx(ctx, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, "INSERT INTO meta VALUES(?, ?)", fixtureMarker, fmt.Sprint(benchRows))
		return err
	}))
}

// search runs one MATCH query on the read pool and drains the rows.
func search(ctx context.Context, store *db.Store, q string) error {
	rows, err := store.Reader.SQL().QueryContext(ctx, "SELECT rowid FROM docs WHERE docs MATCH ? ORDER BY rank LIMIT 20", q)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
	}
	return rows.Err()
}

func must(tb testing.TB, err error) {
	tb.Helper()
	if err != nil {
		tb.Fatal(err)
	}
}

// BenchmarkFTS1M is the Adiantum go/no-go: single-row insert p95 and MATCH p95 on a
// 1M-row FTS5 table inside the encrypted file. The fixture build is left inside the
// timed region on purpose, so the run is one pass and the metrics are not re-measured.
func BenchmarkFTS1M(b *testing.B) {
	dir := os.Getenv("CONVOZ_BENCH_DATA_DIR")
	if dir == "" {
		dir = b.TempDir()
	}
	path := filepath.Join(dir, "bench.db")
	_, statErr := os.Stat(path)
	existed := statErr == nil

	key := make([]byte, 32)
	copy(key, "TESTONLY-bench-key")
	store, err := db.Open(path, key)
	must(b, err)
	defer store.Close()
	ctx := context.Background()

	var marker string
	if err := store.Reader.SQL().QueryRowContext(ctx, "SELECT value FROM meta WHERE key=?", fixtureMarker).Scan(&marker); err == nil && marker == fmt.Sprint(benchRows) {
		b.Log("reusing fixture")
	} else if existed {
		b.Fatalf("%s exists but holds no complete fixture", path)
	} else {
		buildFixture(b, store)
	}

	r := rand.New(rand.NewPCG(3, 4))
	for range b.N {
		inserts := make([]time.Duration, benchSamples)
		for i := range inserts {
			t := time.Now()
			must(b, store.Writer.SQLTx(ctx, func(tx *sql.Tx) error {
				_, err := tx.ExecContext(ctx, "INSERT INTO docs(rowid, body) VALUES(?, ?)", int64(benchRows+1+i), sentence(r))
				return err
			}))
			inserts[i] = time.Since(t)
		}
		searches := make([]time.Duration, benchSamples)
		for i := range searches {
			q := word(int(r.Float64() * r.Float64() * benchVocab))
			if i%2 == 1 {
				q += " AND " + word(r.IntN(benchVocab))
			}
			t := time.Now()
			must(b, search(ctx, store, q))
			searches[i] = time.Since(t)
		}
		ip, sp := p95ms(inserts), p95ms(searches)
		b.ReportMetric(ip, "insert-p95-ms")
		b.ReportMetric(sp, "search-p95-ms")
		if ip > insertBudget || sp > searchBudget {
			b.Errorf("over budget: insert p95 %.2f ms (max %v), search p95 %.2f ms (max %v)", ip, insertBudget, sp, searchBudget)
		}
	}
}
