package cli

import (
	"fmt"
)

// needsYouFlags are the two flags that say whether a post needs the owner. --fyi is the only way a post can go out as news without a
// hint; --needs-you is refused, because a message that needs the owner is an ask.
type needsYouFlags struct{ fyi, needsYou *bool }

func newNeedsYouFlags(f *chatFlags) needsYouFlags {
	return needsYouFlags{
		fyi:      f.fs.Bool("fyi", false, "this message does not need the owner (news, a result, a note to an agent)"),
		needsYou: f.fs.Bool("needs-you", false, "refused: a message that needs the owner is an ask; use convoz ask"),
	}
}

const askPointer = "a message that needs the owner is an ask: use convoz ask (it shows in Now and pushes them). If it does not need the owner, add --fyi."

// check refuses --needs-you with exit 2 and, without --fyi, prints the hint. It reports whether the command goes on.
func (n needsYouFlags) check(io IO, verb string) (code int, ok bool) {
	if *n.needsYou {
		return usageError(io, "convoz "+verb+": "+askPointer), false
	}
	if !*n.fyi {
		fmt.Fprintf(io.Stderr, "convoz: add --fyi to convoz %s when it does not need the owner. If it needs the owner's decision, use convoz ask.\n", verb)
	}
	return ExitOK, true
}

// news is the needs_you value every plain post sends: false, since the other answer is an ask.
func news() *bool { return new(bool) }
