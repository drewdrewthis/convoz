package identity

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

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
	ErrConfusableHandle   = errors.New("handle looks like another identity")
	ErrNotAgent           = errors.New("no such agent")
)

// Principal is an identity of either kind, found by handle or id.
type Principal struct {
	ID          int64
	Kind        string // "human" or "agent"
	Handle      string
	DisplayName string
	Disabled    bool
	DisabledAt  int64 // epoch ms; 0 while enabled
}

// Lookup finds an identity by handle (any case). ok is false when there is none.
func Lookup(ctx context.Context, d pdb.DBTX, handle string) (Principal, bool, error) {
	r, err := db.New(d).GetIdentityByHandle(ctx, handle)
	if errors.Is(err, sql.ErrNoRows) {
		return Principal{}, false, nil
	}
	return Principal{ID: r.ID, Kind: r.Kind, Handle: r.Handle, DisplayName: r.DisplayName, Disabled: r.DisabledAt.Valid, DisabledAt: r.DisabledAt.Int64}, err == nil, err
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
	if err := CheckNewHandle(ctx, d, handle); err != nil {
		return Principal{}, err
	}
	if !ValidDisplayName(in.DisplayName) {
		return Principal{}, ErrInvalidDisplayName
	}
	if err := checkDisplayName(ctx, q, in.DisplayName); err != nil {
		return Principal{}, err
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

// CheckNewHandle says whether handle (lowercase) may become a new agent's handle: valid, not reserved, not taken, never used before
// and not a look-alike (UTS #39 skeleton) of any handle, retired handle or display name, disabled identities included (I-3). A
// request runs it when it is filed and again when the owner approves it, so a request reserves nothing.
func CheckNewHandle(ctx context.Context, d pdb.DBTX, handle string) error {
	return checkHandle(ctx, d, handle, "", 0)
}

// checkHandle is CheckNewHandle for the identity ownID whose handle is now own ("" and 0 for a new one): its own display name does
// not count, and a handle it retired itself may be taken back.
func checkHandle(ctx context.Context, d pdb.DBTX, handle, own string, ownID int64) error {
	q := db.New(d)
	if !ValidHandle(handle) || Reserved[handle] {
		return ErrInvalidHandle
	}
	if _, found, err := Lookup(ctx, d, handle); err != nil {
		return err
	} else if found {
		return ErrHandleTaken
	}
	if used, err := q.HandleWasUsed(ctx, db.HandleWasUsedParams{Handle: handle, OwnID: ownID}); err != nil {
		return err
	} else if used {
		return ErrHandleTaken
	}
	skeleton := Skeleton(handle)
	all, err := q.AllSkeletons(ctx)
	if err != nil {
		return err
	}
	for _, a := range all {
		if (a.DisplaySkeleton == skeleton && (own == "" || a.Handle != own)) || Skeleton(a.Handle) == skeleton {
			return ErrConfusableHandle
		}
	}
	retired, err := q.RetiredHandles(ctx, ownID)
	if err != nil {
		return err
	}
	for _, h := range retired {
		if Skeleton(h) == skeleton {
			return ErrConfusableHandle
		}
	}
	return nil
}

func checkDisplayName(ctx context.Context, q *db.Queries, name string) error {
	skeleton := Skeleton(name)
	active, err := q.ActiveSkeletons(ctx)
	if err != nil {
		return err
	}
	for _, a := range active {
		if a.DisplaySkeleton == skeleton || Skeleton(a.Handle) == skeleton {
			return ErrConfusableName
		}
	}
	return nil
}

// CheckNewAgent is every rule CreateAgent applies, without creating anything: the handle (CheckNewHandle) and the display name.
func CheckNewAgent(ctx context.Context, d pdb.DBTX, handle, displayName string) error {
	if err := CheckNewHandle(ctx, d, strings.ToLower(handle)); err != nil {
		return err
	}
	if !ValidDisplayName(displayName) {
		return ErrInvalidDisplayName
	}
	return checkDisplayName(ctx, db.New(d), displayName)
}

// SetIntro stores what a new agent said about itself in its request: the description and the cleaned SVG avatar (empty for none).
// Unlike SetProfile it does not start the one-change-an-hour clock, so the agent can still set its own profile at once.
func SetIntro(ctx context.Context, d pdb.DBTX, id int64, description, avatarSVG string) error {
	q := db.New(d)
	if err := q.SetAgentDescription(ctx, db.SetAgentDescriptionParams{Description: description, ID: id}); err != nil {
		return err
	}
	if avatarSVG == "" {
		return nil
	}
	return SetAvatar(ctx, d, id, avatarSVG)
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

// Reintro is what a returning agent says about itself; an empty field leaves what the identity has.
type Reintro struct {
	DisplayName string
	Description string
	AvatarSVG   string
}

// ReenableAgent brings a disabled agent back as the same identity (same id, handle, history and seats). A display name that looks
// like another active identity is refused. It reports false when there is no such disabled agent. The caller makes sure no old
// session of the agent lives (disable ended them all) and issues no credential here.
func ReenableAgent(ctx context.Context, d pdb.DBTX, id int64, in Reintro) (bool, error) {
	q := db.New(d)
	who, found, err := ByID(ctx, d, id)
	if err != nil || !found || who.Kind != "agent" || !who.Disabled {
		return false, err
	}
	if in.DisplayName != "" && in.DisplayName != who.DisplayName {
		if !ValidDisplayName(in.DisplayName) {
			return false, ErrInvalidDisplayName
		}
		if err := checkDisplayName(ctx, q, in.DisplayName); err != nil {
			return false, err
		}
		first, _ := utf8.DecodeRuneInString(in.DisplayName)
		if err := q.SetDisplayName(ctx, db.SetDisplayNameParams{DisplayName: in.DisplayName, DisplaySkeleton: Skeleton(in.DisplayName), AvatarLetter: string(unicode.ToUpper(first)), ID: id}); err != nil {
			return false, err
		}
	}
	n, err := q.EnableAgent(ctx, id)
	if err != nil {
		if pdb.IsUniqueViolation(err) {
			return false, ErrConfusableName
		}
		return false, err
	}
	if n == 0 {
		return false, nil
	}
	if in.Description != "" {
		if err := q.SetAgentDescription(ctx, db.SetAgentDescriptionParams{Description: in.Description, ID: id}); err != nil {
			return false, err
		}
	}
	if in.AvatarSVG != "" {
		return true, SetAvatar(ctx, d, id, in.AvatarSVG)
	}
	return true, nil
}

// ActiveAgents maps the id of every enabled agent to its handle.
func ActiveAgents(ctx context.Context, d pdb.DBTX) (map[int64]string, error) {
	list, err := List(ctx, d)
	if err != nil {
		return nil, err
	}
	out := map[int64]string{}
	for _, e := range list {
		if e.Kind == "agent" && !e.Disabled {
			out[e.ID] = e.Handle
		}
	}
	return out, nil
}
