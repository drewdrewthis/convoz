package cli

import (
	"fmt"
	"time"
	"unicode/utf8"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

// maxPlanDeliver is how many deliverables one plan holds, as the server's (delivery.feature).
const maxPlanDeliver = 5

// deliverItems collects the deliverables in the order the flags come: each --due belongs to the --deliver just before it.
type deliverItems struct {
	items []wire.PlanDeliverRequest
	bad   string // the first misuse, said when the parse is done
}

type deliverFlag struct {
	d   *deliverItems
	due bool
}

func (f deliverFlag) String() string { return "" }

func (f deliverFlag) Set(v string) error {
	d := f.d
	switch {
	case !f.due:
		d.items = append(d.items, wire.PlanDeliverRequest{Text: v})
	case len(d.items) == 0:
		d.fail("--due needs a --deliver before it")
	case d.items[len(d.items)-1].Due != "":
		d.fail(`--due is given twice for "` + d.items[len(d.items)-1].Text + `"`)
	default:
		d.items[len(d.items)-1].Due = v
	}
	return nil
}

func (d *deliverItems) fail(msg string) {
	if d.bad == "" {
		d.bad = msg
	}
}

// problem is the first thing wrong with the deliverables, or "".
func (d *deliverItems) problem() string {
	if d.bad != "" {
		return d.bad
	}
	if len(d.items) > maxPlanDeliver {
		return fmt.Sprintf("--deliver is at most %d items", maxPlanDeliver)
	}
	for _, it := range d.items {
		if it.Due == "" {
			return `--deliver "` + it.Text + `" needs a --due after it`
		}
		if utf8.RuneCountInString(it.Text) > maxPlanText {
			return fmt.Sprintf("an item is at most %d characters", maxPlanText)
		}
	}
	return ""
}

// deliverLines are the deliverables of a plan as lines a person reads: "Deliver: X · due Tue 18:00".
func deliverLines(p wire.Plan) (out string) {
	for _, d := range p.Deliver {
		out += "Deliver: " + plain(d.Text) + " · due " + time.UnixMilli(d.Due).Format("Mon 2 Jan 15:04") + "\n"
	}
	return out
}
