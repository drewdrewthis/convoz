package httpapi

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"regexp"
	"slices"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/ask"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/auth"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/conversation"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/event"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/identity"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/message"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/notify"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/plan"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/prefs"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/readstate"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/settings"
)

// Event names the push pipeline reads that no other file of this package names.
const (
	eventMachineRequested = "machine.requested.v1"
	eventKeyRevealed      = "machine.key_revealed.v1"
	eventRecoveryUsed     = "recovery.used.v1"
	eventMessageCreated   = "message.created.v1"
)

// pushSource is the push pipeline's view of the other modules (notify.Source): which events notify the owner, what the owner's
// settings and the data say about each, and what a push shows.
type pushSource struct{ s *Server }

func (pushSource) Events(ctx context.Context, d pdb.DBTX, after int64, max int) ([]notify.Event, int64, error) {
	list, err := event.Since(ctx, d, after, max)
	if err != nil {
		return nil, 0, err
	}
	newest, err := event.MaxSeq(ctx, d)
	out := make([]notify.Event, len(list))
	for i, e := range list {
		out[i] = notify.Event{Seq: e.Seq, Actor: e.Actor, Conversation: e.Conversation, Message: e.Message, CreatedAt: e.CreatedAt, Type: e.Type, Payload: e.Payload}
	}
	return out, newest, err
}

// eventBody is the part of an event payload the pipeline reads.
type eventBody struct {
	ID             int64  `json:"id"`
	Kind           string `json:"kind"`
	Urgent         bool   `json:"urgent"`
	Status         string `json:"status"`
	IdentityID     int64  `json:"identity_id"`
	RequestID      int64  `json:"request_id"`
	ViaInternet    bool   `json:"via_internet"`
	DeviceID       int64  `json:"device_id"`
	MachineID      int64  `json:"machine_id"`
	ConversationID int64  `json:"conversation_id"`
	NewWaiting     int    `json:"new_waiting"`
}

func bodyOf(e notify.Event) eventBody {
	var b eventBody
	_ = json.Unmarshal([]byte(e.Payload), &b) // a payload that does not parse notifies nobody
	return b
}

// Triggers turns one event into the notification it causes for the owner. Most events cause none.
func (p pushSource) Triggers(ctx context.Context, d pdb.DBTX, e notify.Event) ([]notify.Trigger, error) {
	owner, err := identity.Owner(ctx, d)
	if errors.Is(err, identity.ErrNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	t := notify.Trigger{Person: owner.ID, SourceSeq: e.Seq, Conversation: e.Conversation, Message: e.Message}
	body := bodyOf(e)
	byOwner := e.Actor == owner.ID
	switch e.Type {
	case ask.EventCreated, ask.EventUpdated: // an updated ask pushes like a new one: the owner asked questions and waits for the answers
		if byOwner {
			return nil, nil
		}
		t.Reason, t.Urgent, t.TopicKind, t.TopicID = notify.ReasonAsk, body.Urgent, notify.TopicAsk, e.Message
		if body.Urgent {
			t.Reason = notify.ReasonAskUrgent
		}
	case eventMessageCreated:
		if byOwner || body.Kind != "text" {
			return nil, nil
		}
		return p.messageTriggers(ctx, d, t, e)
	case eventParticipantChanged:
		if byOwner || body.Status != "pending" {
			return nil, nil
		}
		t.Reason, t.TopicKind, t.TopicID, t.Message = notify.ReasonAgentAdd, notify.TopicConversation, e.Conversation, 0
	case eventMachineRequested:
		t.Reason, t.TopicKind, t.TopicID, t.Conversation = notify.ReasonMachineRequest, notify.TopicMachine, body.RequestID, 0
		t.Remote = body.ViaInternet
	case eventKeyRevealed:
		t.Reason, t.TopicKind, t.TopicID, t.Conversation, t.ExceptDevice = notify.ReasonSecurity, notify.TopicSecurity, e.Seq, 0, body.DeviceID
	case eventRecoveryUsed:
		t.Reason, t.TopicKind, t.TopicID, t.Conversation = notify.ReasonSecurity, notify.TopicSecurity, e.Seq, 0
	case eventPlanChanged:
		// Only something new that waits on the owner pushes: a finished item or a moved estimate is a quiet line or nothing.
		if byOwner || body.NewWaiting == 0 {
			return nil, nil
		}
		t.Reason, t.TopicKind, t.TopicID, t.Message = notify.ReasonPlanWaiting, notify.TopicConversation, e.Conversation, 0
	default:
		return nil, nil
	}
	return []notify.Trigger{t}, nil
}

// messageTriggers: a text message notifies the owner when it mentions them (reason mention), or when it replies in a thread they
// are in (thread_reply). A message of the main list that does not mention the owner is activity, not a push.
func (pushSource) messageTriggers(ctx context.Context, d pdb.DBTX, t notify.Trigger, e notify.Event) ([]notify.Trigger, error) {
	id := e.Message
	if id == 0 {
		id = bodyOf(e).ID
	}
	m, found, err := message.Get(ctx, d, id)
	if err != nil || !found {
		return nil, err
	}
	t.Message, t.Conversation = m.ID, m.ConversationID
	mentioned, err := message.Mentioned(ctx, d, m.ID)
	if err != nil {
		return nil, err
	}
	if slices.Contains(mentioned, t.Person) {
		t.Reason, t.TopicKind, t.TopicID = notify.ReasonMention, notify.TopicConversation, m.ConversationID
		return []notify.Trigger{t}, nil
	}
	if m.ThreadRootID == 0 {
		return nil, nil
	}
	threads, err := readstate.Threads(ctx, d, t.Person, m.ConversationID)
	if err != nil {
		return nil, err
	}
	if !slices.ContainsFunc(threads, func(p readstate.ThreadPos) bool { return p.Root == m.ThreadRootID }) {
		return nil, nil
	}
	t.Reason, t.TopicKind, t.TopicID = notify.ReasonThreadReply, notify.TopicThread, m.ThreadRootID
	return []notify.Trigger{t}, nil
}

// settingsOf reads the person's settings by key.
func settingsOf(ctx context.Context, d pdb.DBTX, person int64) (map[string]any, error) {
	all, err := settings.All(ctx, d, person)
	out := make(map[string]any, len(all))
	for _, e := range all {
		out[e.Key] = e.Value
	}
	return out, err
}

func flag(m map[string]any, key string) bool { b, _ := m[key].(bool); return b }

// enabled says whether the person's setting lets this kind of notification through (design §10.1 defaults).
func enabled(t notify.Trigger, st map[string]any) bool {
	asks, _ := st["notify.asks"].(string)
	switch t.Reason {
	case notify.ReasonAsk:
		return asks == "all"
	case notify.ReasonAskUrgent, notify.ReasonSnoozeWake, notify.ReasonPlanWaiting:
		return asks != "none"
	case notify.ReasonMention:
		return flag(st, "notify.mentions")
	case notify.ReasonThreadReply:
		return flag(st, "notify.threads")
	case notify.ReasonAgentAdd:
		return flag(st, "notify.pending_adds")
	case notify.ReasonMachineRequest:
		return flag(st, "notify.machine_requests")
	}
	return true // paused and security cannot be turned off
}

// quietHoursOf reads notify.quiet_hours: null for off, else {start, end, tz}.
func quietHoursOf(st map[string]any) (notify.QuietHours, bool) {
	m, ok := st["notify.quiet_hours"].(map[string]any)
	if !ok {
		return notify.QuietHours{}, false
	}
	start, _ := m["start"].(string)
	end, _ := m["end"].(string)
	zone, _ := m["tz"].(string)
	return notify.QuietHours{Start: start, End: end, Zone: zone}, true
}

// Env reads what the owner's choices and the data say about one trigger.
func (p pushSource) Env(ctx context.Context, d pdb.DBTX, t notify.Trigger, now time.Time) (notify.Env, error) {
	st, err := settingsOf(ctx, d, t.Person)
	if err != nil {
		return notify.Env{}, err
	}
	env := notify.Env{Visible: true, Enabled: enabled(t, st), UrgentBypass: flag(st, "notify.urgent_bypass")}
	if q, on := quietHoursOf(st); on {
		env.Quiet = q.Contains(now)
	}
	if t.Conversation == 0 {
		return env, nil
	}
	if _, found, err := conversation.Get(ctx, d, t.Conversation); err != nil || !found {
		env.Visible = false
		return env, err
	}
	pf, err := prefs.OfConversation(ctx, d, t.Person, t.Conversation)
	if err != nil {
		return env, err
	}
	env.Muted = pf.MutedUntil > now.UnixMilli()
	env.Focused = p.s.Push != nil && p.s.Push.Presence.On(t.Conversation, now)
	return env, nil
}

func (p pushSource) DeviceLive(ctx context.Context, d pdb.DBTX, device int64) (bool, error) {
	owner, err := identity.Owner(ctx, d)
	if err != nil {
		return false, err
	}
	list, err := auth.ListDevices(ctx, d, owner.ID, p.s.Clock.Now())
	return slices.ContainsFunc(list, func(i auth.DeviceInfo) bool { return i.ID == device }), err
}

// refOf prints an identity the way a title shows it: "Dev Tool @devtool", the handle always present (I-3). For 7 days after a
// handle change it adds "(was @old)", so the owner knows who wrote (I-51).
func refOf(ctx context.Context, d pdb.DBTX, id int64, now time.Time) (string, error) {
	who, found, err := identity.ByID(ctx, d, id)
	if err != nil || !found {
		return "", err
	}
	ref := message.Person{Handle: who.Handle, Name: who.DisplayName}.Ref()
	was, recent, err := identity.WasHandle(ctx, d, id, now)
	if err != nil || !recent {
		return ref, err
	}
	return ref + " (was @" + was + ")", nil
}

// leadingMention matches the "@handle" a message starts with.
func leadingMention(handle string) *regexp.Regexp {
	return regexp.MustCompile(`(?i)^@` + regexp.QuoteMeta(handle) + `\b[,:]?\s*`)
}

// eventAt re-reads the event a notification came from.
func eventAt(ctx context.Context, d pdb.DBTX, seq int64) (notify.Event, bool, error) {
	list, err := event.Since(ctx, d, seq-1, 1)
	if err != nil || len(list) == 0 || list[0].Seq != seq {
		return notify.Event{}, false, err
	}
	e := list[0]
	return notify.Event{Seq: e.Seq, Actor: e.Actor, Conversation: e.Conversation, Message: e.Message, CreatedAt: e.CreatedAt, Type: e.Type, Payload: e.Payload}, true, nil
}

// Facts reads what one push shows, from what is true now.
func (p pushSource) Facts(ctx context.Context, d pdb.DBTX, n notify.Notification) (notify.Facts, error) {
	st, err := settingsOf(ctx, d, n.Person)
	if err != nil {
		return notify.Facts{}, err
	}
	previews, _ := st["notify.previews"].(string)
	f := notify.Facts{Visible: true, Previews: previews, URL: notify.URLFor(n.Reason, n.Conversation, 0)}
	owner, err := identity.Get(ctx, d, n.Person)
	if err != nil {
		return f, err
	}
	var title string
	if n.Conversation != 0 {
		cv, found, err := conversation.Get(ctx, d, n.Conversation)
		if err != nil || !found {
			f.Visible = false
			return f, err
		}
		title = cv.Title
	}
	switch n.Reason {
	case notify.ReasonAsk, notify.ReasonAskUrgent, notify.ReasonSnoozeWake:
		a, err := ask.Get(ctx, d, n.Message)
		if errors.Is(err, ask.ErrNotFound) {
			f.Visible = false
			return f, nil
		}
		if err != nil {
			return f, err
		}
		f.Text = message.Project(message.Projectable{Ask: &message.ProjectAsk{Question: a.Question}}, message.Short)
		f.Sender, err = refOf(ctx, d, a.AskerID, p.s.Clock.Now())
		return f, err
	case notify.ReasonMention, notify.ReasonThreadReply:
		m, found, err := message.Get(ctx, d, n.Message)
		if err != nil || !found {
			f.Visible = false
			return f, err
		}
		by, err := attachmentsOf(ctx, d, []int64{m.ID})
		if err != nil {
			return f, err
		}
		ups, _ := projection(by[m.ID]) // a voice note has no body: the push reads "Voice note · 0:20"
		text := message.Project(message.Projectable{Format: m.Format, Body: m.Body, Uploads: ups, Reply: m.ThreadRootID != 0}, message.Short)
		f.Text = leadingMention(owner.Handle).ReplaceAllString(text, "") // the push is addressed to the owner already
		f.Sender, err = refOf(ctx, d, m.AuthorID, p.s.Clock.Now())
		return f, err
	case notify.ReasonAgentAdd:
		ev, found, err := eventAt(ctx, d, n.SourceSeq)
		if err != nil || !found {
			f.Visible = false
			return f, err
		}
		f.Sender, err = refOf(ctx, d, ev.Actor, p.s.Clock.Now())
		if err != nil {
			return f, err
		}
		added, err := refOf(ctx, d, bodyOf(ev).IdentityID, p.s.Clock.Now())
		f.Text = "wants to add " + added + " to " + titleOr(title)
		if bodyOf(ev).IdentityID == ev.Actor { // an agent asking for its own seat
			f.Text = "wants to join " + titleOr(title)
		}
		return f, err
	case notify.ReasonPlanWaiting:
		return p.planWaitingFacts(ctx, d, n, f)
	case notify.ReasonPaused: // only an old one: conversations are no longer paused (issue 117)
		f.Sender = titleOr(title)
		f.Text = "Paused after 20 agent messages in a row"
	case notify.ReasonMachineRequest:
		ev, found, err := eventAt(ctx, d, n.SourceSeq)
		if err != nil || !found {
			f.Visible = false
			return f, err
		}
		req, err := auth.PendingRequest(ctx, d, bodyOf(ev).RequestID, time.UnixMilli(ev.CreatedAt))
		if errors.Is(err, auth.ErrNoRequest) {
			f.Visible = false // approved, denied or expired before the push was sent
			return f, nil
		}
		f.Machine, f.Code, f.URL = req.Name, req.UserCode, notify.URLFor(n.Reason, 0, req.ID)
		return f, err
	case notify.ReasonSecurity:
		ev, found, err := eventAt(ctx, d, n.SourceSeq)
		if err != nil || !found {
			f.Visible = false
			return f, err
		}
		// The title says what happened; the body offers the way out (Settings → Privacy & security signs every other device out).
		f.Headline, f.Text = "Recovery code used", "Not you? Sign out all other devices in Settings."
		if ev.Type == eventKeyRevealed {
			f.Headline, f.Text = "Key revealed", "Not you? Regenerate the key in Crew."
			if name := p.machineName(ctx, d, bodyOf(ev).MachineID); name != "" {
				f.Headline = "Key revealed · " + name
			}
		}
	}
	return f, nil
}

func titleOr(t string) string {
	if t == "" {
		return "a conversation"
	}
	return t
}

// machineName is the name of a machine for a push; empty when it cannot be read.
func (p pushSource) machineName(ctx context.Context, d pdb.DBTX, id int64) string {
	list, err := auth.ListMachines(ctx, d, p.s.Clock.Now())
	if err != nil {
		return ""
	}
	for _, m := range list {
		if m.ID == id {
			return m.Name
		}
	}
	return ""
}

// pushWake records the notification of a snooze that woke (reason snooze_wake), in the transaction that wakes it, so the wake and its
// push cannot part. The pipeline's consumer skips ask.woke events: this is their one writer.
type pushWake struct{ s *Server }

func (w pushWake) SnoozeWoke(ctx context.Context, d pdb.DBTX, now time.Time, person, conv, askMessage, sourceSeq int64) error {
	if w.s.Push == nil {
		return nil
	}
	return w.s.Push.Record(ctx, d, now, notify.Trigger{
		Person: person, Reason: notify.ReasonSnoozeWake, SourceSeq: sourceSeq, Conversation: conv, Message: askMessage,
		TopicKind: notify.TopicAsk, TopicID: askMessage,
	})
}

// planWaitingFacts shows the item that waits on the owner, as the plan says now: the newest one. A plan that no longer waits on the
// owner by the time the push goes out is not pushed.
func (p pushSource) planWaitingFacts(ctx context.Context, d pdb.DBTX, n notify.Notification, f notify.Facts) (notify.Facts, error) {
	ev, found, err := eventAt(ctx, d, n.SourceSeq)
	if err != nil || !found {
		f.Visible = false
		return f, err
	}
	pl, err := plan.Get(ctx, d, ev.Actor, n.Conversation)
	if errors.Is(err, plan.ErrNotFound) || err == nil && len(pl.Waiting) == 0 {
		f.Visible = false
		return f, nil
	}
	if err != nil {
		return f, err
	}
	newest := slices.MaxFunc(pl.Waiting, func(a, b plan.Waiting) int { return cmp.Compare(a.Since, b.Since) })
	f.Text = "Waiting on you: " + newest.Text
	f.Sender, err = refOf(ctx, d, ev.Actor, p.s.Clock.Now())
	return f, err
}
