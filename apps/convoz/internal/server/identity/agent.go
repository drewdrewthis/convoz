package identity

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/identity/db"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// Reserved handles (design I-3): they name things the product itself uses.
var Reserved = map[string]bool{
	"owner": true, "system": true, "all": true, "here": true, "everyone": true, "channel": true,
	"admin": true, "convoz": true, "cvz": true, "inbox": true, "brief": true,
}

// Errors CreateAgent returns; the HTTP layer maps each to a field of the request.
var (
	ErrInvalidHandle      = errors.New("invalid or reserved handle")
	ErrHandleTaken        = errors.New("handle is taken or was used before")
	ErrInvalidDisplayName = errors.New("invalid display name")
	ErrConfusableName     = errors.New("display name looks like another identity")
	ErrNotAgent           = errors.New("no such agent")
)

// Principal is an identity of either kind, found by handle or id.
type Principal struct {
	ID          int64
	Kind        string // "human" or "agent"
	Handle      string
	DisplayName string
	Disabled    bool
}

// Lookup finds an identity by handle (any case). ok is false when there is none.
func Lookup(ctx context.Context, d pdb.DBTX, handle string) (Principal, bool, error) {
	r, err := db.New(d).GetIdentityByHandle(ctx, handle)
	if errors.Is(err, sql.ErrNoRows) {
		return Principal{}, false, nil
	}
	return Principal{ID: r.ID, Kind: r.Kind, Handle: r.Handle, DisplayName: r.DisplayName, Disabled: r.DisabledAt.Valid}, err == nil, err
}

// ByID finds an identity by id. ok is false when there is none.
func ByID(ctx context.Context, d pdb.DBTX, id int64) (Principal, bool, error) {
	r, err := db.New(d).GetIdentity(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		return Principal{}, false, nil
	}
	return Principal{ID: r.ID, Kind: r.Kind, Handle: r.Handle, DisplayName: r.DisplayName, Disabled: r.DisabledAt.Valid}, err == nil, err
}

// Handles maps identity ids to handles.
func Handles(ctx context.Context, d pdb.DBTX) (map[int64]string, error) {
	list, err := List(ctx, d)
	if err != nil {
		return nil, err
	}
	out := make(map[int64]string, len(list))
	for _, e := range list {
		out[e.ID] = e.Handle
	}
	return out, nil
}

// NewAgent is a request to make an agent. Exactly one of ByHuman and ByMachine is set.
type NewAgent struct {
	Handle      string
	DisplayName string
	ByHuman     int64
	ByMachine   int64
}

// CreateAgent makes an agent identity (design I-3). The handle is compared and stored in lowercase; it must
// be valid, not reserved and never used before. The display name must not look like any active identity's
// handle or display name. Call it inside the transaction of the action it belongs to.
func CreateAgent(ctx context.Context, d pdb.DBTX, in NewAgent, now time.Time) (Principal, error) {
	q := db.New(d)
	handle := strings.ToLower(in.Handle)
	if !ValidHandle(handle) || Reserved[handle] {
		return Principal{}, ErrInvalidHandle
	}
	if !ValidDisplayName(in.DisplayName) {
		return Principal{}, ErrInvalidDisplayName
	}
	if _, found, err := Lookup(ctx, d, handle); err != nil {
		return Principal{}, err
	} else if found {
		return Principal{}, ErrHandleTaken
	}
	if used, err := q.HandleWasUsed(ctx, handle); err != nil {
		return Principal{}, err
	} else if used {
		return Principal{}, ErrHandleTaken
	}
	skeleton := Skeleton(in.DisplayName)
	active, err := q.ActiveSkeletons(ctx)
	if err != nil {
		return Principal{}, err
	}
	for _, a := range active {
		if a.DisplaySkeleton == skeleton || Skeleton(a.Handle) == skeleton {
			return Principal{}, ErrConfusableName
		}
	}
	id, err := newIdentity(ctx, q, "agent", handle, in.DisplayName, now)
	if err != nil {
		if pdb.IsUniqueViolation(err) {
			return Principal{}, ErrConfusableName
		}
		return Principal{}, err
	}
	if err := q.InsertAgent(ctx, db.InsertAgentParams{
		IdentityID:       id,
		CreatedByHuman:   sql.NullInt64{Int64: in.ByHuman, Valid: in.ByHuman != 0},
		CreatedByMachine: sql.NullInt64{Int64: in.ByMachine, Valid: in.ByMachine != 0},
	}); err != nil {
		return Principal{}, err
	}
	return Principal{ID: id, Kind: "agent", Handle: handle, DisplayName: in.DisplayName}, nil
}

// DisableAgent turns an agent off. It reports false when there is no such enabled agent (a human cannot be
// disabled here). The caller ends the agent's sessions in the same transaction.
func DisableAgent(ctx context.Context, d pdb.DBTX, id int64, now time.Time) (bool, error) {
	n, err := db.New(d).DisableAgent(ctx, db.DisableAgentParams{DisabledAt: sql.NullInt64{Int64: now.UnixMilli(), Valid: true}, ID: id})
	return n > 0, err
}

// CreatedByMachineSince counts the agents a machine made after since, and when the oldest of them was made.
func CreatedByMachineSince(ctx context.Context, d pdb.DBTX, machineID int64, since time.Time) (n, oldestMs int64, err error) {
	r, err := db.New(d).CountAgentsCreatedByMachineSince(ctx, db.CountAgentsCreatedByMachineSinceParams{MachineID: sql.NullInt64{Int64: machineID, Valid: true}, Since: since.UnixMilli()})
	return r.N, r.Oldest, err
}
