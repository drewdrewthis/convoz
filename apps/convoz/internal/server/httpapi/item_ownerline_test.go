package httpapi

import (
	"context"
	"net/http"
	"strconv"
	"strings"
	"testing"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/item"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

func (r *freshRig) block(t *testing.T, key, title string) (int, string, string) {
	t.Helper()
	code, e := r.send(t, r.s.postItem, "POST", `{"title":`+strconv.Quote(title)+`,"context":"CI is green"}`,
		map[string]string{"id": strconv.FormatInt(r.conv, 10), "key": key, "event": "block"})
	return code, e.Field, e.Message
}

func TestABlockTitleThatIsNotOnePlainSentenceIs400AndStoresNothing(t *testing.T) {
	for why, text := range badLines {
		t.Run(why, func(t *testing.T) {
			r := newFreshRig(t)
			code, field, msg := r.block(t, "k1", text)
			if code != http.StatusBadRequest || field != "title" || !strings.Contains(msg, "This one "+why+`: "`) {
				t.Fatalf("%d field %q %q, want 400 on title with %q", code, field, msg, why)
			}
			r.tx(t, func(ctx context.Context, d pdb.DBTX) error {
				if _, err := item.ByKey(ctx, d, 901, r.conv, "k1"); err != item.ErrNotFound {
					t.Fatalf("item stored: %v", err)
				}
				return nil
			})
		})
	}
}

func TestABlockTitleOfOnePlainSentenceIs200(t *testing.T) {
	for i, title := range []string{"Approve the prod deploy of PR 240.", "Pick a color, e.g. blue, for the button.", "Upgrade the agent to v1.2 today."} {
		r := newFreshRig(t)
		if code, _, msg := r.block(t, "k"+strconv.Itoa(i), title); code != http.StatusOK {
			t.Fatalf("%q: %d %s, want 200", title, code, msg)
		}
	}
}
