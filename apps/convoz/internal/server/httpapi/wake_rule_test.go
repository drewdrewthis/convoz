package httpapi

import (
	"context"
	"slices"
	"strconv"
	"testing"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/authz"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/conversation"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/message"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/dbtest"
)

const (
	wakeA, wakeB               = int64(901), int64(902) // the agents "alpha" and "beta"
	wakeSessA, wakeSessB       = int64(9001), int64(9002)
	wakeOwnerSession     int64 = 0
)

// wakeRig is a conversation of the owner and two agents, each with a live session.
type wakeRig struct {
	*streamRig
	n int
}

func newWakeRig(t *testing.T) *wakeRig {
	t.Helper()
	rig := &wakeRig{streamRig: openRig(t, "owner")}
	owner := strconv.FormatInt(rig.c.human.ID, 10)
	dbtest.Exec(t, rig.s.Store,
		`INSERT INTO identities (id, kind, handle, display_name, display_skeleton, avatar_letter, avatar_palette, created_at) VALUES
		   (901,'agent','alpha','Alpha','alpha','A',0,1),(902,'agent','beta','Beta','beta','B',0,1)`,
		`INSERT INTO agents (identity_id, created_by_human) VALUES (901,`+owner+`),(902,`+owner+`)`,
		`INSERT INTO machines (id, name, key_hash, key_enc, key_dek_id, key_hint, scopes, allow_mode, approved_by, created_at, key_created_at)
		   VALUES (1,'box-2',zeroblob(32),zeroblob(8),1,'cvz_m_x',127,'any',`+owner+`,1,1)`,
		`INSERT INTO sessions (id, identity_id, machine_id, token_hash, client_id, label, scopes, created_at, last_seen_at, expires_at) VALUES
		   (9001,901,1,randomblob(32),'client-aaaa','a',127,1,1,9999999999999),(9002,902,1,randomblob(32),'client-bbbb','b',127,1,1,9999999999999)`)
	rig.inTx(t, func(ctx context.Context, d pdb.DBTX) error {
		for _, id := range []int64{wakeA, wakeB} {
			if _, err := conversation.Add(ctx, d, platform.SystemClock{}.Now(), conversation.Join{Conversation: rig.conv, Identity: id, By: rig.c.human.ID, Status: conversation.StatusActive}); err != nil {
				return err
			}
		}
		return nil
	})
	return rig
}

// post writes one message as the owner (session 0) or as an agent session, with the real ports, and returns its id and the wake list.
func (r *wakeRig) post(t *testing.T, author, session, root int64, body string) (int64, []int64) {
	t.Helper()
	r.n++
	p := r.c.p
	if session != wakeOwnerSession {
		p = authz.Principal{Authenticated: true, SessionID: session, IdentityID: author, Role: "agent"}
	}
	var posted message.Posted
	r.inTx(t, func(ctx context.Context, d pdb.DBTX) (err error) {
		posted, err = message.Post(ctx, d, triagePorts(p), platform.SystemClock{}.Now(), message.Draft{
			Conversation: r.conv, Author: author, Session: session, ClientID: "wake-client-" + strconv.Itoa(r.n), Body: body, ThreadRoot: root,
		})
		return err
	})
	return posted.Message.ID, posted.Wake
}

func (r *wakeRig) ownerID() int64 { return r.c.human.ID }

// reasonsOf is "reason:count" of each inbox item the agent holds (one per conversation: the strongest reason, the count of messages it covers).
func (r *wakeRig) reasonsOf(t *testing.T, agent int64) []string {
	t.Helper()
	rows, err := r.s.Store.Reader.SQL().Query(`SELECT reason || ':' || count FROM inbox_items WHERE identity_id = ? AND conversation_id = ? ORDER BY id`, agent, r.conv)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var s string
		if err := rows.Scan(&s); err != nil {
			t.Fatal(err)
		}
		out = append(out, s)
	}
	return out
}

// An agent's message reaches another agent only on a mention or in a thread that agent took part in; a person's reaches every agent.
func TestAnAgentMessageWakesAnotherAgentOnlyOnAMentionOrItsThread(t *testing.T) {
	cases := []struct {
		name     string
		act      func(t *testing.T, r *wakeRig) (wake []int64) // the last post, by alpha unless the case says otherwise
		wantB    []string                                      // reasons of beta's items
		wakeB    bool
		wantA    []string // reasons of alpha's items; nil when the case does not look
		checkOwn bool
	}{
		{
			name: "alpha posts in the main chat with no mention",
			act: func(t *testing.T, r *wakeRig) []int64 {
				_, w := r.post(t, wakeA, wakeSessA, 0, "status update")
				return w
			},
			wantB: nil, wakeB: false,
		},
		{
			name: "alpha mentions beta",
			act: func(t *testing.T, r *wakeRig) []int64 {
				_, w := r.post(t, wakeA, wakeSessA, 0, "@beta can you check?")
				return w
			},
			wantB: []string{"mention:1"}, wakeB: true,
		},
		{
			name: "alpha replies in a thread that beta started",
			act: func(t *testing.T, r *wakeRig) []int64 {
				root, _ := r.post(t, wakeB, wakeSessB, 0, "step 1 is the chips UI")
				_, w := r.post(t, wakeA, wakeSessA, root, "looks right")
				return w
			},
			wantB: []string{"thread:1"}, wakeB: true,
		},
		{
			name: "alpha replies in an owner thread where beta already replied",
			act: func(t *testing.T, r *wakeRig) []int64 {
				root, _ := r.post(t, r.ownerID(), wakeOwnerSession, 0, "who takes this?")
				r.post(t, wakeB, wakeSessB, root, "me")
				_, w := r.post(t, wakeA, wakeSessA, root, "ok")
				return w
			},
			wantB: []string{"thread:2"}, wakeB: true,
		},
		{
			name: "alpha replies in an owner thread where beta never posted",
			act: func(t *testing.T, r *wakeRig) []int64 {
				root, _ := r.post(t, r.ownerID(), wakeOwnerSession, 0, "who takes this?")
				_, w := r.post(t, wakeA, wakeSessA, root, "I do")
				return w
			},
			wantB: []string{"activity:1"}, wakeB: false, // only the owner's root made an item
		},
		{
			name: "the owner posts in the main chat with no mention",
			act: func(t *testing.T, r *wakeRig) []int64 {
				_, w := r.post(t, r.ownerID(), wakeOwnerSession, 0, "next step?")
				return w
			},
			wantB: []string{"activity:1"}, wakeB: true, wantA: []string{"activity:1"}, checkOwn: true,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := newWakeRig(t)
			wake := tc.act(t, r)
			if got := r.reasonsOf(t, wakeB); !slices.Equal(got, tc.wantB) {
				t.Errorf("beta's item reasons = %v, want %v", got, tc.wantB)
			}
			if got := slices.Contains(wake, wakeB); got != tc.wakeB {
				t.Errorf("beta in Posted.Wake = %v (wake %v), want %v", got, wake, tc.wakeB)
			}
			if tc.checkOwn {
				if got := r.reasonsOf(t, wakeA); !slices.Equal(got, tc.wantA) {
					t.Errorf("alpha's item reasons = %v, want %v", got, tc.wantA)
				}
			}
		})
	}
}
