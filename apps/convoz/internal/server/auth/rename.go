package auth

import (
	"context"
	"fmt"
	"time"

	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// Renamed is set on a mint whose `as` named a handle the agent had before (I-51): the lease is for that agent until Until (epoch ms).
type Renamed struct {
	From, To string
	Until    int64
}

// HandleRenamedError refuses `as` with a handle the agent gave up longer ago than the grace; the words name the new handle.
type HandleRenamedError struct{ From, To string }

func (e *HandleRenamedError) Error() string {
	return fmt.Sprintf("@%s is now @%s. Use --as %s.", e.From, e.To, e.To)
}

// ErrAllowWidens refuses a new handle that a glob of a machine would cover while that machine may not act as the agent now: a
// handle change never gives a machine an agent it did not have.
var ErrAllowWidens = &FieldError{Field: "handle", Message: "That handle would let another machine act as this agent. Pick a different one."}

// KeepAllowOnRename keeps the set of machines that may act as an agent the same across its handle change from → to, in the
// caller's transaction, before the handle moves. A machine that covers the agent only by a glob of the old handle gets the agent's
// id, so its sessions go on (the allow trigger reads the handle). A machine whose glob covers the new handle but not the agent now
// refuses the change with ErrAllowWidens.
func KeepAllowOnRename(ctx context.Context, d pdb.DBTX, agentID int64, from, to string, now time.Time) error {
	list, err := ListMachines(ctx, d, now)
	if err != nil {
		return err
	}
	var pin []Machine
	for _, m := range list {
		if m.Allow.Mode == AllowAny {
			continue
		}
		covers := m.Allow.Covers(agentID, from)
		if !covers && m.Allow.CoversHandle(to) {
			return ErrAllowWidens
		}
		if covers && !m.Allow.Covers(agentID, to) {
			pin = append(pin, m)
		}
	}
	for _, m := range pin {
		m.Allow.IdentityIDs = append(m.Allow.IdentityIDs, agentID)
		if err := ReplaceAllow(ctx, d, m.ID, m.Allow); err != nil {
			return err
		}
	}
	return nil
}
