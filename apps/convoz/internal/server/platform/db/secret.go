package db

import (
	"fmt"
	"strings"
)

// secret holds the hex form of the database key. It prints as "[key]" under every
// verb, so a stray %v, %+v, %#v or %s of a struct that points at it cannot leak it.
type secret struct{ hex string }

func (*secret) String() string   { return "[key]" }
func (*secret) GoString() string { return "[key]" }

// Format implements fmt.Formatter for the verbs String and GoString do not cover.
func (*secret) Format(f fmt.State, _ rune) { _, _ = f.Write([]byte("[key]")) }

// scrub removes the key from an error text before the error leaves this package.
func (s *secret) scrub(err error) error {
	if err == nil {
		return nil
	}
	return scrubbed{err, s}
}

type scrubbed struct {
	err error
	key *secret
}

func (e scrubbed) Error() string {
	return strings.ReplaceAll(e.err.Error(), e.key.hex, "[key]")
}

func (e scrubbed) Unwrap() error { return e.err }
