package httpapi

import (
	"context"
	"encoding/json"
	"slices"
	"strings"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/authz"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/conversation"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/identity"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/message"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

// participantPort answers authz's question "is this identity in that conversation?" from the conversation module.
type participantPort struct{ d pdb.DBTX }

// IsTriage answers authz.TriageReader: the agent holds the right and the conversation is not in the trash.
func (p participantPort) IsTriage(ctx context.Context, conversationID, identityID int64) (bool, error) {
	granted, err := identity.IsTriage(ctx, p.d, identityID)
	if err != nil || !granted {
		return false, err
	}
	_, live, err := conversation.Get(ctx, p.d, conversationID)
	return live, err
}

func (p participantPort) Membership(ctx context.Context, conversationID, identityID int64) (authz.Member, bool, error) {
	m, found, err := conversation.Membership(ctx, p.d, conversationID, identityID)
	return authz.Member{Active: m.Active, JoinedMessageID: m.JoinedMessageID}, found, err
}

// canSee is authz.CanSee over d. Every read of a conversation, a message or an inbox item goes through it.
func canSee(ctx context.Context, d pdb.DBTX, p authz.Principal, conversationID int64) (floor int64, ok bool, err error) {
	return authz.CanSee(ctx, participantPort{d}, p, conversationID)
}

// canRead is authz.CanRead over d: canSee plus the triage right. Use it only on read paths (and posting); a change stays canSee.
func canRead(ctx context.Context, d pdb.DBTX, p authz.Principal, conversationID int64) (floor int64, ok bool, err error) {
	return authz.CanRead(ctx, participantPort{d}, p, conversationID)
}

// canManage is authz.CanManageAgents over d: the one gate of adding and removing agents, open to a triage agent in any live conversation.
func canManage(ctx context.Context, d pdb.DBTX, p authz.Principal, conversationID int64) (bool, error) {
	return authz.CanManageAgents(ctx, participantPort{d}, p, conversationID)
}

// isTriage says whether the caller is an agent holding the triage right.
func isTriage(ctx context.Context, d pdb.DBTX, p authz.Principal) (bool, error) {
	if p.SessionID == 0 {
		return false, nil
	}
	return identity.IsTriage(ctx, d, p.IdentityID)
}

// directory maps identity ids to their entries, for turning ids into handles and names.
type directory map[int64]identity.Entry

func loadDirectory(ctx context.Context, d pdb.DBTX) (directory, error) {
	list, err := identity.List(ctx, d)
	if err != nil {
		return nil, err
	}
	dir := make(directory, len(list))
	for _, e := range list {
		dir[e.ID] = e
	}
	return dir, nil
}

func (dir directory) person(id int64) wire.Person {
	e := dir[id]
	return wire.Person{ID: e.ID, Handle: e.Handle, DisplayName: e.DisplayName, Kind: e.Kind}
}

// resolve finds the identity a handle names: the one that has it now, else the one that had it before. A retired handle is never
// reused, so the answer is the same before and after a change (I-51).
func (dir directory) resolve(handle string) (identity.Entry, bool) {
	var was identity.Entry
	found := false
	for _, e := range dir {
		if e.Handle == handle {
			return e, true
		}
		if !found && slices.Contains(e.PreviousHandles, handle) {
			was, found = e, true
		}
	}
	return was, found
}

// mentions resolves the @handles of a body by id, so a reader sees who each names now, also for a handle given up since (I-51).
func (dir directory) mentions(body, format string) []wire.MentionSpan {
	if !strings.Contains(body, "@") {
		return nil
	}
	var out []wire.MentionSpan
	for _, h := range message.ParseMentions(body, format) {
		if e, ok := dir.resolve(h); ok {
			out = append(out, wire.MentionSpan{AsWritten: h, IdentityID: e.ID, Handle: e.Handle})
		}
	}
	return out
}

// systemAuthor is the author of a line the conversation says about itself: no handle, the kind "system".
var systemAuthor = wire.Person{Kind: "system"}

func (dir directory) message(m message.Message) wire.Message {
	if m.Kind == "system" {
		// A system line holds ids only; its words are built now from the current names, so every reader (page, inbox, stream)
		// gets the same text.
		sys, words := systemView(dir, m)
		return wire.Message{ID: m.ID, Author: systemAuthor, Body: words, Format: "plain", CreatedAt: m.CreatedAt, System: sys, Text: words}
	}
	v := wire.Message{ID: m.ID, Author: dir.person(m.AuthorID), Body: m.Body, Format: m.Format, CreatedAt: m.CreatedAt, App: appView(m.App), Mentions: dir.mentions(m.Body, m.Format), ViaVoice: m.ViaVoice}
	if m.ViaAppID != 0 {
		v.ViaApp = &wire.ViaApp{MessageID: m.ViaAppID, Agent: dir.person(m.ViaAgentID), Result: m.AppResult}
	}
	return v
}

// conversationView builds the list row of one conversation for the caller p, who may see messages above floor.
func conversationView(ctx context.Context, d pdb.DBTX, p authz.Principal, dir directory, cv conversation.Conversation, floor int64) (wire.Conversation, error) {
	parts, err := conversation.Participants(ctx, d, cv.ID)
	if err != nil {
		return wire.Conversation{}, err
	}
	out := wire.Conversation{ID: cv.ID, CreatedAt: cv.CreatedAt, LastActivityAt: cv.LastActivityAt, Rank: float64(cv.LastActivityAt), Participants: make([]wire.Person, 0, len(parts))}
	if cv.Title != "" {
		title := cv.Title
		out.Title = &title
	}
	for _, pt := range parts {
		if _, ok := dir[pt.IdentityID]; ok {
			out.Participants = append(out.Participants, dir.person(pt.IdentityID))
		}
	}
	if cv.LastMessageID > floor {
		m, ok, err := message.Get(ctx, d, cv.LastMessageID)
		if err != nil {
			return wire.Conversation{}, err
		}
		if ok {
			out.Last = &wire.LastMessage{ID: m.ID, AuthorHandle: dir[m.AuthorID].Handle, Preview: message.Preview(previewWords(ctx, d, m))}
			out.OwnerLast = isOwner(dir, m.AuthorID)
		}
	}
	u, err := unreadParts(ctx, d, p.Identity(), cv, floor)
	if err != nil {
		return wire.Conversation{}, err
	}
	out.MainUnread, out.Unread = u.main, u.total()
	if out.UnreadMentions, err = unreadMentions(ctx, d, p.Identity(), cv, u); err != nil {
		return wire.Conversation{}, err
	}
	if out.Threads, err = threadRowsOf(ctx, d, p, dir, cv, floor); err != nil {
		return wire.Conversation{}, err
	}
	if out.RepliesToYou, err = repliesToYou(ctx, d, dir, p.Identity(), cv, u, out.Threads); err != nil {
		return wire.Conversation{}, err
	}
	out.Stale = cv.Stale()
	if out.Stale {
		out.StaleReason = cv.StaleReason
	}
	if cv.DeletedAt != 0 {
		out.DeletedAt, out.PurgesAt = ptr(cv.DeletedAt), ptr(cv.DeletedAt+conversation.TrashRetention.Milliseconds())
	}
	return out, nil
}

func ptr[T any](v T) *T { return &v }

// isOwner says whether the identity is the owner, or @voice writing his words for him. A conversation where the owner wrote the
// newest message never goes Older (#42).
func isOwner(dir directory, id int64) bool {
	e := dir[id]
	return e.Role == "owner" || (e.Kind == "agent" && e.Handle == identity.VoiceHandle)
}

// ownerWroteLast reports whether the owner wrote the newest message of the main list.
func ownerWroteLast(ctx context.Context, d pdb.DBTX, dir directory, cv conversation.Conversation) (bool, error) {
	if cv.LastMessageID == 0 {
		return false, nil
	}
	m, ok, err := message.Get(ctx, d, cv.LastMessageID)
	return ok && isOwner(dir, m.AuthorID), err
}

// publishWorking sends the live-only "agent.working" frame: an agent started or stopped on a conversation.
// A working frame carries until (unix ms), the end of the agent's claim, and is sent again when a renewal moves it.
// The screen hides "working" at until, so a claim that runs out without a post or an ack clears by itself;
// a stop frame (working false) clears it sooner. The frame goes only to readers who may see the conversation.
// It is a hint, so a failure to build it is dropped.
func (s *Server) publishWorking(ctx context.Context, agentID, conversationID int64, working bool, until int64) {
	s.publishWorkingAt(ctx, agentID, conversationID, 0, working, until)
}

// publishWorkingAt is publishWorking for work in one place: the thread of root (a top-level message), or the main list for 0.
// A stop frame names no place: it ends the agent's work in the whole conversation.
func (s *Server) publishWorkingAt(ctx context.Context, agentID, conversationID, root int64, working bool, until int64) {
	who, found, err := identity.ByID(ctx, s.reader(), agentID)
	if err != nil || !found {
		return
	}
	frame := map[string]any{"identity_id": who.ID, "handle": who.Handle, "conversation_id": conversationID, "working": working}
	if working {
		frame["until"] = until
		if root != 0 {
			frame["thread_root_id"] = root
		}
	}
	data, _ := json.Marshal(frame)
	s.Bus.Publish(platform.Frame{Event: "agent.working", Data: data, Conversation: conversationID})
}

// previewWords is the text the list previews for a message: its body, or for one with files the plain form that names them
// ("Voice note · 0:20").
func previewWords(ctx context.Context, d pdb.DBTX, m message.Message) string {
	by, err := attachmentsOf(ctx, d, []int64{m.ID})
	if err != nil || len(by[m.ID]) == 0 {
		return m.Body
	}
	ups, _ := projection(by[m.ID])
	return message.Project(message.Projectable{Format: m.Format, Body: m.Body, Uploads: ups}, message.Short)
}
