package cli

import (
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

// Item runs `convoz item <start|block|done|fyi|drop|say> <conv> <key> [text]`: one call per transition of one step of the agent's work.
// A step is named by its key, so a retry finds the same step. The first step of a conversation is now; later ones wait as pending, and
// when the now step is done, fyi or dropped the next one starts by itself. block makes the step the owner's: give --recommend so the owner
// can accept it in one tap; without it the owner can only add info. Text is plain: no markdown, no links.
// take makes an item of a question of the owner (see itemTake); answer replies in the question's thread, quoting it, and marks it done.
func Item(args []string, io IO) int {
	usage := "usage: convoz item start|block|done|fyi|drop|say|answer <conv> <key> [\"<text>\"] --context C [--recommend R] [--plan P] [--due D] [--app FILE]"
	if len(args) == 0 {
		return usageError(io, usage)
	}
	sub, args := args[0], args[1:]
	switch sub {
	case "take":
		return itemTake(args, io)
	case "start", "block", "done", "fyi", "drop", "say", "answer":
	default:
		return usageError(io, usage)
	}
	f := newChatFlags("item "+sub, io)
	var context, recommend, due *string
	var appOpt appOpts
	var plan *string
	if sub == "start" || sub == "block" {
		context = f.fs.String("context", "", "why, in a sentence or two (plain text, 2000 characters)")
		appOpt = newAppOpts(f, "an app to show with the item (a JSON file); it rides on the item's message")
		plan = f.fs.String("plan", "main", "the plan this item is in; plans belong to you and span conversations (letters, digits, . - _)")
		due = f.fs.String("due", "", "when it is due, for display: a duration (2d, 1d4h) or a time HH:MM")
	}
	if sub == "block" {
		recommend = f.fs.String("recommend", "", "the one action you recommend; the owner can accept it in one tap (500 characters)")
	}
	pos, ok := f.parse(args, io)
	if !ok {
		return ExitUsage
	}
	want := 3
	if sub == "drop" || sub == "done" || sub == "fyi" {
		want = 2
	}
	if len(pos) < want || len(pos) > 3 {
		return usageError(io, usage)
	}
	conv, ok := convArg(io, pos[0])
	if !ok {
		return ExitUsage
	}
	req := wire.ItemRequest{}
	text := ""
	if len(pos) == 3 {
		text = pos[2]
	}
	var appRaw []byte
	var appBundle string
	if sub == "start" || sub == "block" {
		if strings.TrimSpace(*context) == "" {
			return usageError(io, "--context is required: say in a sentence or two why, for the owner. "+usage)
		}
		if appOpt.set() {
			var code int
			if appRaw, appBundle, code = appOpt.check(io); code != ExitOK {
				return code
			}
		}
		req.Plan = *plan
		req.Title, req.Context, req.Recommend = text, *context, ""
		if recommend != nil {
			req.Recommend = *recommend
		}
		if *due != "" {
			_, req.UTCOffset = time.Now().Zone()
			req.Due = *due
		}
	} else {
		req.Outcome = text
	}
	k, code := f.open(io)
	if k == nil {
		return code
	}
	if appRaw != nil {
		app, code := appOpt.send(k, conv, appRaw, appBundle)
		if code != ExitOK {
			return code
		}
		req.App = app
	}
	var out wire.FeedItem
	if err := k.callRetry("POST", convPath(conv, "items/"+url.PathEscape(pos[1])+"/"+sub), req, &out); err != nil {
		return k.fail(err)
	}
	if k.asJSON {
		k.printJSON(out)
	} else {
		fmt.Fprintf(k.io.Stdout, "%s %s: %s\n", out.Key, out.State, out.Title)
	}
	return ExitOK
}
