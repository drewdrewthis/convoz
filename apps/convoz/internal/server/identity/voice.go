package identity

import (
	"context"
	"database/sql"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/identity/db"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// VoiceHandle is the built-in agent the owner's voice call writes as. Owner (2026-10-22): what the call sends comes from @voice, a
// secretary between him and his agents, never from him "via voice". The handle is reserved, it cannot be renamed, and auth starts no
// session as it, so only the owner's call, through the server, writes as @voice.
const VoiceHandle = "voice"

const voiceName = "Voice"

// IsBuiltin says whether p holds the handle only the server acts as: @voice. No session acts as it (auth mints none, and refuses any
// older lease of it), whichever agent holds the handle.
func IsBuiltin(p Principal) bool { return p.Kind == "agent" && p.Handle == VoiceHandle }

// Voice finds @voice, or makes it the first time, in the caller's transaction; owner is the human it is made by. ErrHandleTaken means
// someone else holds the handle (a person, or an agent made before the handle was reserved), or another identity the display name "Voice".
func Voice(ctx context.Context, d pdb.DBTX, owner int64, now time.Time) (Principal, error) {
	p, found, err := Lookup(ctx, d, VoiceHandle)
	switch {
	case err != nil:
		return Principal{}, err
	case found && p.Kind != "agent":
		return Principal{}, ErrHandleTaken
	case found:
		builtin, err := madeBy(ctx, d, p.ID, owner)
		if err != nil {
			return Principal{}, err
		}
		if !builtin {
			return Principal{}, ErrHandleTaken
		}
		return p, nil
	}
	q := db.New(d)
	id, err := newIdentity(ctx, q, "agent", VoiceHandle, voiceName, now)
	if pdb.IsUniqueViolation(err) {
		return Principal{}, ErrHandleTaken
	}
	if err != nil {
		return Principal{}, err
	}
	if err := q.InsertAgent(ctx, db.InsertAgentParams{IdentityID: id, CreatedByHuman: sql.NullInt64{Int64: owner, Valid: true}}); err != nil {
		return Principal{}, err
	}
	return Principal{ID: id, Kind: "agent", Handle: VoiceHandle, DisplayName: voiceName}, nil
}

// madeBy says whether the agent id was made by the human `by`. It is the built-in's mark: Voice makes @voice as the owner's, and the
// handle is reserved, so any other @voice is an agent made before that, by a machine or a person the server does not speak for.
func madeBy(ctx context.Context, d pdb.DBTX, id, by int64) (bool, error) {
	var human sql.NullInt64
	err := d.QueryRowContext(ctx, `SELECT created_by_human FROM agents WHERE identity_id = ?`, id).Scan(&human)
	return human.Valid && human.Int64 == by, err
}
