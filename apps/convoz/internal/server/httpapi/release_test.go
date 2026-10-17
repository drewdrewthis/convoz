package httpapi

import (
	"bytes"
	"context"
	"slices"
	"testing"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/auth"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/inbox"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/dbtest"
)

// Every path that ends a lease hands its ids back, and releasing those ids frees the claims the leases held.
func TestEveryLeaseEndingPathFreesTheClaimsOfTheLeasesItEnded(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	box, err := auth.NewKeyBox(bytes.Repeat([]byte{7}, 32))
	if err != nil {
		t.Fatal(err)
	}
	paths := map[string]func(ctx context.Context, d pdb.DBTX) ([]int64, error){
		"machine sessions ended": func(ctx context.Context, d pdb.DBTX) ([]int64, error) {
			return auth.EndMachineSessions(ctx, d, 1, "key_regenerated", now)
		},
		"machine revoked": func(ctx context.Context, d pdb.DBTX) ([]int64, error) {
			_, ended, err := auth.RevokeMachine(ctx, d, 1, now)
			return ended, err
		},
		"key regenerated": func(ctx context.Context, d pdb.DBTX) ([]int64, error) {
			id, err := auth.CreateMachine(ctx, d, box, auth.NewMachine{Name: "box-9", Scopes: auth.DefaultScopes, Allow: auth.Allow{Mode: auth.AllowAny}, ApprovedBy: 1}, now)
			if err != nil {
				return nil, err
			}
			if _, err := d.ExecContext(ctx, `UPDATE sessions SET machine_id = ? WHERE id = 100`, id); err != nil {
				return nil, err
			}
			_, _, ended, err := auth.RegenerateKey(ctx, d, box, id, now)
			return ended, err
		},
		"identity disabled": func(ctx context.Context, d pdb.DBTX) ([]int64, error) {
			return auth.EndIdentitySessions(ctx, d, 2, "identity_disabled", now)
		},
		"left the allow-list": func(ctx context.Context, d pdb.DBTX) ([]int64, error) {
			return auth.EndMachineIdentitySessions(ctx, d, 1, 2, "allow_removed", now)
		},
	}
	for name, end := range paths {
		t.Run(name, func(t *testing.T) {
			s := dbtest.Store(t)
			dbtest.Exec(t, s,
				`INSERT INTO identities (id, kind, handle, display_name, display_skeleton, avatar_letter, avatar_palette, created_at) VALUES
				   (1,'human','drew','Drew','drew','D',0,1),(2,'agent','devtool','Devtool','devtool','D',0,1)`,
				`INSERT INTO humans (identity_id, role, created_via) VALUES (1,'owner','bootstrap')`,
				`INSERT INTO agents (identity_id, created_by_human) VALUES (2,1)`,
				`INSERT INTO conversations (id, created_by, created_at, last_activity_at) VALUES (10,1,1,1)`,
				`INSERT INTO machines (id, name, key_hash, key_enc, key_dek_id, key_hint, scopes, allow_mode, approved_by, created_at, key_created_at)
				   VALUES (1,'box-2',zeroblob(32),zeroblob(8),1,'cvz_m_x',127,'any',1,1,1)`,
				`INSERT INTO sessions (id, identity_id, machine_id, token_hash, client_id, label, scopes, created_at, last_seen_at, expires_at) VALUES
				   (100,2,1,randomblob(32),'client-aaaa','a',127,1,1,9999999999999)`)
			var released []inbox.Released
			dbtest.Tx(t, s, func(ctx context.Context, d pdb.DBTX) error {
				if err := inbox.FanOut(ctx, d, now, 2, 10, 1, 1, inbox.ReasonActivity); err != nil {
					return err
				}
				if _, err := inbox.Claim(ctx, d, now, inbox.Request{Identity: 2, Session: 100, N: 1}); err != nil {
					return err
				}
				ended, err := end(ctx, d)
				if err != nil {
					return err
				}
				if !slices.Equal(ended, []int64{100}) {
					t.Errorf("ended lease ids: %v, want [100]", ended)
				}
				released, err = inbox.ReleaseSessions(ctx, d, now.Add(time.Second), ended)
				return err
			})
			if want := []inbox.Released{{Identity: 2, Conversation: 10}}; !slices.Equal(released, want) {
				t.Fatalf("released %v, want %v", released, want)
			}
		})
	}
}
