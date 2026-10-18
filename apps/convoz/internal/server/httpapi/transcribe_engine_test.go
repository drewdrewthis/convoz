package httpapi

import (
	"context"
	"io"
	"testing"
	"time"

	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/dbtest"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/settings"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/transcript"
)

type countingEngine struct{ calls int }

func (c *countingEngine) Transcribe(context.Context, io.Reader, string) (string, error) {
	c.calls++
	return "", nil
}

// With keys present (a default engine registered), the setting decides: "none" picks no engine, so no voice note is queued and no audio goes out.
func TestTranscriptionSettingNoneCallsNoEngine(t *testing.T) {
	eng := &countingEngine{}
	transcript.Register("auto", eng)
	transcript.SetDefault("auto")
	defer transcript.SetDefault(transcript.None)
	s := dbtest.Store(t)
	dbtest.Exec(t, s,
		`INSERT INTO identities (id, kind, handle, display_name, display_skeleton, avatar_letter, avatar_palette, created_at) VALUES (1,'human','drew','Drew','drew','D',0,1)`,
		`INSERT INTO humans (identity_id, role, created_via) VALUES (1,'owner','bootstrap')`)
	pick := func(value string) string {
		var got string
		dbtest.Tx(t, s, func(ctx context.Context, d pdb.DBTX) error {
			if value != "" {
				if _, err := settings.Set(ctx, d, time.Unix(1_800_000_000, 0), 1, settings.Workspace, "transcription.engine", []byte(`"`+value+`"`)); err != nil {
					return err
				}
			}
			got = transcriptionEngine(ctx, d)
			return nil
		})
		return got
	}
	if got := pick(""); got != "auto" {
		t.Fatalf("the default must use the server engine: %q", got)
	}
	if got := pick("none"); got != transcript.None {
		t.Fatalf("none must be off: %q", got)
	}
	if _, ok := transcript.Lookup(pick("none")); ok || eng.calls != 0 {
		t.Fatal("an engine was reached with the setting at none")
	}
}
