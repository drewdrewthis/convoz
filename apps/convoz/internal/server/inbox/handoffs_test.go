package inbox_test

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/inbox"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

func TestAddHandoff_KeepsTheNewest50AndRepeatsOnce(t *testing.T) {
	s := seeded(t)
	run(t, s, func(ctx context.Context, d pdb.DBTX) {
		for n := 1; n <= 52; n++ {
			if _, created, err := inbox.AddHandoff(ctx, d, t0, devtool, sessA, fmt.Sprintf("note %d", n), fmt.Sprintf("client-%04d", n)); err != nil || !created {
				t.Fatalf("note %d: created=%v err=%v", n, created, err)
			}
		}
		again, created, err := inbox.AddHandoff(ctx, d, t0, devtool, sessB, "a different body", "client-0052")
		if err != nil || created || again.Body != "note 52" {
			t.Fatalf("a repeat of a client id must return the stored note, got %q created=%v err=%v", again.Body, created, err)
		}
		notes, err := inbox.Handoffs(ctx, d, devtool, 100)
		if err != nil || len(notes) != inbox.KeepHandoffs {
			t.Fatalf("kept %d notes, err=%v", len(notes), err)
		}
		if notes[0].Body != "note 52" || notes[len(notes)-1].Body != "note 3" {
			t.Fatalf("kept %q .. %q, want note 52 .. note 3", notes[0].Body, notes[len(notes)-1].Body)
		}
	})
}

func TestAddHandoff_RefusesMoreThan4096Bytes(t *testing.T) {
	s := seeded(t)
	run(t, s, func(ctx context.Context, d pdb.DBTX) {
		if _, _, err := inbox.AddHandoff(ctx, d, t0, devtool, sessA, strings.Repeat("é", 2049), "client-0001"); !errors.Is(err, inbox.ErrHandoffSize) {
			t.Fatalf("4098 bytes: %v", err)
		}
		if _, _, err := inbox.AddHandoff(ctx, d, t0, devtool, sessA, strings.Repeat("é", 2048), "client-0002"); err != nil {
			t.Fatalf("4096 bytes: %v", err)
		}
	})
}
