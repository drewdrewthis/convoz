package cli

import (
	"context"
	"encoding/base64"
	"fmt"
	"os"
	"strings"
	"unicode"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

const pageUsage = "usage: convoz page read [--conv N] [--json] | convoz page shot [--conv N] [--out PATH] | convoz page status [--json]"

// shotAnswerMax is the biggest answer of a screenshot: a 5 MB PNG in base64, and the JSON around it.
const shotAnswerMax = 8 << 20

// Page runs `convoz page read|shot|status`: an agent reads, or takes a screenshot of, the tab the owner shares with one of its
// conversations (page-share.feature). Without --conv it uses the only shared tab it can see.
func Page(args []string, io IO) int {
	if len(args) > 0 {
		switch args[0] {
		case "read", "shot":
			return pageAsk(args[0], args[1:], io)
		case "status":
			return pageStatus(args[1:], io)
		}
	}
	return usageError(io, pageUsage)
}

// pageAsk is `convoz page read` and `convoz page shot`. A read prints the note first, then the address, the title, the elements and
// the text; with --json the read as the server sent it. A shot writes the PNG (to a new temp file unless --out names one) and prints
// its path. A request is never retried: each one leaves a line in the conversation.
func pageAsk(op string, args []string, io IO) int {
	f := newChatFlags("page "+op, io)
	conv := f.fs.Int64("conv", 0, "the conversation whose shared tab to use; needed only when more than one tab is shared with you")
	var out *string
	if op == wire.PageOpShot {
		out = f.fs.String("out", "", "where to write the PNG; a new temp file when not given")
	}
	pos, ok := f.parse(args, io)
	if !ok {
		return ExitUsage
	}
	if len(pos) != 0 {
		return usageError(io, pageUsage)
	}
	k, code := f.open(io)
	if k == nil {
		return code
	}
	if *conv == 0 {
		if *conv, code = k.onlyShare(); code != ExitOK {
			return code
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), k.timeout)
	defer cancel()
	c := k.c.withTimeout(k.timeout)
	c.answerMax = shotAnswerMax
	var answer wire.PageAnswer
	if err := c.call(ctx, "POST", wire.RoutePageRequests, k.lease, wire.PageRequest{ConversationID: *conv, Op: op}, &answer); err != nil {
		return k.fail(err)
	}
	if op == wire.PageOpShot {
		return k.writeShot(answer.Shot, *out)
	}
	if answer.Read == nil {
		return fail(io, fmt.Errorf("the server sent no read"))
	}
	if k.asJSON {
		k.printJSON(answer.Read)
	} else {
		printRead(k.io, *answer.Read)
	}
	return ExitOK
}

// onlyShare is the conversation of the one tab shared with the agent.
func (k *chatCmd) onlyShare() (int64, int) {
	shares, err := k.shares()
	switch {
	case err != nil:
		return 0, k.fail(err)
	case len(shares) == 0:
		fmt.Fprintln(k.io.Stderr, "convoz: no shared tab")
		return 0, ExitConflict
	case len(shares) > 1:
		return 0, usageError(k.io, fmt.Sprintf("%d tabs are shared with you: name one with --conv N (convoz page status lists them)", len(shares)))
	}
	return shares[0].ConversationID, ExitOK
}

func (k *chatCmd) shares() ([]wire.PageShare, error) {
	var out wire.PageSharesResponse
	err := k.callRetry("GET", wire.RoutePageShares, nil, &out)
	return out.Shares, err
}

// writeShot writes the PNG to path, or to a new temp file, and prints where.
func (k *chatCmd) writeShot(shot *wire.PageShot, path string) int {
	if shot == nil {
		return fail(k.io, fmt.Errorf("the server sent no screenshot"))
	}
	png, err := base64.StdEncoding.DecodeString(shot.PNGBase64)
	if err != nil {
		return fail(k.io, fmt.Errorf("the screenshot is not readable: %w", err))
	}
	if path == "" {
		f, err := os.CreateTemp("", "convoz-shot-*.png")
		if err != nil {
			return fail(k.io, err)
		}
		path = f.Name()
		_ = f.Close()
	}
	if err := os.WriteFile(path, png, 0o600); err != nil {
		return fail(k.io, err)
	}
	fmt.Fprintln(k.io.Stdout, path)
	return ExitOK
}

// printRead prints a read for an agent to look at. The note comes first, so the page's words below it never pass for Convoz's.
func printRead(io IO, r wire.PageRead) {
	w := io.Stdout
	fmt.Fprintln(w, wire.PageNote)
	fmt.Fprintln(w, "URL: "+oneLine(r.URL))
	fmt.Fprintln(w, "Title: "+oneLine(r.Title))
	fmt.Fprintln(w, "Elements:")
	for _, e := range r.Elements {
		line := fmt.Sprintf("  %s %s %q", e.Ref, oneLine(e.Role), oneLine(e.Name))
		if e.Value != "" {
			line += ": " + oneLine(e.Value)
		}
		fmt.Fprintln(w, line)
	}
	fmt.Fprintln(w, "Text:")
	fmt.Fprintln(w, strings.TrimRight(r.Text, "\n"))
}

// oneLine keeps a page's word on its line: control characters become spaces.
func oneLine(s string) string {
	return strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return ' '
		}
		return r
	}, s)
}

// pageStatus is `convoz page status`: the tabs shared with the agent's conversations, one "<conv> <origin>" line each.
func pageStatus(args []string, io IO) int {
	f := newChatFlags("page status", io)
	pos, ok := f.parse(args, io)
	if !ok {
		return ExitUsage
	}
	if len(pos) != 0 {
		return usageError(io, pageUsage)
	}
	k, code := f.open(io)
	if k == nil {
		return code
	}
	shares, err := k.shares()
	if err != nil {
		return k.fail(err)
	}
	if k.asJSON {
		k.printJSON(wire.PageSharesResponse{Shares: shares})
		return ExitOK
	}
	if len(shares) == 0 {
		fmt.Fprintln(io.Stdout, "no shared tab")
	}
	for _, s := range shares {
		fmt.Fprintf(io.Stdout, "%d %s\n", s.ConversationID, s.TabOrigin)
	}
	return ExitOK
}
