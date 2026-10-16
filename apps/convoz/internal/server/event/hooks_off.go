//go:build !testhooks

package event

import (
	"context"
	"time"

	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// appendAsPreviousRelease never plays in a release build.
func appendAsPreviousRelease(context.Context, pdb.DBTX, time.Time, string, any) (int64, bool, error) {
	return 0, false, nil
}
