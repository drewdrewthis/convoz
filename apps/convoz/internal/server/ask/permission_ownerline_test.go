package ask_test

import (
	"context"
	"testing"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/ask"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/dbtest"
)

// A permission ask shows its machine action, so an action of two words is no refusal.
func TestCreate_PermissionAskWithAShortActionIsNotJudgedAsASentence(t *testing.T) {
	s := world(t)
	p, _ := ports()
	pm := perm()
	pm.Action = "Merge it"
	if a := get(t, s, opened(t, s, p, pm)); a.Question != "Merge it" {
		t.Fatalf("question %q, want the action", a.Question)
	}
}

func TestUpdate_PermissionAskTakesAShortQuestionToo(t *testing.T) {
	s := world(t)
	p, _ := ports()
	id := opened(t, s, p, perm())
	err := dbtest.TxErr(t, s, func(ctx context.Context, d pdb.DBTX) error {
		_, err := ask.Update(ctx, d, p, t0, ask.Updating{ID: id, By: 2, Question: "Merge it"})
		return err
	})
	if err != nil {
		t.Fatalf("update with a short question: %v", err)
	}
}
