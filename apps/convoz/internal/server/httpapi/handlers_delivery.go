package httpapi

// Deliveries (delivery.feature): the owner's one read of every deliverable, the parse of `--deliver X --due T`, and the one ask to
// the agent when a due date passes. Owner (Drew, conv 179, msg 9734); design @langwatch-assistant, conv 179 msg 9739.

import (
	"cmp"
	"context"
	"errors"
	"net/http"
	"slices"
	"strconv"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/conversation"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/event"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/inbox"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/plan"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

// shippedWindow is how far back the page lists shipped deliverables; the page counts the ones of the owner's today.
const shippedWindow = 48 * time.Hour

// parseDeliver checks the deliverables of a plan request and reads each due date; field names what is wrong ("" when it is fine).
func parseDeliver(in wire.PlanRequest, now time.Time) (out []plan.DeliverInput, field, why string) {
	if len(in.Deliver) > plan.MaxDeliver {
		return nil, "deliver", "deliver is at most 5 items"
	}
	for _, d := range in.Deliver {
		if !plan.CheckText(d.Text) {
			return nil, "deliver", "deliver items are 1 to 200 characters, with no control characters"
		}
		due, ok := plan.ParseDue(d.Due, in.UTCOffset, now)
		if !ok {
			return nil, "due", "due is a duration up to 60 days (2d, 1d4h, 30m), a time HH:MM or a date YYYY-MM-DD HH:MM, ahead of now"
		}
		out = append(out, plan.DeliverInput{Text: d.Text, Due: due})
	}
	return out, "", ""
}

// getDeliveries is GET /api/deliveries (owner only): every deliverable of every plan, the late ones first and then by due date, and
// what shipped in the last two days.
func (s *Server) getDeliveries(w http.ResponseWriter, r *http.Request, _ *call) {
	out, err := s.deliveries(r.Context())
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) deliveries(ctx context.Context) (wire.Deliveries, error) {
	d, now := s.reader(), s.Clock.Now().UnixMilli()
	out := wire.Deliveries{Now: now, Deliveries: []wire.Delivery{}, Shipped: []wire.ShippedDelivery{}}
	plans, err := plan.All(ctx, d)
	if err != nil {
		return out, err
	}
	dir, err := loadDirectory(ctx, d)
	if err != nil {
		return out, err
	}
	soon := func(t int64) {
		if t > now && (out.NextChangeAt == 0 || t < out.NextChangeAt) {
			out.NextChangeAt = t
		}
	}
	for _, p := range plans {
		if len(p.Deliver) == 0 && !slices.ContainsFunc(p.Done, func(x plan.Done) bool { return x.Shipped }) {
			continue
		}
		cv, found, err := conversation.Get(ctx, d, p.Conversation)
		if err != nil {
			return out, err
		}
		if !found { // in the trash: the owner put it away
			continue
		}
		handle := dir[p.Agent].Handle
		for _, x := range p.Done {
			if x.Shipped && now-x.At <= shippedWindow.Milliseconds() {
				out.Shipped = append(out.Shipped, wire.ShippedDelivery{ConversationID: p.Conversation, Title: cv.Title, Handle: handle, Text: x.Text, At: x.At})
			}
		}
		doing := make([]wire.PlanNow, 0, len(p.Now))
		for _, it := range p.Now {
			n := wire.PlanNow{Text: it.Text, Since: it.Since, ETA: it.ETA}
			if it.Step != nil {
				n.Step = &wire.PlanStep{At: it.Step.At, Of: it.Step.Of}
			}
			doing = append(doing, n)
		}
		soon(p.UpdatedAt + plan.DeliveryStaleAfter.Milliseconds())
		for _, x := range p.Deliver {
			soon(x.Due)
			out.Deliveries = append(out.Deliveries, wire.Delivery{ConversationID: p.Conversation, Title: cv.Title, IdentityID: p.Agent, Handle: handle,
				Text: x.Text, Due: x.Due, Since: x.Since, State: plan.DeliveryState(p, x, now), Stale: plan.DeliveryStale(p, now), Doing: doing,
				Waiting: len(p.Waiting), Blocked: p.Blocked, PlanUpdatedAt: p.UpdatedAt})
		}
	}
	slices.SortStableFunc(out.Deliveries, func(a, b wire.Delivery) int {
		al, bl := a.State == plan.DeliveryLate, b.State == plan.DeliveryLate
		if al != bl {
			if al {
				return -1
			}
			return 1
		}
		return cmp.Compare(a.Due, b.Due)
	})
	slices.SortStableFunc(out.Shipped, func(a, b wire.ShippedDelivery) int { return cmp.Compare(b.At, a.At) })
	return out, nil
}

// nudgeDeliveries asks each agent once per due date about a deliverable whose date passed: one status_due item (its text is
// deliveryNudge), never a push to the owner. A deliverable already asked about for its date is skipped; a new date asks again.
func (s *Server) nudgeDeliveries(ctx context.Context) error {
	now := s.Clock.Now()
	nowMs := now.UnixMilli()
	plans, err := plan.All(ctx, s.reader())
	if err != nil {
		return err
	}
	for _, p := range plans {
		if len(p.DeliveriesToNudge(nowMs)) == 0 {
			continue
		}
		nudged := false
		err := s.Store.Writer.Tx(ctx, func(ctx context.Context, tx *pdb.Tx) error {
			d := tx.DBTX()
			p, err := plan.Get(ctx, d, p.Agent, p.Conversation) // again, inside the one writer: two sweeps never ask twice
			if err != nil {
				return ignoreNotFound(err)
			}
			due := p.DeliveriesToNudge(nowMs)
			if len(due) == 0 {
				return nil
			}
			if member, err := isMember(ctx, d, p.Conversation, p.Agent); err != nil || !member {
				return err
			}
			// An unacked ask about the plan keeps its own text, so the delivery waits unmarked and is asked once that ask is acked.
			if open, err := inbox.HasStatusDue(ctx, d, p.Agent, p.Conversation); err != nil || open {
				return err
			}
			if err := plan.MarkNudged(ctx, d, p, due); err != nil {
				return err
			}
			seq, err := event.Write(ctx, d, now, event.Entry{Type: eventDeliveryNudged, Audience: p.Agent, Conversation: p.Conversation,
				Payload: map[string]any{"conversation_id": p.Conversation}})
			if err != nil {
				return err
			}
			nudged = true
			return inbox.StatusDue(ctx, d, now, p.Agent, p.Conversation, seq)
		})
		if err != nil {
			return err
		}
		if nudged {
			s.Bus.Notify(p.Agent)
		}
	}
	return nil
}

func ignoreNotFound(err error) error {
	if errors.Is(err, plan.ErrNotFound) {
		return nil
	}
	return err
}

// deliveryNudge is the text of the ask about a late deliverable: done, a new date, or blocked, each with its command.
func deliveryNudge(conv int64, dv plan.Deliverable) string {
	c := strconv.FormatInt(conv, 10)
	q := strconv.Quote(dv.Text)
	return "Your delivery " + q + " in conversation " + c + " was due " + time.UnixMilli(dv.Due).UTC().Format(time.RFC3339) +
		": done, new date, or blocked? Done: convoz plan " + c + " --done " + q + ". New date: convoz plan " + c + " --deliver " + q +
		" --due 18:00. Blocked: convoz plan " + c + " --blocked \"…\"."
}
