package upload_test

import (
	"bytes"
	"context"
	"errors"
	"testing"
	"time"

	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/dbtest"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/upload"
)

var t0 = time.Unix(1_800_000_000, 0)

func seeded(t *testing.T) (*pdb.Store, *upload.Service) {
	t.Helper()
	s := dbtest.Store(t)
	dbtest.Exec(t, s,
		`INSERT INTO identities (id, kind, handle, display_name, display_skeleton, avatar_letter, avatar_palette, created_at) VALUES
		   (1,'human','drew','Drew','drew','D',0,1),(2,'agent','devtool','Devtool','devtool','D',0,1)`,
		`INSERT INTO humans (identity_id, role, created_via) VALUES (1,'owner','bootstrap')`,
		`INSERT INTO agents (identity_id, created_by_human) VALUES (2,1)`,
		`INSERT INTO conversations (id, created_by, created_at, last_activity_at) VALUES (41,1,1,1),(52,1,1,1)`)
	blobs, err := upload.NewBlobs(t.TempDir(), bytes.Repeat([]byte{3}, 32))
	if err != nil {
		t.Fatal(err)
	}
	return s, upload.NewService(blobs)
}

func create(t *testing.T, s *pdb.Store, svc *upload.Service, who, conv int64, size int64) (row upload.Row, err error) {
	t.Helper()
	err = dbtest.TxErr(t, s, func(ctx context.Context, d pdb.DBTX) (e error) {
		row, e = svc.Create(ctx, d, t0, upload.NewRequest{Uploader: who, Conversation: conv, Kind: upload.KindFile, Filename: "a.bin", Size: size, SHA256: bytes.Repeat([]byte{1}, 32)}, 0)
		return e
	})
	return row, err
}

// finish marks an upload complete the way a finished chunk does, so Bind can be tried on it.
func finish(t *testing.T, s *pdb.Store, row upload.Row) {
	t.Helper()
	dbtest.Tx(t, s, func(ctx context.Context, d pdb.DBTX) error {
		return upload.Finish(ctx, d, t0, row.ID, upload.Finished{Kind: upload.KindFile, Mime: "application/octet-stream", Size: row.DeclaredSize})
	})
}

func bind(t *testing.T, s *pdb.Store, author, conv, msg int64, ids ...string) error {
	t.Helper()
	return dbtest.TxErr(t, s, func(ctx context.Context, d pdb.DBTX) error {
		_, err := upload.Bind(ctx, d, t0, upload.BindArgs{MessageID: msg, ConversationID: conv, Author: author, PublicIDs: ids})
		return err
	})
}

func seedMessages(t *testing.T, s *pdb.Store) {
	t.Helper()
	dbtest.Exec(t, s,
		`INSERT INTO messages (id, conversation_id, author_id, kind, format, body, client_id, created_at) VALUES
		   (1,41,1,'text','plain','a','client-0001',1),(2,41,1,'text','plain','b','client-0002',1),(3,52,1,'text','plain','c','client-0003',1)`)
}

func TestAnUploadBindsOnceAndOnlyWhenFinished(t *testing.T) {
	s, svc := seeded(t)
	seedMessages(t, s)
	row, err := create(t, s, svc, 1, 41, 100)
	if err != nil {
		t.Fatal(err)
	}
	if err := bind(t, s, 1, 41, 1, row.PublicID); !errors.Is(err, upload.ErrUnfinished) {
		t.Fatalf("an unfinished upload: %v", err)
	}
	finish(t, s, row)
	if err := bind(t, s, 1, 41, 1, row.PublicID); err != nil {
		t.Fatal(err)
	}
	if err := bind(t, s, 1, 41, 2, row.PublicID); !errors.Is(err, upload.ErrBound) {
		t.Fatalf("a second message: %v", err)
	}
}

func TestAnUploadIsNotUsableInAnotherConversationOrByAnotherIdentity(t *testing.T) {
	s, svc := seeded(t)
	seedMessages(t, s)
	row, _ := create(t, s, svc, 1, 41, 100)
	finish(t, s, row)
	if err := bind(t, s, 1, 52, 3, row.PublicID); !errors.Is(err, upload.ErrNotYours) {
		t.Fatalf("another conversation: %v", err)
	}
	if err := bind(t, s, 2, 41, 1, row.PublicID); !errors.Is(err, upload.ErrNotYours) {
		t.Fatalf("another identity: %v", err)
	}
	if err := bind(t, s, 1, 41, 1, "no-such-upload-id-xxxx"); !errors.Is(err, upload.ErrNotYours) {
		t.Fatalf("an unknown id: %v", err)
	}
}

func TestADailyByteQuotaPerIdentity(t *testing.T) {
	s, svc := seeded(t)
	for i := range 20 {
		if _, err := create(t, s, svc, 2, 41, upload.MaxSize); err != nil {
			t.Fatalf("upload %d: %v", i, err)
		}
	}
	if _, err := create(t, s, svc, 2, 41, 1); !errors.Is(err, upload.ErrQuota) {
		t.Fatalf("the 21st: %v", err)
	}
	if _, err := create(t, s, svc, 1, 41, 1); err != nil {
		t.Fatalf("another identity is not held up: %v", err)
	}
}

func TestAnUploadNobodyBoundIsGoneAfterADay(t *testing.T) {
	s, svc := seeded(t)
	row, _ := create(t, s, svc, 1, 41, 100)
	var names []string
	dbtest.Tx(t, s, func(ctx context.Context, d pdb.DBTX) (err error) {
		names, err = upload.Expire(ctx, d, t0.Add(upload.UnboundTTL-time.Minute))
		return err
	})
	if len(names) != 0 {
		t.Fatal("expired too early")
	}
	dbtest.Tx(t, s, func(ctx context.Context, d pdb.DBTX) (err error) {
		names, err = upload.Expire(ctx, d, t0.Add(upload.UnboundTTL+time.Minute))
		return err
	})
	if len(names) != 1 || names[0] != row.StorageName {
		t.Fatalf("got %v", names)
	}
}

func TestAVoiceNoteIsTheOnlyUploadOfItsMessage(t *testing.T) {
	s, svc := seeded(t)
	seedMessages(t, s)
	audio, _ := create(t, s, svc, 1, 41, 100)
	other, _ := create(t, s, svc, 1, 41, 100)
	dbtest.Tx(t, s, func(ctx context.Context, d pdb.DBTX) error {
		if err := upload.Finish(ctx, d, t0, audio.ID, upload.Finished{Kind: upload.KindAudio, Mime: "audio/webm", Inline: true, Size: 100, DurationMS: 5000}); err != nil {
			return err
		}
		return upload.Finish(ctx, d, t0, other.ID, upload.Finished{Kind: upload.KindFile, Mime: "application/octet-stream", Size: 100})
	})
	if err := bind(t, s, 1, 41, 1, audio.PublicID, other.PublicID); !errors.Is(err, upload.ErrAudioAlone) {
		t.Fatalf("got %v", err)
	}
}

// A start whose answer was lost is sent again with the same client id: it gets the first upload back and no orphan row is made (issue 193).
func TestAnUploadStartedAgainUnderTheSameClientIDIsTheSameUpload(t *testing.T) {
	s, svc := seeded(t)
	start := func(who, conv int64, name, clientID string) (row upload.Row, err error) {
		err = dbtest.TxErr(t, s, func(ctx context.Context, d pdb.DBTX) (e error) {
			row, e = svc.Create(ctx, d, t0, upload.NewRequest{Uploader: who, Conversation: conv, Kind: upload.KindFile, Filename: name, Size: 100, SHA256: bytes.Repeat([]byte{1}, 32), ClientID: clientID}, 0)
			return e
		})
		return row, err
	}
	count := func() (n int) {
		dbtest.Tx(t, s, func(ctx context.Context, d pdb.DBTX) error {
			return d.QueryRowContext(ctx, `SELECT count(*) FROM uploads`).Scan(&n)
		})
		return n
	}
	first, err := start(1, 41, "a.bin", "convoz-0123abcd")
	if err != nil {
		t.Fatal(err)
	}
	again, err := start(1, 41, "a.bin", "convoz-0123abcd")
	if err != nil || again.PublicID != first.PublicID || count() != 1 {
		t.Fatalf("the start sent again: %+v, err %v, %d rows; want the first upload and 1 row", again.PublicID, err, count())
	}
	if _, err := start(1, 52, "a.bin", "convoz-0123abcd"); !errors.Is(err, upload.ErrBadRequest) {
		t.Errorf("the same client id for another conversation: %v, want ErrBadRequest", err)
	}
	other, err := start(2, 41, "a.bin", "convoz-0123abcd")
	if err != nil || other.PublicID == first.PublicID {
		t.Errorf("another identity under the same client id: %+v, err %v; want its own upload", other.PublicID, err)
	}
	a, _ := start(1, 41, "a.bin", "")
	b, _ := start(1, 41, "a.bin", "")
	if a.PublicID == b.PublicID {
		t.Error("two starts with no client id must stay two uploads")

// Files dropped together keep the order they were sent in, whichever finished its upload first (and so has the lower id).
func TestFilesOfOneMessageKeepTheOrderTheyWereBoundIn(t *testing.T) {
	s, svc := seeded(t)
	seedMessages(t, s)
	first, _ := create(t, s, svc, 1, 41, 100)
	second, _ := create(t, s, svc, 1, 41, 100)
	finish(t, s, first)
	finish(t, s, second)
	if err := bind(t, s, 1, 41, 1, second.PublicID, first.PublicID); err != nil {
		t.Fatal(err)
	}
	var got []upload.Attached
	dbtest.Tx(t, s, func(ctx context.Context, d pdb.DBTX) (err error) {
		got, err = upload.OfMessages(ctx, d, []int64{1})
		return err
	})
	if len(got) != 2 || got[0].PublicID != second.PublicID || got[1].PublicID != first.PublicID {
		t.Fatalf("the files of the message: %+v, want the second upload then the first", got)
	}
}

// The replay of a start must ask the same thing: another size or checksum under the same client id is refused (advisor, issue 193).
func TestAnUploadStartedAgainWithAnotherSizeOrChecksumIsRefused(t *testing.T) {
	s, svc := seeded(t)
	start := func(size int64, sum byte) (row upload.Row, err error) {
		err = dbtest.TxErr(t, s, func(ctx context.Context, d pdb.DBTX) (e error) {
			row, e = svc.Create(ctx, d, t0, upload.NewRequest{Uploader: 1, Conversation: 41, Kind: upload.KindFile, Filename: "a.bin", Size: size, SHA256: bytes.Repeat([]byte{sum}, 32), ClientID: "convoz-size0001"}, 0)
			return e
		})
		return row, err
	}
	first, err := start(100, 1)
	if err != nil {
		t.Fatal(err)
	}
	if again, err := start(100, 1); err != nil || again.PublicID != first.PublicID {
		t.Fatalf("the same start again: %v, %v", again.PublicID, err)
	}
	if _, err := start(200, 1); !errors.Is(err, upload.ErrBadRequest) {
		t.Errorf("another size: %v, want ErrBadRequest", err)
	}
	if _, err := start(100, 2); !errors.Is(err, upload.ErrBadRequest) {
		t.Errorf("another checksum: %v, want ErrBadRequest", err)
	}
}

// Two starts with one client id that meet at the insert: the loser reads the winner's row, it does not fail (advisor, issue 193).
func TestTwoStartsOfOneClientIDMeetingAtTheInsertAreOneUpload(t *testing.T) {
	s, svc := seeded(t)
	req := upload.NewRequest{Uploader: 1, Conversation: 41, Kind: upload.KindFile, Filename: "a.bin", Size: 100, SHA256: bytes.Repeat([]byte{1}, 32), ClientID: "convoz-race0001"}
	var winner upload.Row
	err := dbtest.TxErr(t, s, func(ctx context.Context, d pdb.DBTX) (e error) {
		first := true
		defer upload.SetBeforeInsert(func() { // the other start gets its row in after this one looked and found none
			if !first {
				return
			}
			first = false
			winner, e = svc.Create(ctx, d, t0, req, 0)
		})()
		var got upload.Row
		if got, e = svc.Create(ctx, d, t0, req, 0); e != nil {
			return e
		}
		if winner.PublicID == "" || got.PublicID != winner.PublicID {
			t.Errorf("the loser got %q; want the winner's upload %q", got.PublicID, winner.PublicID)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}
