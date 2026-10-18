package auth

import (
	"context"
	"errors"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/auth/db"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// ErrDuplicatePending means a request with the same machine name or handle is already waiting for the owner.
var ErrDuplicatePending = errors.New("a request with that name or handle is already waiting")

// MarkViaInternet marks a waiting identity request as one that came in on the agents-only listener.
func MarkViaInternet(ctx context.Context, d pdb.DBTX, ref string) error {
	if beforeViaInternet() {
		return nil
	}
	return db.New(d).MarkIdentityRequestViaInternet(ctx, ref)
}

// ViaInternetRefs is the set of waiting identity requests (by ref) that came in over the internet.
func ViaInternetRefs(ctx context.Context, d pdb.DBTX) (map[string]bool, error) {
	out := map[string]bool{}
	if beforeViaInternet() {
		return out, nil
	}
	refs, err := db.New(d).ListViaInternetIdentityRefs(ctx)
	for _, r := range refs {
		out[r] = true
	}
	return out, err
}

// CheckNoPendingDuplicate refuses a request whose machine name or handle is already waiting for the owner, so one sender
// cannot fill the owner's feed with look-alike cards. An empty handle matches no handle.
func CheckNoPendingDuplicate(ctx context.Context, d pdb.DBTX, name, handle string, now time.Time) error {
	taken, err := db.New(d).PendingNameOrHandleTaken(ctx, db.PendingNameOrHandleTakenParams{Now: now.UnixMilli(), Name: name, Handle: handle})
	if err != nil {
		return err
	}
	if taken == 1 {
		return ErrDuplicatePending
	}
	return nil
}
