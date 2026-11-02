package upload_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"testing"

	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/dbtest"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/upload"
)

// webm is the smallest body the sniffer takes for a voice note: the EBML magic, then padding.
var webm = append([]byte{0x1A, 0x45, 0xDF, 0xA3}, make([]byte, 64)...)

// A voice note may run 30 minutes (owner: notes stopped by themselves at 5). A 20-minute note keeps its whole length, through the
// receiver and the column; a longer claim is held to the cap.
func TestATwentyMinuteVoiceNoteIsStoredUnclamped(t *testing.T) {
	for _, c := range []struct{ sent, kept int64 }{{1_200_000, 1_200_000}, {1_800_000, 1_800_000}, {2_400_000, 1_800_000}} {
		s, svc := seeded(t)
		var row upload.Row
		dbtest.Tx(t, s, func(ctx context.Context, d pdb.DBTX) (err error) {
			row, err = svc.Create(ctx, d, t0, upload.NewRequest{Uploader: 1, Conversation: 41, Kind: upload.KindAudio, Filename: "voice-note.webm"}, 0)
			return err
		})
		sum := sha256.Sum256(webm)
		p, err := svc.Receive(row, upload.Chunk{Offset: 0, Length: int64(len(webm)), Checksum: sum[:], DurationMS: c.sent}, bytes.NewReader(webm))
		if err != nil || p.Finished == nil {
			t.Fatalf("%d ms: %+v %v", c.sent, p, err)
		}
		if p.Finished.DurationMS != c.kept {
			t.Fatalf("%d ms: the receiver kept %d ms, want %d", c.sent, p.Finished.DurationMS, c.kept)
		}
		if err := dbtest.TxErr(t, s, func(ctx context.Context, d pdb.DBTX) error {
			return upload.Finish(ctx, d, t0, row.ID, *p.Finished)
		}); err != nil {
			t.Fatalf("%d ms: storing the note: %v", c.sent, err)
		}
		var got upload.Row
		dbtest.Tx(t, s, func(ctx context.Context, d pdb.DBTX) (err error) {
			got, _, err = upload.ByID(ctx, d, row.ID)
			return err
		})
		if got.DurationMS != c.kept {
			t.Fatalf("%d ms: stored %d ms, want %d", c.sent, got.DurationMS, c.kept)
		}
	}
}
