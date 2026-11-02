package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/auth"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/authz"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/plan"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/dbtest"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

// An agent that is in a conversation reads its plans (`convoz plan --show`); an agent that is not gets 403. Nothing is written.
func TestAnAgentMemberReadsThePlansOfAConversationAndANonMemberCannot(t *testing.T) {
	r := newFreshRig(t)
	r.setPlan(t, plan.Input{Now: []plan.Item{{Text: "Building invites"}}, Next: []string{"Reply chip"}})
	owner := strconv.FormatInt(r.owner, 10)
	dbtest.Exec(t, r.s.Store,
		`INSERT INTO identities (id, kind, handle, display_name, display_skeleton, avatar_letter, avatar_palette, created_at) VALUES (902,'agent','beta','Beta','beta','B',0,1)`,
		`INSERT INTO agents (identity_id, created_by_human) VALUES (902,`+owner+`)`,
		`INSERT INTO sessions (id, identity_id, machine_id, token_hash, client_id, label, scopes, created_at, last_seen_at, expires_at) VALUES
		   (9002,902,1,randomblob(32),'client-bbbb','b',127,1,1,9999999999999)`)
	outsider := &call{p: authz.Principal{Authenticated: true, SessionID: 9002, IdentityID: 902, Role: "agent"},
		lease: auth.Lease{SessionID: 9002, IdentityID: 902, MachineID: 1, Machine: "box-2", Label: "b", Scopes: auth.ScopePost}}

	get := func(c *call) (int, wire.PlanList) {
		id := strconv.FormatInt(r.conv, 10)
		req := httptest.NewRequest(http.MethodGet, "/api/conversations/"+id+"/plan", nil)
		req.SetPathValue("id", id)
		rec := httptest.NewRecorder()
		r.s.getConversationPlans(rec, req, c)
		var out wire.PlanList
		_ = json.Unmarshal(rec.Body.Bytes(), &out)
		return rec.Code, out
	}
	code, got := get(r.agent)
	if code != http.StatusOK || len(got.Plans) != 1 || got.Plans[0].Handle != "alpha" || got.Plans[0].Doing != "Building invites" || len(got.Plans[0].Next) != 1 {
		t.Fatalf("a member reads the plans: %d %+v", code, got)
	}
	if code, _ := get(outsider); code != http.StatusForbidden {
		t.Fatalf("a non-member reads the plans: %d, want 403", code)
	}
}
