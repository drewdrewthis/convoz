package auth

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/auth/db"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// StepUpTTL is how long a step-up can be used after the passkey assertion.
const StepUpTTL = 5 * time.Minute

// StepUpActions are the actions a step-up can be asked for in this slice. Later slices add theirs here.
var StepUpActions = map[string]bool{
	"passkey.add":         true,
	"passkey.remove":      true,
	"recovery.regenerate": true,
	"machine.reveal":      true,
	"machine.regenerate":  true,
	"machine.revoke":      true,
	"machine.allow":       true,
	"identity.create":     true,
	"identity.triage":     true,
	"message.purge":       true,
	"data.export":         true,
	"data.delete":         true,
	"signout.all":         true,
}

// ErrStepUp means the step-up is unknown, used, expired, or for another device, action or target.
var ErrStepUp = errors.New("step-up is not valid for this action")

// IssueStepUp records a verified passkey assertion for one action on one target.
func IssueStepUp(ctx context.Context, d pdb.DBTX, deviceID, passkeyID int64, action string, target *int64, now time.Time) (int64, error) {
	q := db.New(d)
	return q.InsertStepUp(ctx, db.InsertStepUpParams{
		DeviceID:  deviceID,
		PasskeyID: passkeyID,
		Action:    action,
		TargetID:  nullTarget(target),
		CreatedAt: now.UnixMilli(),
		ExpiresAt: now.Add(StepUpTTL).UnixMilli(),
	})
}

// ConsumeStepUp spends a step-up. Call it inside the transaction of the action: if the action
// fails, the transaction rolls back and the step-up is still good.
func ConsumeStepUp(ctx context.Context, d pdb.DBTX, id, deviceID int64, action string, target *int64, now time.Time) error {
	q := db.New(d)
	n, err := q.ConsumeStepUp(ctx, db.ConsumeStepUpParams{
		Now:      sql.NullInt64{Int64: now.UnixMilli(), Valid: true},
		ID:       id,
		DeviceID: deviceID,
		Action:   action,
		TargetID: nullTarget(target),
	})
	if err != nil {
		return err
	}
	if n == 0 {
		return ErrStepUp
	}
	return nil
}

func nullTarget(t *int64) sql.NullInt64 {
	if t == nil {
		return sql.NullInt64{}
	}
	return sql.NullInt64{Int64: *t, Valid: true}
}
