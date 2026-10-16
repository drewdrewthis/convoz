package auth

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/auth/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// RecoveryCodeCount is how many codes a batch holds.
const RecoveryCodeCount = 10

// NewRecoveryCodes makes a fresh batch of codes for a human and revokes the unused codes of older
// batches. The codes are returned once; only their SHA-256 is stored.
func NewRecoveryCodes(ctx context.Context, d pdb.DBTX, humanID int64, now time.Time) ([]string, error) {
	q := db.New(d)
	last, err := q.MaxRecoveryBatch(ctx, humanID)
	if err != nil {
		return nil, err
	}
	if err := q.RevokeUnusedRecoveryCodes(ctx, db.RevokeUnusedRecoveryCodesParams{RevokedAt: sql.NullInt64{Int64: now.UnixMilli(), Valid: true}, HumanID: humanID}); err != nil {
		return nil, err
	}
	codes := make([]string, 0, RecoveryCodeCount)
	for range RecoveryCodeCount {
		// 14 base62 characters are about 83 bits (design: 80-bit codes).
		code := PrefixRecovery + platform.TokenMarker() + randomBase62(14)
		if err := q.InsertRecoveryCode(ctx, db.InsertRecoveryCodeParams{HumanID: humanID, CodeHash: hashToken(code), Batch: last + 1, CreatedAt: now.UnixMilli()}); err != nil {
			return nil, err
		}
		codes = append(codes, code)
	}
	return codes, nil
}

// UseRecoveryCode spends a code and returns whose it was; ok is false for an unknown, used or revoked code.
func UseRecoveryCode(ctx context.Context, d pdb.DBTX, code string, now time.Time) (int64, bool, error) {
	q := db.New(d)
	humanID, err := q.UseRecoveryCode(ctx, db.UseRecoveryCodeParams{UsedAt: sql.NullInt64{Int64: now.UnixMilli(), Valid: true}, CodeHash: hashToken(strings.TrimSpace(code))})
	if errors.Is(err, sql.ErrNoRows) {
		return 0, false, nil
	}
	return humanID, err == nil, err
}

// RecoveryCodesLeft counts the codes that can still be used.
func RecoveryCodesLeft(ctx context.Context, d pdb.DBTX, humanID int64) (int64, error) {
	return db.New(d).CountRecoveryCodesLeft(ctx, humanID)
}

// RegenerateRecoveryCodes spends a recovery.regenerate step-up, voids the unused old codes, makes 10 new ones
// and writes the audit line and the event. Call it inside one write transaction: a failure leaves the step-up good.
func RegenerateRecoveryCodes(ctx context.Context, d pdb.DBTX, j JournalPort, in CrewInput, now time.Time) ([]string, error) {
	if err := ConsumeStepUp(ctx, d, in.StepUpID, in.DeviceID, "recovery.regenerate", nil, now); err != nil {
		return nil, err
	}
	codes, err := NewRecoveryCodes(ctx, d, in.Human.ID, now)
	if err != nil {
		return nil, err
	}
	if err := j.Audit(ctx, d, now, AuditEntry{Actor: in.Human.ID, Device: in.DeviceID, Action: "recovery.regenerated"}); err != nil {
		return nil, err
	}
	return codes, j.Event(ctx, d, now, "recovery.regenerated", map[string]any{"identity_id": in.Human.ID})
}
