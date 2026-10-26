package ask_test

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/ask"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/dbtest"
)

// The migration that adds the permission columns is the newest one (the coder picks the next free number; 0042 is taken by an open PR).
// The test migrates to the one before it, writes an ask in the old shape and migrates up.
func TestMigration_AnAskFromBeforeThePermissionColumnsReadsAsADecision(t *testing.T) {
	ctx := context.Background()
	s, err := pdb.Open(filepath.Join(t.TempDir(), "t.db"), append([]byte("TESTONLY"), make([]byte, 24)...))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	opts := platform.MigrateOptions{DataDir: t.TempDir(), Clock: platform.SystemClock{}, MaxVersion: platform.LatestVersion() - 1}
	if err := platform.Migrate(ctx, s, opts); err != nil {
		t.Fatal(err)
	}
	dbtest.Exec(t, s,
		`INSERT INTO identities (id, kind, handle, display_name, display_skeleton, avatar_letter, avatar_palette, created_at) VALUES (1,'human','drew','Drew','drew','D',0,1),(2,'agent','devtool','D','devtool','D',0,1)`,
		`INSERT INTO humans (identity_id, role, created_via) VALUES (1,'owner','bootstrap')`,
		`INSERT INTO agents (identity_id, created_by_human) VALUES (2,1)`,
		`INSERT INTO conversations (id, created_by, created_at, last_activity_at) VALUES (10,1,1,1)`,
		`INSERT INTO messages (id, conversation_id, author_id, kind, body, created_at) VALUES (5,10,2,'ask','Merge it?',1)`,
		`INSERT INTO asks (message_id, conversation_id, asker_id, question, state, version, created_at, updated_at) VALUES (5,10,2,'Merge it?','open',1,1,1)`,
	)

	opts.MaxVersion = 0
	if err := platform.Migrate(ctx, s, opts); err != nil {
		t.Fatal(err)
	}
	a := get(t, s, 5)
	if a.Kind() != "decision" || a.Permission != nil || a.Question != "Merge it?" || a.State != ask.Open {
		t.Errorf("kind %q permission %+v question %q state %q: want the old ask unchanged as a decision", a.Kind(), a.Permission, a.Question, a.State)
	}
}
