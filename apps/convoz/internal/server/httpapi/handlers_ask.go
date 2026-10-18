package httpapi

import (
	"context"
	"errors"
	"net/http"
	"time"
	_ "time/tzdata" // Tonight and Tomorrow are read in the person's zone, and a bare container has no zone files

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/appkit"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/ask"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/auth"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/authz"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/conversation"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

// answeredWindow is how far back "answered today" reaches.
const answeredWindow = 24 * time.Hour

// personOf is the person whose snoozes a caller sees: the human behind a device session, 0 for an agent.
func personOf(c *call) int64 {
	if c.p.SessionID != 0 {
		return 0
	}
	return c.p.HumanID
}

// postAsk is POST /api/asks: an agent asks a question with a recommendation and alternatives. The asker is the lease (I-40).
func (s *Server) postAsk(w http.ResponseWriter, r *http.Request, c *call) {
	if c.p.SessionID == 0 {
		writeErr(w, http.StatusForbidden, "forbidden", "Only an agent asks.")
		return
	}
	var in wire.AskRequest
	if !decode(w, r, &in) {
		return
	}
	switch {
	case !wire.ValidClientID(in.ClientID):
		writeFieldErr(w, http.StatusBadRequest, "invalid_request", "client_id", "The client id must be 8 to 64 characters without spaces.")
		return
	case in.ConversationID <= 0:
		writeFieldErr(w, http.StatusBadRequest, "invalid_request", "conversation_id", "Name the conversation.")
		return
	}
	n := ask.New{
		Conversation: in.ConversationID, ThreadRoot: in.ThreadRootID, Asker: c.p.IdentityID, Session: c.p.SessionID,
		OriginLabel: c.lease.Label, OriginMachine: c.lease.Machine, ClientID: in.ClientID, Question: in.Question,
		Recommended: ask.Option{Label: in.Recommended.Label, Why: in.Recommended.Why}, Urgent: in.Urgent,
	}
	for _, o := range in.Alternatives {
		n.Alternatives = append(n.Alternatives, ask.Option{Label: o.Label, Why: o.Why})
	}
	if s.askRefused(w, r, c, n.Check()) {
		return
	}
	if len(in.App) > 0 && string(in.App) != "null" {
		checked, err := appkit.Check(r.Context(), s.reader(), uploadFiles{}, n.Asker, in.App)
		if err == nil {
			err = onAsk(checked)
		}
		if appRefused(w, err) {
			return
		}
		if err != nil {
			s.internalError(w, r, err)
			return
		}
		n.App = checked.Canonical()
	}
	// The cap comes before the budgets, so a full agent is told so and not "slow down".
	open, err := ask.OpenCount(r.Context(), s.reader(), n.Asker)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	if open >= ask.MaxOpenPerAsker {
		s.askRefused(w, r, c, ask.ErrCap)
		return
	}
	now := s.Clock.Now()
	if !s.withinBudgets(w, c, now) {
		return
	}
	status, replayed := http.StatusCreated, false
	done := s.askChange(w, r, c, &status, func(ctx context.Context, d pdb.DBTX, p ask.Ports, now time.Time) (ask.Ask, error) {
		a, again, err := ask.Create(ctx, d, p, now, n)
		if again {
			replayed, status = true, http.StatusOK
		}
		return a, err
	})
	if done && !replayed {
		s.countDailyPost(c, now)
		s.publishWorking(r.Context(), n.Asker, n.Conversation, false, 0)
	}
}

// askVisible loads the ask of the path and checks the caller may see its conversation (I-6). It writes the refusal itself.
func (s *Server) askVisible(w http.ResponseWriter, r *http.Request, c *call) (ask.Ask, bool) {
	id, ok := pathID(w, r)
	if !ok {
		return ask.Ask{}, false
	}
	ctx, d := r.Context(), s.reader()
	a, err := ask.Get(ctx, d, id)
	var floor int64
	var visible bool
	if err == nil {
		floor, visible, err = canSee(ctx, d, c.p, a.ConversationID)
	}
	switch {
	case s.askRefused(w, r, c, err):
		return ask.Ask{}, false
	case !visible || a.ID <= floor:
		notVisible(w, c)
		return ask.Ask{}, false
	}
	return a, true
}

// getAsk is GET /api/asks/:id: the ask, its options, its state and its history.
func (s *Server) getAsk(w http.ResponseWriter, r *http.Request, c *call) {
	a, ok := s.askVisible(w, r, c)
	if !ok {
		return
	}
	s.writeAsk(w, r, c, http.StatusOK, a)
}

// writeAsk answers {ask} for the caller.
func (s *Server) writeAsk(w http.ResponseWriter, r *http.Request, c *call, status int, a ask.Ask) {
	ctx, d := r.Context(), s.reader()
	dir, err := loadDirectory(ctx, d)
	var v wire.AskView
	if err == nil {
		v, err = s.oneAskView(ctx, d, dir, a, personOf(c), s.Clock.Now())
	}
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, status, wire.OneAsk{Ask: v})
}

// askChange runs one change of an ask in one transaction and answers {ask}; a refusal is answered by askRefused. It wakes
// the inbox long polls the change reached after the commit, and reports whether it changed nothing it could not undo (the
// answer was written).
func (s *Server) askChange(w http.ResponseWriter, r *http.Request, c *call, status *int, do func(ctx context.Context, d pdb.DBTX, p ask.Ports, now time.Time) (ask.Ask, error)) bool {
	fx, now := &askEffects{}, s.Clock.Now()
	var a ask.Ask
	err := s.Store.Writer.Tx(r.Context(), func(ctx context.Context, tx *pdb.Tx) (err error) {
		a, err = do(ctx, tx.DBTX(), askPorts(c.p, fx), now)
		return err
	})
	if s.askRefused(w, r, c, err) {
		return false
	}
	s.Bus.Notify(fx.wake...)
	s.writeAsk(w, r, c, *status, a)
	return true
}

// askAnswer is POST /api/asks/:id/answer: a person answers with the recommended option, an alternative or their own words.
func (s *Server) askAnswer(w http.ResponseWriter, r *http.Request, c *call) {
	var in wire.AskAnswerRequest
	if !decode(w, r, &in) {
		return
	}
	a, ok := s.askVisible(w, r, c)
	if !ok {
		return
	}
	status := http.StatusOK
	s.askChange(w, r, c, &status, func(ctx context.Context, d pdb.DBTX, p ask.Ports, now time.Time) (ask.Ask, error) {
		got, _, err := ask.Answer(ctx, d, p, now, ask.Answering{
			ID: a.ID, By: c.p.HumanID, Device: c.dev.ID, Choice: ask.Choice{Kind: in.Choice, Index: in.Index, Text: in.Text}, IfVersion: in.IfVersion, Via: in.Via,
		})
		return got, err
	})
}

// askDismiss is POST /api/asks/:id/dismiss.
func (s *Server) askDismiss(w http.ResponseWriter, r *http.Request, c *call) {
	var in wire.AskMarkRequest
	if !decode(w, r, &in) {
		return
	}
	a, ok := s.askVisible(w, r, c)
	if !ok {
		return
	}
	status := http.StatusOK
	s.askChange(w, r, c, &status, func(ctx context.Context, d pdb.DBTX, p ask.Ports, now time.Time) (ask.Ask, error) {
		got, _, err := ask.Dismiss(ctx, d, p, now, a.ID, c.p.HumanID, in.IfVersion)
		return got, err
	})
}

// askUndismiss is POST /api/asks/:id/undismiss.
func (s *Server) askUndismiss(w http.ResponseWriter, r *http.Request, c *call) {
	var in wire.AskMarkRequest
	if !decode(w, r, &in) {
		return
	}
	a, ok := s.askVisible(w, r, c)
	if !ok {
		return
	}
	status := http.StatusOK
	s.askChange(w, r, c, &status, func(ctx context.Context, d pdb.DBTX, p ask.Ports, now time.Time) (ask.Ask, error) {
		return ask.Undismiss(ctx, d, p, now, a.ID, c.p.HumanID, in.IfVersion)
	})
}

// askWithdraw is POST /api/asks/:id/withdraw: the asking agent takes its ask back.
func (s *Server) askWithdraw(w http.ResponseWriter, r *http.Request, c *call) {
	if c.p.SessionID == 0 {
		writeErr(w, http.StatusForbidden, "forbidden", "Only the asking agent withdraws an ask.")
		return
	}
	var in wire.AskMarkRequest
	if !decode(w, r, &in) {
		return
	}
	a, ok := s.askVisible(w, r, c)
	if !ok {
		return
	}
	status := http.StatusOK
	s.askChange(w, r, c, &status, func(ctx context.Context, d pdb.DBTX, p ask.Ports, now time.Time) (ask.Ask, error) {
		return ask.Withdraw(ctx, d, p, now, a.ID, c.p.IdentityID)
	})
}

// askSnooze is PUT /api/asks/:id/snooze: hide an open ask from the caller until a time. A preset is read in the zone `tz`.
func (s *Server) askSnooze(w http.ResponseWriter, r *http.Request, c *call) {
	var in wire.AskSnoozeRequest
	if !decode(w, r, &in) {
		return
	}
	a, ok := s.askVisible(w, r, c)
	if !ok {
		return
	}
	now := s.Clock.Now()
	var until time.Time
	switch {
	case (in.Preset == "") == (in.Until == 0):
		writeFieldErr(w, http.StatusBadRequest, "invalid_request", "preset", "Send a preset or an exact time (until).")
		return
	case in.Preset != "":
		loc := time.UTC
		if in.TZ != "" {
			var err error
			if loc, err = time.LoadLocation(in.TZ); err != nil {
				writeFieldErr(w, http.StatusBadRequest, "invalid_request", "tz", "That is not a time zone name.")
				return
			}
		}
		var err error
		if until, err = ask.PresetTime(in.Preset, now, loc); s.askRefused(w, r, c, err) {
			return
		}
	default:
		until = time.UnixMilli(in.Until)
	}
	status := http.StatusOK
	s.askChange(w, r, c, &status, func(ctx context.Context, d pdb.DBTX, p ask.Ports, now time.Time) (ask.Ask, error) {
		return ask.Snooze(ctx, d, p, now, c.p.HumanID, a.ID, until)
	})
}

// askUnsnooze is DELETE /api/asks/:id/snooze: the ask is back in Now at once.
func (s *Server) askUnsnooze(w http.ResponseWriter, r *http.Request, c *call) {
	a, ok := s.askVisible(w, r, c)
	if !ok {
		return
	}
	status := http.StatusOK
	s.askChange(w, r, c, &status, func(ctx context.Context, d pdb.DBTX, p ask.Ports, now time.Time) (ask.Ask, error) {
		return ask.Unsnooze(ctx, d, p, now, c.p.HumanID, a.ID)
	})
}

// askRefused answers an error of the ask module (or of the messages it writes) and reports whether there was one.
func (s *Server) askRefused(w http.ResponseWriter, r *http.Request, c *call, err error) bool {
	var field *ask.FieldError
	var conflict *ask.Conflict
	switch {
	case err == nil:
		return false
	case errors.As(err, &field):
		writeFieldErr(w, http.StatusBadRequest, "invalid_request", field.Field, field.Message)
	case errors.As(err, &conflict):
		s.writeConflict(w, r, c, conflict)
	case errors.Is(err, ask.ErrNotFound):
		writeErr(w, http.StatusNotFound, "not_found", "No such ask.")
	case errors.Is(err, ask.ErrNotAsker):
		writeErr(w, http.StatusForbidden, "forbidden", "Only the asking agent may do that.")
	case errors.Is(err, ask.ErrCap):
		writeErr(w, http.StatusTooManyRequests, "ask_cap", "An agent holds at most 20 open asks. Wait for answers.")
	case errors.Is(err, ask.ErrPresetGone):
		writeFieldErr(w, http.StatusBadRequest, "preset_unavailable", "preset", "Tonight is over. Pick 1 hour or Tomorrow.")
	default:
		if s.messageRefused(w, err) {
			return true
		}
		s.internalError(w, r, err)
	}
	return true
}

// conflictWords says in words why a change of an ask was refused.
var conflictWords = map[string]string{
	ask.CodeConflict:  "Another change came first. This is how the ask stands.",
	ask.CodeNotOpen:   "Only an open ask can be snoozed.",
	ask.CodeAskerGone: "The agent that asked is no longer in this conversation.",
	ask.CodeAskCap:    "The agent already has 20 open asks.",
}

// writeConflict answers 409 with the code and the ask as it stands, so a screen can show what won.
func (s *Server) writeConflict(w http.ResponseWriter, r *http.Request, c *call, cf *ask.Conflict) {
	ctx, d := r.Context(), s.reader()
	dir, err := loadDirectory(ctx, d)
	var v wire.AskView
	if err == nil {
		v, err = s.oneAskView(ctx, d, dir, cf.Ask, personOf(c), s.Clock.Now())
	}
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusConflict, wire.AskConflict{Error: wire.ErrorDetail{Code: cf.Code, Message: conflictWords[cf.Code]}, Ask: v})
}

// nowScreen is GET /api/now: what waits for the owner. Open asks that are not snoozed (urgent first, then the newest), the
// owner's snoozed ones, the ones answered or dismissed in the last day, the adds agents wait on, and the machines waiting to connect.
func (s *Server) nowScreen(w http.ResponseWriter, r *http.Request, c *call) {
	ctx, d := r.Context(), s.reader()
	if err := s.wakeSnoozes(ctx); err != nil {
		s.Log.Printf("snooze wake: %v", err)
	}
	now := s.Clock.Now()
	waiting, err := ask.ForNow(ctx, d, c.p.HumanID, now, now.Add(-answeredWindow).UnixMilli())
	var dir directory
	if err == nil {
		dir, err = loadDirectory(ctx, d)
	}
	out := nowView{Now: now.UnixMilli(), PollMS: s.interval().Milliseconds()}
	if err == nil {
		out.Asks, err = liveAskViews(ctx, d, dir, waiting.Open, nil)
	}
	if err == nil {
		out.Snoozed, err = liveAskViews(ctx, d, dir, waiting.Snoozed, waiting.Until)
	}
	if err == nil {
		out.AnsweredToday, err = liveAskViews(ctx, d, dir, waiting.Answered, nil)
	}
	if err == nil {
		out.DismissedToday, err = liveAskViews(ctx, d, dir, waiting.Dismissed, nil)
	}
	if err == nil {
		out.PendingAdds, err = pendingAdds(ctx, d, dir)
	}
	var machines []auth.Request
	if err == nil {
		machines, err = auth.PendingRequests(ctx, d, now)
	}
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	out.Badge = len(out.Asks)
	out.MachineRequests = requestsJSON(machines)
	writeJSON(w, http.StatusOK, out)
}

// nowView is the answer of GET /api/now.
type nowView struct {
	Now             int64                `json:"now"`
	PollMS          int64                `json:"poll_ms"`
	Badge           int                  `json:"badge"`
	Asks            []wire.AskView       `json:"asks"`
	Snoozed         []wire.AskView       `json:"snoozed"`
	AnsweredToday   []wire.AskView       `json:"answered_today"`
	DismissedToday  []wire.AskView       `json:"dismissed_today"`
	PendingAdds     []wire.NowPendingAdd `json:"pending_adds"`
	MachineRequests []requestJSON        `json:"machine_requests"`
}

// liveAskViews is askViews without the asks of a conversation that is in the trash or gone.
func liveAskViews(ctx context.Context, d pdb.DBTX, dir directory, list []ask.Ask, snoozed map[int64]int64) ([]wire.AskView, error) {
	live := make([]ask.Ask, 0, len(list))
	for _, a := range list {
		if _, found, err := conversation.Get(ctx, d, a.ConversationID); err != nil {
			return nil, err
		} else if found {
			live = append(live, a)
		}
	}
	return askViews(ctx, d, dir, live, snoozed)
}

// pendingAdds lists the adds agents wait on, in the conversations that are not in the trash.
func pendingAdds(ctx context.Context, d pdb.DBTX, dir directory) ([]wire.NowPendingAdd, error) {
	list, err := conversation.AllPending(ctx, d)
	out := make([]wire.NowPendingAdd, 0, len(list))
	for _, p := range list {
		cv, found, err2 := conversation.Get(ctx, d, p.Conversation)
		if err2 != nil {
			return nil, err2
		}
		if !found {
			continue
		}
		add := wire.NowPendingAdd{Conversation: wire.AskConversation{ID: cv.ID}, Person: dir.person(p.IdentityID), At: p.At}
		if cv.Title != "" {
			add.Conversation.Title = ptr(cv.Title)
		}
		if p.RequestedBy != 0 {
			add.RequestedBy = ptr(dir.person(p.RequestedBy))
		}
		out = append(out, add)
	}
	return out, err
}

// wakeSnoozes marks the snoozes whose time has come, writing their event and notification. It writes only when one is due.
func (s *Server) wakeSnoozes(ctx context.Context) error {
	now := s.Clock.Now()
	due, err := ask.Due(ctx, s.reader(), now)
	if err != nil || !due {
		return err
	}
	var woke int
	err = s.Store.Writer.Tx(ctx, func(ctx context.Context, tx *pdb.Tx) (err error) {
		ports := askPorts(authz.Principal{}, &askEffects{})
		ports.Notify = pushWake{s} // the wake and its push commit together
		woke, err = ask.WakeDue(ctx, tx.DBTX(), ports, now)
		return err
	})
	if err == nil && woke > 0 {
		s.Bus.Notify()
	}
	return err
}

// snoozeCheckEvery is how often the server looks for snoozes that came due when nobody has Now open.
const snoozeCheckEvery = 10 * time.Second

// RunTimers runs the jobs that follow the clock, until ctx ends: waking the snoozes whose time has come.
func (s *Server) RunTimers(ctx context.Context) {
	if s.Push != nil {
		go s.Push.Run(ctx, s.Bus.Changed) // the push worker: events in, pushes out
	}
	tick := time.NewTicker(snoozeCheckEvery)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
			if err := s.wakeSnoozes(ctx); err != nil && ctx.Err() == nil {
				s.Log.Printf("snooze wake: %v", err)
			}
		}
	}
}
