package httpapi

import (
	"bytes"
	"context"
	"crypto/sha256"
	"io"
	"log"
	"testing"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/dbtest"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/settings"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/transcript"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/upload"
)

type fixedClock struct{ t time.Time }

func (c fixedClock) Now() time.Time { return c.t }

// lengthEngine records the byte length of every note it is handed.
type lengthEngine struct{ got []int }

func (e *lengthEngine) Transcribe(_ context.Context, audio io.Reader, _ string) (string, error) {
	b, err := io.ReadAll(audio)
	e.got = append(e.got, len(b))
	return "backfilled words", err
}

var t0 = time.Unix(1_800_000_000, 0)

// storedNote puts a finished voice note, sent in three chunks, into a message, the way a note sent while no engine was on is left.
func storedNote(t *testing.T, s *pdb.Store, svc *upload.Service) int {
	t.Helper()
	data := append([]byte("RIFF\x00\x00\x00\x00WAVE"), bytes.Repeat([]byte{7}, upload.SegmentSize+4000)...)
	sum := sha256.Sum256(data)
	var row upload.Row
	dbtest.Tx(t, s, func(ctx context.Context, d pdb.DBTX) (err error) {
		row, err = svc.Create(ctx, d, t0, upload.NewRequest{Uploader: 1, Conversation: 41, Kind: upload.KindAudio, Filename: "note.wav", Size: int64(len(data)), SHA256: sum[:]}, 0)
		return err
	})
	var done *upload.Finished
	for _, cut := range [][2]int{{0, 500}, {500, upload.SegmentSize + 100}, {upload.SegmentSize + 100, len(data)}} {
		p, err := svc.Receive(row, upload.Chunk{Offset: int64(cut[0])}, bytes.NewReader(data[cut[0]:cut[1]]))
		if err != nil {
			t.Fatal(err)
		}
		done = p.Finished
	}
	if done == nil {
		t.Fatal("the last chunk did not finish the note")
	}
	dbtest.Exec(t, s, `INSERT INTO messages (id, conversation_id, author_id, kind, format, body, client_id, created_at) VALUES (1,41,1,'text','plain','','client-0001',1)`)
	dbtest.Tx(t, s, func(ctx context.Context, d pdb.DBTX) error {
		if err := upload.Finish(ctx, d, t0, row.ID, *done); err != nil {
			return err
		}
		_, err := upload.Bind(ctx, d, t0, upload.BindArgs{MessageID: 1, ConversationID: 41, Author: 1, PublicIDs: []string{row.PublicID}})
		return err
	})
	return len(data)
}

func TestBackfillTranscribesAStoredNoteOnceAndOnlyWithAnEngine(t *testing.T) {
	eng := &lengthEngine{}
	transcript.Register("backfill-test", eng)
	s := dbtest.Store(t)
	dbtest.Exec(t, s,
		`INSERT INTO identities (id, kind, handle, display_name, display_skeleton, avatar_letter, avatar_palette, created_at) VALUES (1,'human','drew','Drew','drew','D',0,1)`,
		`INSERT INTO humans (identity_id, role, created_via) VALUES (1,'owner','bootstrap')`,
		`INSERT INTO conversations (id, created_by, created_at, last_activity_at) VALUES (41,1,1,1)`)
	blobs, err := upload.NewBlobs(t.TempDir(), bytes.Repeat([]byte{3}, 32))
	if err != nil {
		t.Fatal(err)
	}
	svc := upload.NewService(blobs)
	files.Store(svc)
	defer files.Store(nil)
	size := storedNote(t, s, svc)
	srv := &Server{Store: s, Clock: fixedClock{t0}, Log: log.New(io.Discard, "", 0)}
	srv.Bus = platform.NewBus()
	setEngine := func(name string) {
		dbtest.Tx(t, s, func(ctx context.Context, d pdb.DBTX) error {
			_, err := settings.Set(ctx, d, t0, 1, settings.Workspace, "transcription.engine", []byte(`"`+name+`"`))
			return err
		})
	}
	ctx := context.Background()

	setEngine("none")
	if n := srv.backfillTranscripts(ctx, srv.currentEngine(ctx)); n != 0 {
		t.Fatalf("with the setting at none %d notes were queued", n)
	}
	setEngine("backfill-test")
	if n := srv.backfillTranscripts(ctx, srv.currentEngine(ctx)); n != 1 {
		t.Fatalf("queued %d, want 1", n)
	}
	srv.transcribeDue(ctx)
	if len(eng.got) != 1 || eng.got[0] != size {
		t.Fatalf("the engine got %v bytes, want the whole stored note: %d", eng.got, size)
	}
	if n := srv.backfillTranscripts(ctx, srv.currentEngine(ctx)); n != 0 {
		t.Fatalf("a second start queued %d again", n)
	}
	srv.transcribeDue(ctx)
	if len(eng.got) != 1 {
		t.Fatalf("the note was transcribed again: %v", eng.got)
	}
	var of transcript.Of
	dbtest.Tx(t, s, func(ctx context.Context, d pdb.DBTX) error {
		m, err := transcript.ForUploads(ctx, d, []int64{1})
		of = m[1]
		return err
	})
	if of.State != transcript.Done || of.Text != "backfilled words" {
		t.Fatalf("transcript: %+v", of)
	}
}
