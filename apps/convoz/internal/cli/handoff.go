package cli

import (
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

// Handoff runs `convoz handoff <note|->` to leave a note for the next session of this agent (at most 4096 bytes), or
// `convoz handoff --list` to list the notes kept, newest first. A retry after a lost answer stores the note once.
func Handoff(args []string, io IO) int {
	f := newChatFlags("handoff", io)
	list := f.fs.Bool("list", false, "list the notes kept instead of storing one")
	clientID := f.fs.String("client-id", "", "the id that makes a retry safe; random when not given")
	pos, ok := f.parse(args, io)
	if !ok {
		return ExitUsage
	}
	if *list {
		if len(pos) != 0 {
			return usageError(io, "usage: convoz handoff --list")
		}
		return handoffList(f, io)
	}
	if len(pos) != 1 {
		return usageError(io, "usage: convoz handoff [--client-id C] <note|->")
	}
	note := pos[0]
	if note == "-" {
		raw, err := readAll(io)
		if err != nil {
			return fail(io, err)
		}
		note = strings.TrimRight(raw, "\r\n")
	}
	switch {
	case strings.TrimSpace(note) == "":
		return usageError(io, "the handoff note is empty")
	case len(note) > wire.MaxHandoffBytes:
		return usageError(io, fmt.Sprintf("a handoff note is at most %d bytes; this one is %d", wire.MaxHandoffBytes, len(note)))
	case !utf8.ValidString(note):
		return usageError(io, "the handoff note is not text")
	}
	if *clientID == "" {
		*clientID = "convoz-" + randomHex(8)
	}
	k, code := f.open(io)
	if k == nil {
		return code
	}
	var out wire.Handoff
	if err := k.callRetry("POST", wire.RouteHandoffs, wire.HandoffRequest{ClientID: *clientID, Body: note}, &out); err != nil {
		return k.fail(err)
	}
	if k.asJSON {
		k.printJSON(out)
	} else {
		fmt.Fprintln(k.io.Stdout, out.ID)
	}
	return ExitOK
}

func handoffList(f *chatFlags, io IO) int {
	k, code := f.open(io)
	if k == nil {
		return code
	}
	var out wire.HandoffsResponse
	if err := k.callRetry("GET", wire.RouteHandoffs, nil, &out); err != nil {
		return k.fail(err)
	}
	if k.asJSON {
		k.printJSON(map[string]any{"handoffs": append([]wire.Handoff{}, out.Handoffs...)})
		return ExitOK
	}
	for _, h := range out.Handoffs {
		first, _, _ := strings.Cut(h.Body, "\n")
		fmt.Fprintf(k.io.Stdout, "#%d %s %s on %s: %s\n", h.ID, time.UnixMilli(h.CreatedAt).UTC().Format(time.RFC3339), plain(h.Session), plain(h.Machine), plain(first))
	}
	return ExitOK
}
