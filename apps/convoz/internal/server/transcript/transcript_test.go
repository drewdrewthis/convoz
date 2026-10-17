package transcript_test

import (
	"context"
	"io"
	"strings"
	"testing"
	"time"

	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/dbtest"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/transcript"
)

var t0 = time.Unix(1_800_000_000, 0)

func seeded(t *testing.T) *pdb.Store {
	t.Helper()
	s := dbtest.Store(t)
	dbtest.Exec(t, s,
		`INSERT INTO identities (id, kind, handle, display_name, display_skeleton, avatar_letter, avatar_palette, created_at) VALUES (1,'human','drew','Drew','drew','D',0,1)`,
		`INSERT INTO humans (identity_id, role, created_via) VALUES (1,'owner','bootstrap')`,
		`INSERT INTO conversations (id, created_by, created_at, last_activity_at) VALUES (41,1,1,1)`,
		`INSERT INTO uploads (id, public_id, uploader_id, conversation_id, kind, declared_size, declared_sha256, filename, storage_name, dek_id, file_key_wrapped, created_at)
		   VALUES (7,'aaaaaaaaaaaaaaaaaaaaaa',1,41,'audio',100,zeroblob(32),'n.webm','st7',1,zeroblob(8),1)`)
	return s
}

func TestAPendingTranscriptIsTakenInOrderAndFinishedOnce(t *testing.T) {
	s := seeded(t)
	dbtest.Tx(t, s, func(ctx context.Context, d pdb.DBTX) error { return transcript.Enqueue(ctx, d, t0, 7, "fake") })
	dbtest.Tx(t, s, func(ctx context.Context, d pdb.DBTX) error { return transcript.Enqueue(ctx, d, t0, 7, "fake") }) // twice changes nothing
	var job transcript.Job
	dbtest.Tx(t, s, func(ctx context.Context, d pdb.DBTX) (err error) {
		var ok bool
		if job, ok, err = transcript.Next(ctx, d, t0); !ok {
			t.Fatal("nothing is due")
		}
		return err
	})
	if job.UploadID != 7 || job.Engine != "fake" {
		t.Fatalf("got %+v", job)
	}
	dbtest.Tx(t, s, func(ctx context.Context, d pdb.DBTX) error {
		return transcript.Finish(ctx, d, t0, 7, "fake", "ship the filters")
	})
	dbtest.Tx(t, s, func(ctx context.Context, d pdb.DBTX) error {
		if _, ok, _ := transcript.Next(ctx, d, t0); ok {
			t.Fatal("a finished transcript is due again")
		}
		got, err := transcript.ForUploads(ctx, d, []int64{7})
		if got[7].State != transcript.Done || got[7].Text != "ship the filters" {
			t.Fatalf("got %+v", got)
		}
		return err
	})
}

func TestAFailureBacksOffAndAfterFiveTriesGivesUp(t *testing.T) {
	s := seeded(t)
	dbtest.Tx(t, s, func(ctx context.Context, d pdb.DBTX) error { return transcript.Enqueue(ctx, d, t0, 7, "fake") })
	now := t0
	for try := range transcript.Attempts {
		var job transcript.Job
		dbtest.Tx(t, s, func(ctx context.Context, d pdb.DBTX) error {
			var ok bool
			var err error
			if job, ok, err = transcript.Next(ctx, d, now); !ok {
				t.Fatalf("try %d: not due at %v", try, now)
			}
			return err
		})
		var gaveUp bool
		dbtest.Tx(t, s, func(ctx context.Context, d pdb.DBTX) (err error) {
			gaveUp, err = transcript.Retry(ctx, d, now, job)
			return err
		})
		if gaveUp != (try == transcript.Attempts-1) {
			t.Fatalf("try %d: gave up %v", try, gaveUp)
		}
		dbtest.Tx(t, s, func(ctx context.Context, d pdb.DBTX) error {
			if _, ok, _ := transcript.Next(ctx, d, now); ok {
				t.Fatalf("try %d: due again at once", try)
			}
			return nil
		})
		now = now.Add(transcript.Backoff(job.Attempts) + time.Second)
	}
	dbtest.Tx(t, s, func(ctx context.Context, d pdb.DBTX) error {
		got, err := transcript.ForUploads(ctx, d, []int64{7})
		if got[7].State != transcript.Failed {
			t.Fatalf("got %+v", got)
		}
		return err
	})
}

type echo struct{}

func (echo) Transcribe(_ context.Context, a io.Reader, _ string) (string, error) {
	b, err := io.ReadAll(a)
	return strings.ToUpper(string(b)), err
}

func TestAnEngineIsFoundByNameAndNoneIsNoEngine(t *testing.T) {
	transcript.Register("echo-test", echo{})
	if e, ok := transcript.Lookup("echo-test"); !ok || e == nil {
		t.Fatal("a registered engine is not found")
	}
	if _, ok := transcript.Lookup(transcript.None); ok {
		t.Fatal("none is an engine")
	}
	if _, ok := transcript.Lookup("nope"); ok {
		t.Fatal("an unknown name is an engine")
	}
	for name, want := range map[string]bool{"fake": true, "whisper-local": true, "": false, "Bad": false, "a b": false, strings.Repeat("x", 33): false} {
		if transcript.ValidName(name) != want {
			t.Errorf("ValidName(%q) != %v", name, want)
		}
	}
}
