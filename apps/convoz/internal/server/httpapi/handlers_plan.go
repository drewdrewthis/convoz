package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/ask"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/auth"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/conversation"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/event"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/identity"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/inbox"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/message"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/plan"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

// The versioned names of the events of the plan work. plan.changed carries counts only (I-23); the stream reads the plan again.
const (
	eventPlanChanged = "plan.changed.v1"
	eventPlanNudged  = "plan.nudged.v1"
)

// putPlan is PUT /api/conversations/:id/plan: the agent replaces its whole plan for the conversation at once, so the owner never sees
// half of an update. Status follows it: a plan with a Doing sets the agent's status to working on that item (Crew keeps agreeing with
// the conversation). A finished item, or something new that waits on the owner, also writes one quiet system line.
func (s *Server) putPlan(w http.ResponseWriter, r *http.Request, c *call) {
	conv, ok := pathID(w, r)
	if !ok {
		return
	}
	var in wire.PlanRequest
	if !decode(w, r, &in) {
		return
	}
	now, ctx, who := s.Clock.Now(), r.Context(), c.p.Identity()
	owner, err := identity.Owner(ctx, s.reader())
	if err != nil && !errors.Is(err, identity.ErrNotFound) {
		s.internalError(w, r, err)
		return
	}
	pi, field, why := parsePlan(in, now, owner.Handle, owner.DisplayName)
	if field != "" {
		writeFieldErr(w, http.StatusBadRequest, "invalid_request", field, why)
		return
	}
	if _, visible, err := canSee(ctx, s.reader(), c.p, conv); err != nil {
		s.internalError(w, r, err)
		return
	} else if !visible {
		notVisible(w, c)
		return
	}
	if key := strconv.FormatInt(who, 10); !s.statusLimit.Allow(key, now) {
		tooMany(w, s.statusLimit.RetryAfter(key, now), "Too many plan and status updates. Slow down.")
		return
	}
	var stored plan.Plan
	err = s.Store.Writer.Tx(ctx, func(ctx context.Context, tx *pdb.Tx) error {
		d := tx.DBTX()
		p, ch, err := plan.Replace(ctx, d, now, who, conv, pi)
		if err != nil {
			return err
		}
		stored = p
		if ch.Repeat {
			return nil
		}
		if len(p.Now) > 0 {
			next := ""
			if len(p.Next) > 0 {
				next = p.Next[0]
			}
			if _, err := identity.SetStatus(ctx, d, now, who, "working", p.Now[0].Text, next); err != nil {
				return err
			}
			if _, err := event.Write(ctx, d, now, event.Entry{Type: eventStatusChanged, Actor: who, Session: c.p.SessionID, Payload: map[string]any{"state": "working"}}); err != nil {
				return err
			}
		}
		_, err = event.Write(ctx, d, now, event.Entry{Type: eventPlanChanged, Actor: who, Session: c.p.SessionID, Conversation: conv,
			Payload: map[string]any{"conversation_id": conv, "new_waiting": len(ch.NewWaiting), "done": len(ch.Done)}})
		if err != nil || ch.Quiet() {
			return err
		}
		line := message.SystemLine{T: "plan.changed", Identity: who, Done: quote(ch.Done), Waiting: quote(ch.NewWaiting)}
		line.Now = quote(nowTexts(p))
		line.Next = quote(p.Next)
		_, _, err = sayLine(ctx, d, now, who, conv, line)
		return err
	})
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	s.Bus.Notify()
	dir, err := loadDirectory(ctx, s.reader())
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, planView(dir, stored))
}

// parsePlan checks a plan request and reads the step and estimate of each Now item; field names what is wrong ("" when it is fine).
// handle and displayName are the owner's: a Waiting item may carry their label, never someone else's (plan.OwnWaiting).
func parsePlan(in wire.PlanRequest, now time.Time, handle, displayName string) (pi plan.Input, field, why string) {
	items := in.Now
	if len(items) > 0 && (in.Doing != "" || in.Step != "" || in.ETA != "") {
		return pi, "now", "give now, or doing with step and eta, not both"
	}
	if len(items) == 0 && in.Doing != "" {
		items = []wire.PlanNowRequest{{Text: in.Doing, Step: in.Step, ETA: in.ETA}}
	}
	texts := make([]string, len(items))
	for i, it := range items {
		texts[i] = it.Text
	}
	if f, msg, ok := plan.Check(texts, in.Blocked, in.Next, in.Waiting, in.Done); !ok {
		return pi, f, msg
	}
	if len(items) == 0 && (in.Step != "" || in.ETA != "") {
		return pi, "doing", "step and eta belong to doing"
	}
	for _, it := range items {
		step, ok := plan.ParseStep(it.Step)
		if !ok {
			return pi, "step", "step is N/M, with 1 <= N <= M <= 99"
		}
		eta, ok := plan.ParseETA(it.ETA, in.UTCOffset, now)
		if !ok {
			return pi, "eta", "eta is a duration up to 7 days (30m, 1h30m) or a time HH:MM"
		}
		pi.Now = append(pi.Now, plan.Item{Text: it.Text, Step: step, ETA: eta})
	}
	if len(in.ClientID) > 64 {
		return pi, "client_id", "client_id is at most 64 characters"
	}
	waiting, why := plan.OwnWaiting(in.Waiting, handle, displayName)
	if why != "" {
		return pi, "waiting", why
	}
	pi.Blocked, pi.Next, pi.Waiting, pi.Done, pi.ClientID = in.Blocked, in.Next, waiting, in.Done, in.ClientID
	return pi, "", ""
}

// nowTexts is the text of each Now item.
func nowTexts(p plan.Plan) []string {
	out := make([]string, len(p.Now))
	for i, it := range p.Now {
		out[i] = it.Text
	}
	return out
}

// quote joins the items a system line quotes and keeps the line under its limit.
func quote(items []string) string {
	t := strings.Join(items, ", ")
	if utf8.RuneCountInString(t) <= message.MaxItemRunes {
		return t
	}
	return string([]rune(t)[:message.MaxItemRunes-1]) + "…"
}

func planView(dir directory, p plan.Plan) wire.Plan {
	v := wire.Plan{ConversationID: p.Conversation, IdentityID: p.Agent, Handle: dir[p.Agent].Handle, Blocked: p.Blocked, Now: []wire.PlanNow{},
		Next: append([]string{}, p.Next...), Waiting: []wire.PlanWaiting{}, Done: []wire.PlanDone{}, UpdatedAt: p.UpdatedAt, DueAt: p.DueAt()}
	if p.Nudges > 0 {
		v.NudgedAt = p.NudgedAt
	}
	for _, it := range p.Now {
		n := wire.PlanNow{Text: it.Text, Since: it.Since, ETA: it.ETA}
		if it.Step != nil {
			n.Step = &wire.PlanStep{At: it.Step.At, Of: it.Step.Of}
		}
		v.Now = append(v.Now, n)
	}
	if len(v.Now) > 0 { // the first item, for readers from before parallel items
		f := v.Now[0]
		v.Doing, v.DoingSince, v.Step, v.ETA = f.Text, f.Since, f.Step, f.ETA
	}
	for _, x := range p.Waiting {
		v.Waiting = append(v.Waiting, wire.PlanWaiting{Text: x.Text, Since: x.Since})
	}
	for _, x := range p.Done {
		v.Done = append(v.Done, wire.PlanDone{Text: x.Text, At: x.At})
	}
	return v
}

// getPlans is GET /api/plans[?conversation=C]: the plans, agents and lines of the conversations the caller may see (of one, with C).
func (s *Server) getPlans(w http.ResponseWriter, r *http.Request, c *call) {
	conv := int64(0)
	if raw := r.URL.Query().Get("conversation"); raw != "" {
		id, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || id <= 0 {
			writeFieldErr(w, http.StatusBadRequest, "invalid_request", "conversation", "conversation is a conversation id.")
			return
		}
		if _, visible, err := canSee(r.Context(), s.reader(), c.p, id); err != nil {
			s.internalError(w, r, err)
			return
		} else if !visible {
			notVisible(w, c)
			return
		}
		conv = id
	}
	b, err := s.board(r.Context(), c, conv)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, b)
}

// board reads everything the lines need and lets the plan module rank it.
func (s *Server) board(ctx context.Context, c *call, conv int64) (wire.PlanBoard, error) {
	d, now := s.reader(), s.Clock.Now()
	nowMs := now.UnixMilli()
	out := wire.PlanBoard{Now: nowMs, Plans: []wire.Plan{}, Agents: []wire.PlanAgent{}, Asks: []wire.OpenAsk{}, Attention: []wire.PlanAttention{}}
	dir, err := loadDirectory(ctx, d)
	if err != nil {
		return out, err
	}
	seen := map[int64]bool{}
	inScope := func(id int64) (bool, error) {
		if conv != 0 {
			return id == conv, nil
		}
		if ok, known := seen[id]; known {
			return ok, nil
		}
		_, ok, err := canSee(ctx, d, c.p, id)
		seen[id] = ok
		return ok, err
	}
	var plans []plan.Plan
	if conv != 0 {
		plans, err = plan.OfConversation(ctx, d, conv)
	} else {
		plans, err = plan.All(ctx, d)
	}
	if err != nil {
		return out, err
	}
	var agentIDs []int64
	addAgent := func(id int64) {
		if dir[id].Kind == "agent" && !slices.Contains(agentIDs, id) {
			agentIDs = append(agentIDs, id)
		}
	}
	var kept []plan.Plan
	for _, p := range plans {
		if ok, err := inScope(p.Conversation); err != nil {
			return out, err
		} else if ok {
			kept = append(kept, p)
			addAgent(p.Agent)
		}
	}
	if conv != 0 {
		parts, err := conversation.Participants(ctx, d, conv)
		if err != nil {
			return out, err
		}
		for _, pt := range parts {
			addAgent(pt.IdentityID)
		}
	}
	waiting, err := inbox.Unanswered(ctx, d)
	if err != nil {
		return out, err
	}
	unanswered := map[int64]map[int64]int64{}
	oldest := map[int64]int64{}
	for _, u := range waiting {
		if o := oldest[u.Identity]; o == 0 || u.Since < o {
			oldest[u.Identity] = u.Since
		}
		if ok, err := inScope(u.Conversation); err != nil {
			return out, err
		} else if ok {
			if unanswered[u.Identity] == nil {
				unanswered[u.Identity] = map[int64]int64{}
			}
			unanswered[u.Identity][u.Conversation] = u.Since
			addAgent(u.Identity)
		}
	}
	statuses, err := identity.Statuses(ctx, d)
	if err != nil {
		return out, err
	}
	facts := map[int64]plan.Agent{}
	var asks []plan.Ask
	slices.Sort(agentIDs)
	for _, id := range agentIDs {
		live, err := auth.LiveSessionCount(ctx, d, id, now)
		if err != nil {
			return out, err
		}
		last, err := auth.LastSeen(ctx, d, id)
		if err != nil {
			return out, err
		}
		st, ok := statuses[id]
		if !ok {
			st = identity.Idle()
		}
		lv := plan.Liveness(oldest[id], s.watching.connected(id, nowMs), live > 0, nowMs)
		facts[id] = plan.Agent{ID: id, Handle: dir[id].Handle, StatusUpdatedAt: st.UpdatedAt, Liveness: lv, LastSeenAt: last, Unanswered: unanswered[id]}
		pa := wire.PlanAgent{IdentityID: id, Handle: dir[id].Handle, State: st.State, Doing: st.Doing, Online: live > 0, LastSeenAt: last, Liveness: lv}
		for _, since := range unanswered[id] {
			if pa.UnansweredSince == 0 || since < pa.UnansweredSince {
				pa.UnansweredSince = since
			}
		}
		out.Agents = append(out.Agents, pa)
		if c.p.Role != "owner" {
			continue
		}
		open, err := ask.OpenOf(ctx, d, now, id, maxOpenAsksShown)
		if err != nil {
			return out, err
		}
		for _, a := range open {
			if ok, err := inScope(a.ConversationID); err != nil {
				return out, err
			} else if ok {
				asks = append(asks, plan.Ask{Conversation: a.ConversationID, Agent: id, Question: a.Question})
				out.Asks = append(out.Asks, wire.OpenAsk{ID: a.ID, ConversationID: a.ConversationID, Question: a.Question, Urgent: a.Urgent})
			}
		}
	}
	for _, p := range kept {
		out.Plans = append(out.Plans, planView(dir, p))
	}
	lines, next := plan.Attend(nowMs, kept, facts, asks)
	for _, a := range lines {
		out.Attention = append(out.Attention, wire.PlanAttention{ConversationID: a.Conversation, State: a.State, Handle: dir[a.Agent].Handle, Text: a.Text, ETA: a.ETA, More: a.More, LastSeenAt: a.LastSeenAt})
	}
	out.NextChangeAt = next
	return out, nil
}

// planFrame is the data of a "plan.changed" frame: which conversation to read again.
func planFrame(conv int64) []byte {
	data, _ := json.Marshal(map[string]any{"conversation_id": conv})
	return data
}
