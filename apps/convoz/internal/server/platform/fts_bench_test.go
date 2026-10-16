package platform_test

import (
	"fmt"
	"math/rand/v2"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/ncruces/go-sqlite3"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform"
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
func buildFixture(tb testing.TB, db *platform.DB) {
	must(tb, db.Exec("CREATE VIRTUAL TABLE docs USING fts5(body, content='', contentless_delete=1)"))
	must(tb, db.Exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT) STRICT"))
	r := rand.New(rand.NewPCG(1, 2))
	const perTx = 50_000
	for start := 0; start < benchRows; start += perTx {
		must(tb, db.Tx(func(exec func(string, ...any) error) error {
			for i := start; i < start+perTx; i += benchBatch {
				var sb strings.Builder
				sb.WriteString("INSERT INTO docs(rowid, body) VALUES ")
				for j := i; j < i+benchBatch; j++ {
					if j > i {
						sb.WriteByte(',')
					}
					fmt.Fprintf(&sb, "(%d,'%s')", j+1, sentence(r))
				}
				if err := exec(sb.String()); err != nil {
					return err
				}
			}
			return nil
		}))
	}
	must(tb, db.Exec("INSERT INTO meta VALUES(?, ?)", fixtureMarker, fmt.Sprint(benchRows)))
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
	db, err := platform.Open(path, key)
	must(b, err)
	defer db.Close()

	if v, ok, _ := db.QueryString("SELECT value FROM meta WHERE key=?", fixtureMarker); ok && v == fmt.Sprint(benchRows) {
		b.Log("reusing fixture")
	} else if existed {
		b.Fatalf("%s exists but holds no complete fixture", path)
	} else {
		buildFixture(b, db)
	}

	r := rand.New(rand.NewPCG(3, 4))
	for range b.N {
		inserts := make([]time.Duration, benchSamples)
		for i := range inserts {
			t := time.Now()
			must(b, db.Exec("INSERT INTO docs(rowid, body) VALUES(?, ?)", int64(benchRows+1+i), sentence(r)))
			inserts[i] = time.Since(t)
		}
		searches := make([]time.Duration, benchSamples)
		for i := range searches {
			q := word(int(r.Float64() * r.Float64() * benchVocab))
			if i%2 == 1 {
				q += " AND " + word(r.IntN(benchVocab))
			}
			t := time.Now()
			hits := 0
			must(b, db.Query("SELECT rowid FROM docs WHERE docs MATCH ? ORDER BY rank LIMIT 20", []any{q}, func(*sqlite3.Stmt) { hits++ }))
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
