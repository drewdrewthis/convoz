package settings

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/settings/db"
)

// ErrInvalid wraps every refusal of a write: an unknown key, the wrong scope, a wrong type or an out-of-range value.
var ErrInvalid = errors.New("invalid setting")

// Entry is one setting as the API shows it.
type Entry struct {
	Scope Scope  `json:"scope"`
	Key   string `json:"key"`
	Value any    `json:"value"`
}

// All returns every registry key for the identity: the stored value, or the default when the row is missing.
func All(ctx context.Context, d db.DBTX, identity int64) ([]Entry, error) {
	q := db.New(d)
	stored := map[string]string{}
	ws, err := q.WorkspaceValues(ctx)
	if err != nil {
		return nil, err
	}
	for _, r := range ws {
		stored[string(Workspace)+"/"+r.Key] = r.ValueJson
	}
	us, err := q.UserValues(ctx, identity)
	if err != nil {
		return nil, err
	}
	for _, r := range us {
		stored[string(User)+"/"+r.Key] = r.ValueJson
	}
	out := make([]Entry, 0, len(registry))
	for _, key := range Keys() {
		def := registry[key]
		e := Entry{Scope: def.scope, Key: key, Value: def.initial}
		if raw, ok := stored[string(def.scope)+"/"+key]; ok {
			var v any
			if json.Unmarshal([]byte(raw), &v) == nil {
				if checked, err := def.check(v); err == nil { // a row the registry no longer accepts reads as the default
					e.Value = checked
				}
			}
		}
		out = append(out, e)
	}
	return out, nil
}

// Set checks and stores one value. The scope the caller names must be the key's own scope. A workspace row records who changed it.
func Set(ctx context.Context, d db.DBTX, now time.Time, identity int64, scope Scope, key string, raw json.RawMessage) (Entry, error) {
	def, ok := registry[key]
	if !ok {
		return Entry{}, fmt.Errorf("%w: no setting named %q", ErrInvalid, key)
	}
	if def.scope != scope {
		return Entry{}, fmt.Errorf("%w: %q is a %s setting", ErrInvalid, key, def.scope)
	}
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		return Entry{}, fmt.Errorf("%w: value is not JSON", ErrInvalid)
	}
	checked, err := def.check(v)
	if err != nil {
		return Entry{}, fmt.Errorf("%w: %q %s", ErrInvalid, key, err)
	}
	text, err := json.Marshal(checked)
	if err != nil {
		return Entry{}, err
	}
	q := db.New(d)
	if scope == Workspace {
		err = q.SetWorkspaceValue(ctx, db.SetWorkspaceValueParams{Key: key, ValueJson: string(text), UpdatedBy: identity, Now: now.UnixMilli()})
	} else {
		err = q.SetUserValue(ctx, db.SetUserValueParams{IdentityID: identity, Key: key, ValueJson: string(text), Now: now.UnixMilli()})
	}
	return Entry{Scope: scope, Key: key, Value: checked}, err
}
