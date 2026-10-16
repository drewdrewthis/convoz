package auth

import (
	"context"
	"errors"
	"time"

	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// Agent is an identity as the machine, session and crew flows see it (the identity module owns the row).
type Agent struct {
	ID          int64
	Kind        string // "human" or "agent"
	Handle      string
	DisplayName string
	Disabled    bool
}

// NewAgent is a request to make an agent identity, by the owner or by a machine.
type NewAgent struct {
	Handle      string
	DisplayName string
	ByHuman     int64
	ByMachine   int64
}

// AgentPort is what the flows need from the identity module. The composition root implements it.
// Create reports a refusal as a *FieldError or ErrHandleTaken.
type AgentPort interface {
	// ValidHandle reports whether s can be an agent handle.
	ValidHandle(s string) bool
	Lookup(ctx context.Context, d pdb.DBTX, handle string) (a Agent, found bool, err error)
	Handles(ctx context.Context, d pdb.DBTX) (map[int64]string, error)
	Create(ctx context.Context, d pdb.DBTX, in NewAgent, now time.Time) (Agent, error)
	// Disable reports false when there is no such enabled agent.
	Disable(ctx context.Context, d pdb.DBTX, id int64, now time.Time) (bool, error)
	CreatedByMachineSince(ctx context.Context, d pdb.DBTX, machineID int64, since time.Time) (n, oldestMs int64, err error)
}

// Ports are the other modules the machine, session and crew flows write through.
type Ports struct {
	Agents  AgentPort
	Journal JournalPort
}

// Refusals of the flows; the HTTP layer maps each to an answer.
var (
	ErrCodeMismatch = errors.New("the typed code does not match")
	ErrMachineGone  = errors.New("the machine key stopped working")
	ErrHandleTaken  = errors.New("handle taken")
	ErrNoAgent      = errors.New("no such enabled agent")
)

// ForbiddenError carries the sentence for a 403 raised inside a flow.
type ForbiddenError string

func (e ForbiddenError) Error() string { return string(e) }

// BadAllowError carries the sentence for a refused allow-list.
type BadAllowError string

func (e BadAllowError) Error() string { return string(e) }

// FieldError is a refusal about one request field.
type FieldError struct{ Field, Message string }

func (e *FieldError) Error() string { return e.Message }

// NameTakenError is ErrNameTaken with the name that was taken (it may come from the request, not the owner).
type NameTakenError struct{ Name string }

func (e *NameTakenError) Error() string        { return ErrNameTaken.Error() }
func (e *NameTakenError) Is(target error) bool { return target == ErrNameTaken }
