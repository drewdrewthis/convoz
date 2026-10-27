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
	maxPlanNow     = 3
	maxPlanNext    = 5
	maxPlanWaiting = 5
	maxPlanDone    = 5
)

// nowItems collects the Now items in the order the flags come: each --step and --eta belongs to the --doing just before it, so one
// ordered collector serves the three flags (a flag.FlagSet alone cannot say which --eta followed which --doing).
type nowItems struct {
	items []wire.PlanNowRequest
	bad   string // the first misuse, said when the parse is done
}

type nowFlag struct {
	n    *nowItems
	kind string // doing, step or eta
}

func (f nowFlag) String() string { return "" }

func (f nowFlag) Set(v string) error {
	n := f.n
	if f.kind == "doing" {
		n.items = append(n.items, wire.PlanNowRequest{Text: v})
		return nil
	}
	if len(n.items) == 0 {
		n.fail("--" + f.kind + " needs a --doing before it")
		return nil
	}
	it := &n.items[len(n.items)-1]
	if f.kind == "step" && it.Step != "" || f.kind == "eta" && it.ETA != "" {
		n.fail("--" + f.kind + " is given twice for " + `"` + it.Text + `"`)
	} else if f.kind == "step" {
		it.Step = v
	} else {
		it.ETA = v
	}
	return nil
}

func (n *nowItems) fail(msg string) {
	if n.bad == "" {
		n.bad = msg
	}
}

// Plan runs `convoz plan <conv> ...`: it replaces the agent's whole plan for the conversation at once, so the owner never sees half
// of it. The owner sees the line under the conversation's title, the details panel and a dot in the list. A plan with --doing also
// sets the agent's status to working (Crew). --done items are added to the Done history; deliverables (--deliver with --due) are
// kept until a --done names them; everything else is replaced, so a plan without --waiting has nothing waiting on the owner any more. It prints the plan as stored.
func Plan(args []string, io IO) int {
	f := newChatFlags("plan", io)
	var now nowItems
	f.fs.Var(nowFlag{&now, "doing"}, "doing", "what you do now (200 characters); up to 3 times when you work in parallel")
	f.fs.Var(nowFlag{&now, "step"}, "step", "the step of the --doing before it, as N/M (step 2 of 3 is 2/3)")
	f.fs.Var(nowFlag{&now, "eta"}, "eta", "when the --doing before it should be done: a duration (30m, 1h30m) or a time HH:MM on this machine's clock")
	var deliver deliverItems
	f.fs.Var(deliverFlag{&deliver, false}, "deliver", "what you will deliver (up to 5); it stays on the owner's Deliveries until you name it in --done")
	f.fs.Var(deliverFlag{&deliver, true}, "due", "when the --deliver before it is due: a duration (2d, 1d4h), a time HH:MM or a date YYYY-MM-DD HH:MM")
	blocked := f.fs.String("blocked", "", "what blocks you here (not the owner: use --waiting for that)")
	var next, waiting, done repeated
	f.fs.Var(&next, "next", "what you do next, in order (up to 5 times)")
	f.fs.Var(&waiting, "waiting", "what only the owner must do (no name prefix); up to 5 times, and something new pushes the owner")
	f.fs.Var(&done, "done", "an item you finished (up to 5 times); a quiet line tells the owner")
	clientID := f.fs.String("client-id", "", "the id that makes a retry safe; random when not given")
	usage := "usage: convoz plan <conv> [--doing D [--step N/M] [--eta 30m|HH:MM]]... [--deliver X --due 2d|HH:MM]... [--blocked B] [--next N]... [--waiting W]... [--done D]..."
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
	if now.bad != "" {
		return usageError(io, now.bad)
	}
	if bad := deliver.problem(); bad != "" {
		return usageError(io, bad)
	}
	if len(now.items) > maxPlanNow {
		return usageError(io, fmt.Sprintf("--doing is at most %d items", maxPlanNow))
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
	texts := append(append(append([]string{*blocked}, next...), waiting...), done...)
	for _, it := range now.items {
		texts = append(texts, it.Text)
	}
	for _, t := range texts {
		if utf8.RuneCountInString(t) > maxPlanText {
			return usageError(io, fmt.Sprintf("an item is at most %d characters", maxPlanText))
		}
	}
	k, code := f.open(io)
	if k == nil {
		return code
	}
	if *clientID == "" {
		*clientID = "convoz-" + randomHex(8)
	}
	_, offset := time.Now().Zone()
	req := wire.PlanRequest{UTCOffset: offset, Blocked: *blocked, Next: next, Waiting: waiting, Done: done, Deliver: deliver.items, ClientID: *clientID}
	if len(now.items) == 1 { // one item goes in the older form, which every server reads
		req.Doing, req.Step, req.ETA = now.items[0].Text, now.items[0].Step, now.items[0].ETA
	} else {
		req.Now = now.items
	}
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
	for _, it := range p.Now {
		line := "Doing: " + plain(it.Text)
		if it.Step != nil {
			line += fmt.Sprintf(" (step %d of %d)", it.Step.At, it.Step.Of)
		}
		if it.ETA != 0 {
			line += " · ready ~" + time.UnixMilli(it.ETA).Format("15:04")
		}
		b.WriteString(line + "\n")
	}
	b.WriteString(deliverLines(p))
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
