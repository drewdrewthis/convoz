package cli

import (
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

// Limits of a plan, the same as the server's (plan.feature).
const (
	maxPlanText    = 200
	maxPlanNext    = 5
	maxPlanWaiting = 5
	maxPlanDone    = 5
)

// Plan runs `convoz plan <conv> ...`: it replaces the agent's whole plan for the conversation at once, so the owner never sees half
// of it. The owner sees the line under the conversation's title, the details panel and a dot in the list. A plan with --doing also
// sets the agent's status to working (Crew). --done items are added to the Done history; everything else is replaced, so a
// plan without --waiting has nothing waiting on the owner any more. It prints the plan as stored.
func Plan(args []string, io IO) int {
	f := newChatFlags("plan", io)
	doing := f.fs.String("doing", "", "what you do now (at most one item, 200 characters)")
	step := f.fs.String("step", "", "the step of the doing item, as N/M (step 2 of 3 is 2/3)")
	eta := f.fs.String("eta", "", "when the doing item should be done: a duration (30m, 1h30m) or a time HH:MM on this machine's clock")
	blocked := f.fs.String("blocked", "", "what blocks you here (not the owner: use --waiting for that)")
	var next, waiting, done repeated
	f.fs.Var(&next, "next", "what you do next, in order (up to 5 times)")
	f.fs.Var(&waiting, "waiting", "what waits on the owner (up to 5 times); something new pushes the owner")
	f.fs.Var(&done, "done", "an item you finished (up to 5 times); a quiet line tells the owner")
	clientID := f.fs.String("client-id", "", "the id that makes a retry safe; random when not given")
	usage := "usage: convoz plan <conv> [--doing D] [--step N/M] [--eta 30m|HH:MM] [--blocked B] [--next N]... [--waiting W]... [--done D]..."
	pos, ok := f.parse(args, io)
	if !ok {
		return ExitUsage
	}
	if len(pos) != 1 {
		return usageError(io, usage)
	}
	conv, ok := convArg(io, pos[0])
	if !ok {
		return ExitUsage
	}
	for _, c := range []struct {
		name  string
		items []string
		most  int
	}{{"next", next, maxPlanNext}, {"waiting", waiting, maxPlanWaiting}, {"done", done, maxPlanDone}} {
		if len(c.items) > c.most {
			return usageError(io, fmt.Sprintf("--%s is at most %d items", c.name, c.most))
		}
	}
	for _, t := range append(append(append([]string{*doing, *blocked}, next...), waiting...), done...) {
		if utf8.RuneCountInString(t) > maxPlanText {
			return usageError(io, fmt.Sprintf("an item is at most %d characters", maxPlanText))
		}
	}
	if *doing == "" && (*eta != "" || *step != "") {
		return usageError(io, "--eta and --step belong to --doing")
	}
	k, code := f.open(io)
	if k == nil {
		return code
	}
	if *clientID == "" {
		*clientID = "convoz-" + randomHex(8)
	}
	_, offset := time.Now().Zone()
	req := wire.PlanRequest{Doing: *doing, Step: *step, ETA: *eta, UTCOffset: offset, Blocked: *blocked, Next: next, Waiting: waiting, Done: done, ClientID: *clientID}
	var stored wire.Plan
	if err := k.callRetry("PUT", convPath(conv, "plan"), req, &stored); err != nil {
		return k.fail(err)
	}
	if k.asJSON {
		k.printJSON(stored)
	} else {
		fmt.Fprint(k.io.Stdout, planText(stored))
	}
	return ExitOK
}

// planText is a plan as lines a person reads: one item per line, its kind first.
func planText(p wire.Plan) string {
	var b strings.Builder
	if p.Doing != "" {
		line := "Doing: " + plain(p.Doing)
		if p.Step != nil {
			line += fmt.Sprintf(" (step %d of %d)", p.Step.At, p.Step.Of)
		}
		if p.ETA != 0 {
			line += " · ready ~" + time.UnixMilli(p.ETA).Format("15:04")
		}
		b.WriteString(line + "\n")
	}
	if p.Blocked != "" {
		b.WriteString("Blocked: " + plain(p.Blocked) + "\n")
	}
	for _, n := range p.Next {
		b.WriteString("Next: " + plain(n) + "\n")
	}
	for _, w := range p.Waiting {
		b.WriteString("Waiting on you: " + plain(w.Text) + "\n")
	}
	for i, d := range p.Done {
		if i == 3 {
			fmt.Fprintf(&b, "Done: %d more\n", len(p.Done)-3)
			break
		}
		b.WriteString("Done: " + plain(d.Text) + "\n")
	}
	if b.Len() == 0 {
		b.WriteString("Nothing planned\n")
	}
	return b.String()
}
