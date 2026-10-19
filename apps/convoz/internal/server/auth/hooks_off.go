//go:build !testhooks

package auth

import (
	"context"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/auth/db"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// beforeIdentityRequests is false in a release build: every database is migrated to the end.
func beforeIdentityRequests() bool { return false }

// beforeViaInternet is false in a release build: every database is migrated to the end.
func beforeViaInternet() bool { return false }

// beforeInvites is false in a release build: every database is migrated to the end.
func beforeInvites() bool { return false }

// beforeSourceNode is false in a release build: every database is migrated to the end.
func beforeSourceNode() bool { return false }

func insertRequestBeforeSourceNode(context.Context, pdb.DBTX, db.InsertMachineRequestParams) (int64, bool, error) {
	return 0, false, nil
}

func pendingRequestsBeforeSourceNode(context.Context, pdb.DBTX, time.Time) ([]Request, bool, error) {
	return nil, false, nil
}

func pendingRequestBeforeSourceNode(context.Context, pdb.DBTX, int64, time.Time) (Request, bool, error) {
	return Request{}, false, nil
}
