package auth

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/auth/db"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// MaxActiveMachines is the cap on machines that are not revoked (design §2.2).
const MaxActiveMachines = 10

// Errors the machine functions return; the HTTP layer maps them to 4xx answers.
var (
	ErrNameTaken  = errors.New("an active machine already has that name")
	ErrMachineCap = errors.New("the machine cap is reached")
	ErrNoMachine  = errors.New("no such active machine")
	ErrNoRequest  = errors.New("no such pending machine request")
	ErrBadAllow   = errors.New("the allow-list is not valid")
	ErrBadMachine = errors.New("the machine name is not valid")
)

const machineNameLen = 60

// Machine is one logged-in machine as the owner sees it. The key is never part of it.
type Machine struct {
	ID           int64
	Name         string
	KeyHint      string
	Scopes       int64
	Allow        Allow
	LiveSessions int64
	LastUsedAt   *int64
	KeyVersion   int64
}

// NewMachine is what an approval turns a request into.
type NewMachine struct {
	Name       string
	Scopes     int64
	Allow      Allow
	ApprovedBy int64
}

// ValidMachineName reports whether name can be a machine name (1 to 60 of a-z 0-9 . -).
func ValidMachineName(name string) bool {
	if name == "" || len(name) > machineNameLen {
		return false
	}
	for _, c := range name {
		if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '.' || c == '-') {
			return false
		}
	}
	return true
}

// keyHint is the first 10 characters of a key: the prefix and 4 characters of the secret part.
func keyHint(key string) string { return key[:10] }

// CheckMachineSlot says whether a machine named name can be made now: the name is valid and free among the
// active machines, and fewer than ten are active. CreateMachine runs it too; the approval runs it first so a
// refusal for the name or the cap needs nothing else to be right.
func CheckMachineSlot(ctx context.Context, d pdb.DBTX, name string) error {
	q := db.New(d)
	if !ValidMachineName(name) {
		return ErrBadMachine
	}
	if _, err := q.GetActiveMachineByName(ctx, name); err == nil {
		return ErrNameTaken
	} else if !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	n, err := q.CountActiveMachines(ctx)
	if err != nil {
		return err
	}
	if n >= MaxActiveMachines {
		return ErrMachineCap
	}
	return nil
}

// CreateMachine makes the machine with a fresh key, stores the key sealed (and its SHA-256 for lookups),
// and writes the allow-list. It refuses a taken name and the 11th active machine. The key is returned to
// nobody here: the machine fetches it through its device request, the owner through Reveal.
func CreateMachine(ctx context.Context, d pdb.DBTX, box *KeyBox, in NewMachine, now time.Time) (int64, error) {
	q := db.New(d)
	if err := CheckMachineSlot(ctx, d, in.Name); err != nil {
		return 0, err
	}
	key := newToken(PrefixMachine)
	id, err := q.InsertMachine(ctx, db.InsertMachineParams{
		Name: in.Name, KeyHash: hashToken(key), KeyEnc: []byte{}, KeyHint: keyHint(key), Scopes: in.Scopes,
		AllowMode: in.Allow.Mode, ApprovedBy: in.ApprovedBy, CreatedAt: now.UnixMilli(),
	})
	if err != nil {
		if pdb.IsUniqueViolation(err) {
			return 0, ErrNameTaken
		}
		return 0, err
	}
	// The AAD names the machine, which has no id until the insert, so the sealed copy is stored second.
	if err := q.SealMachineKey(ctx, db.SealMachineKeyParams{KeyEnc: box.Seal(id, 1, key), ID: id}); err != nil {
		return 0, err
	}
	return id, writeAllow(ctx, q, id, in.Allow)
}

func writeAllow(ctx context.Context, q *db.Queries, machineID int64, a Allow) error {
	if err := q.DeleteMachineAllow(ctx, machineID); err != nil {
		return err
	}
	if a.Mode == AllowAny {
		return nil
	}
	for _, id := range a.IdentityIDs {
		if err := q.InsertAllowIdentity(ctx, db.InsertAllowIdentityParams{MachineID: machineID, IdentityID: sql.NullInt64{Int64: id, Valid: true}}); err != nil {
			return err
		}
	}
	for _, g := range a.Globs {
		if err := q.InsertAllowGlob(ctx, db.InsertAllowGlobParams{MachineID: machineID, Glob: sql.NullString{String: g, Valid: true}}); err != nil {
			return err
		}
	}
	return nil
}

// ReplaceAllow swaps the allow-list of an active machine. It does not end leases: the caller decides which
// identities lost cover (it knows their handles) and calls EndMachineSessionsOf for each.
func ReplaceAllow(ctx context.Context, d pdb.DBTX, machineID int64, a Allow) error {
	q := db.New(d)
	if _, err := q.GetActiveMachine(ctx, machineID); errors.Is(err, sql.ErrNoRows) {
		return ErrNoMachine
	} else if err != nil {
		return err
	}
	if err := q.SetMachineAllowMode(ctx, db.SetMachineAllowModeParams{AllowMode: a.Mode, ID: machineID}); err != nil {
		return err
	}
	return writeAllow(ctx, q, machineID, a)
}

func allowsByMachine(ctx context.Context, q *db.Queries) (map[int64]*Allow, error) {
	rows, err := q.ListMachineAllow(ctx)
	if err != nil {
		return nil, err
	}
	out := map[int64]*Allow{}
	for _, r := range rows {
		a := out[r.MachineID]
		if a == nil {
			a = &Allow{}
			out[r.MachineID] = a
		}
		if r.IdentityID.Valid {
			a.IdentityIDs = append(a.IdentityIDs, r.IdentityID.Int64)
		}
		if r.Glob.Valid {
			a.Globs = append(a.Globs, r.Glob.String)
		}
	}
	return out, nil
}

func allowOf(mode string, rows map[int64]*Allow, id int64) Allow {
	a := Allow{Mode: mode}
	if r := rows[id]; r != nil && mode == AllowList {
		a.IdentityIDs, a.Globs = r.IdentityIDs, r.Globs
	}
	return a
}

// ListMachines returns the active machines, oldest first, with their live session counts.
func ListMachines(ctx context.Context, d pdb.DBTX, now time.Time) ([]Machine, error) {
	q := db.New(d)
	rows, err := q.ListActiveMachines(ctx, now.UnixMilli())
	if err != nil {
		return nil, err
	}
	allows, err := allowsByMachine(ctx, q)
	if err != nil {
		return nil, err
	}
	out := make([]Machine, 0, len(rows))
	for _, r := range rows {
		m := Machine{ID: r.ID, Name: r.Name, KeyHint: r.KeyHint, Scopes: r.Scopes, Allow: allowOf(r.AllowMode, allows, r.ID), LiveSessions: r.LiveSessions}
		if r.LastUsedAt.Valid {
			m.LastUsedAt = &r.LastUsedAt.Int64
		}
		out = append(out, m)
	}
	return out, nil
}

// MachineByKey finds the active machine whose key this is. ok is false for an unknown or revoked key.
func MachineByKey(ctx context.Context, d pdb.DBTX, key string) (Machine, bool, error) {
	q := db.New(d)
	r, err := q.GetMachineByKeyHash(ctx, hashToken(key))
	if errors.Is(err, sql.ErrNoRows) {
		return Machine{}, false, nil
	}
	if err != nil {
		return Machine{}, false, err
	}
	allows, err := allowsByMachine(ctx, q)
	if err != nil {
		return Machine{}, false, err
	}
	return Machine{ID: r.ID, Name: r.Name, KeyHint: r.KeyHint, Scopes: r.Scopes, Allow: allowOf(r.AllowMode, allows, r.ID), KeyVersion: r.KeyVersion}, true, nil
}

// MachineNames maps machine ids to names, revoked machines included (a "created by" label outlives the machine).
func MachineNames(ctx context.Context, d pdb.DBTX) (map[int64]string, error) {
	rows, err := db.New(d).ListMachineNames(ctx)
	if err != nil {
		return nil, err
	}
	out := make(map[int64]string, len(rows))
	for _, r := range rows {
		out[r.ID] = r.Name
	}
	return out, nil
}

// MachineName is the name of one active machine.
func MachineName(ctx context.Context, d pdb.DBTX, id int64) (string, error) {
	r, err := db.New(d).GetActiveMachine(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrNoMachine
	}
	return r.Name, err
}

// RevealKey opens the stored copy of the machine key. The caller must hold a spent step-up and must
// never store, log or audit the result.
func RevealKey(ctx context.Context, d pdb.DBTX, box *KeyBox, machineID int64) (string, error) {
	r, err := db.New(d).GetActiveMachine(ctx, machineID)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrNoMachine
	}
	if err != nil {
		return "", err
	}
	return box.Open(r.ID, r.KeyVersion, r.KeyEnc)
}

// RegenerateKey replaces the key. The old key stops working at once, and so does every lease it made; their ids
// come back as ended.
func RegenerateKey(ctx context.Context, d pdb.DBTX, box *KeyBox, machineID int64, now time.Time) (key string, version int64, ended []int64, err error) {
	q := db.New(d)
	r, err := q.GetActiveMachine(ctx, machineID)
	if errors.Is(err, sql.ErrNoRows) {
		return "", 0, nil, ErrNoMachine
	}
	if err != nil {
		return "", 0, nil, err
	}
	version = r.KeyVersion + 1
	key = newToken(PrefixMachine)
	n, err := q.ReplaceMachineKey(ctx, db.ReplaceMachineKeyParams{
		KeyHash: hashToken(key), KeyEnc: box.Seal(machineID, version, key), KeyVersion: version,
		KeyHint: keyHint(key), KeyCreatedAt: now.UnixMilli(), ID: machineID,
	})
	if err != nil {
		return "", 0, nil, err
	}
	if n == 0 {
		return "", 0, nil, ErrNoMachine
	}
	ended, err = EndMachineSessions(ctx, d, machineID, "key_regenerated", now)
	return key, version, ended, err
}

// RevokeMachine ends the machine: its key stops working and so does every lease. It reports whether it was active
// and the ids of the leases it ended.
func RevokeMachine(ctx context.Context, d pdb.DBTX, machineID int64, now time.Time) (bool, []int64, error) {
	q := db.New(d)
	n, err := q.RevokeMachine(ctx, db.RevokeMachineParams{RevokedAt: sql.NullInt64{Int64: now.UnixMilli(), Valid: true}, ID: machineID})
	if err != nil || n == 0 {
		return false, nil, err
	}
	ended, err := EndMachineSessions(ctx, d, machineID, "machine_revoked", now)
	return true, ended, err
}
