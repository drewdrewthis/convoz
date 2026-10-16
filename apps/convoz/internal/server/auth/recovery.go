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

// RecoveryNoteInfo is what the console tells a device that signed in through recovery: the codes left and when
// the hold on destructive actions ends.
type RecoveryNoteInfo struct {
	CodesLeft int64  `json:"codes_left"`
	HoldUntil *int64 `json:"hold_until"`
}

// RecoveryNote is the note for the full device session that a recovery registration starts: the console says
// "you signed in with a recovery code", so it is nil for every device whose passkey did not come from recovery
// (a passkey added from a held device is held too, but its owner did not sign in with a code).
// HoldUntil is nil once the hold has ended.
func RecoveryNote(ctx context.Context, d pdb.DBTX, humanID, passkeyID int64, now time.Time) (*RecoveryNoteInfo, error) {
	if passkeyID == 0 {
		return nil, nil
	}
	keys, err := ListPasskeys(ctx, d, humanID)
	if err != nil {
		return nil, err
	}
	for _, k := range keys {
		if k.ID != passkeyID || k.RegisteredVia != "recovery" {
			continue
		}
		note := &RecoveryNoteInfo{}
		if now.UnixMilli() < k.DestructiveAt {
			note.HoldUntil = &k.DestructiveAt
		}
		if note.CodesLeft, err = RecoveryCodesLeft(ctx, d, humanID); err != nil {
			return nil, err
		}
		return note, nil
	}
	return nil, nil
}
