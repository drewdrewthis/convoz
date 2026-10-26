package httpapi

import (
	"context"
	"net/http"
	"slices"
	"strconv"
	"testing"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/conversation"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/dbtest"
)

// A person's thread reply that @mentions an agent outside the conversation brings it in, as a main message does (I-18, issue 35).
func TestAThreadReplyThatMentionsAnAgentBringsItIn(t *testing.T) {
	rig := openRig(t, "owner")
	dbtest.Exec(t, rig.s.Store,
		`INSERT INTO identities (id, kind, handle, display_name, display_skeleton, avatar_letter, avatar_palette, created_at) VALUES (901,'agent','docs','Docs','docs','D',0,1)`,
		`INSERT INTO agents (identity_id, created_by_human) VALUES (901,1)`)

	code, root := rig.postAs(t, rig.c, `{"client_id":"thr-root-1","body":"Step 1 is the chips UI"}`)
	if code != http.StatusCreated {
		t.Fatalf("the root: %d %v", code, root)
	}
	rootID := strconv.FormatInt(int64(root["id"].(float64)), 10)
	if code, reply := rig.postAs(t, rig.c, `{"client_id":"thr-reply-1","body":"@docs can you check?","thread_root_id":`+rootID+`}`); code != http.StatusCreated {
		t.Fatalf("the reply: %d %v", code, reply)
	}

	rig.inTx(t, func(ctx context.Context, d pdb.DBTX) error {
		parts, err := conversation.Participants(ctx, d, rig.conv)
		if err != nil {
			return err
		}
		if !slices.ContainsFunc(parts, func(p conversation.Participant) bool { return p.IdentityID == 901 }) {
			t.Errorf("participants %v: want docs (901) brought in by the thread reply", parts)
		}
		return nil
	})
}
