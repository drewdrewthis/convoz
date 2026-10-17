package httpapi

import (
	"context"
	"encoding/json"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/authz"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/conversation"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/identity"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/message"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/readstate"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

// participantPort answers authz's question "is this identity in that conversation?" from the conversation module.
type participantPort struct{ d pdb.DBTX }

func (p participantPort) Membership(ctx context.Context, conversationID, identityID int64) (authz.Member, bool, error) {
	m, found, err := conversation.Membership(ctx, p.d, conversationID, identityID)
	return authz.Member{Active: m.Active, JoinedMessageID: m.JoinedMessageID}, found, err
}

// canSee is authz.CanSee over d. Every read of a conversation, a message or an inbox item goes through it.
func canSee(ctx context.Context, d pdb.DBTX, p authz.Principal, conversationID int64) (floor int64, ok bool, err error) {
	return authz.CanSee(ctx, participantPort{d}, p, conversationID)
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

// systemAuthor is the author of a line the conversation says about itself: no handle, the kind "system".
var systemAuthor = wire.Person{Kind: "system"}

func (dir directory) message(m message.Message) wire.Message {
	if m.Kind == "system" {
		// A system line holds ids only; its words are built now from the current names, so every reader (page, inbox, stream)
		// gets the same text.
		sys, words := systemView(dir, m)
		return wire.Message{ID: m.ID, Author: systemAuthor, Body: words, Format: "plain", CreatedAt: m.CreatedAt, System: sys, Text: words}
	}
	return wire.Message{ID: m.ID, Author: dir.person(m.AuthorID), Body: m.Body, Format: m.Format, CreatedAt: m.CreatedAt}
}

// conversationView builds the list row of one conversation for the caller p, who may see messages above floor.
func conversationView(ctx context.Context, d pdb.DBTX, p authz.Principal, dir directory, cv conversation.Conversation, floor int64) (wire.Conversation, error) {
	parts, err := conversation.Participants(ctx, d, cv.ID)
	if err != nil {
		return wire.Conversation{}, err
	}
	out := wire.Conversation{ID: cv.ID, CreatedAt: cv.CreatedAt, LastActivityAt: cv.LastActivityAt, Rank: float64(cv.CreatedAt), Participants: make([]wire.Person, 0, len(parts))}
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
			out.Last = &wire.LastMessage{ID: m.ID, AuthorHandle: dir[m.AuthorID].Handle, Preview: message.Preview(dir.message(m).Body)}
		}
	}
	out.Unread, err = unreadOf(ctx, d, p.Identity(), cv, floor)
	if err != nil {
		return wire.Conversation{}, err
	}
	out.Paused = cv.Paused()
	if out.Pickup, out.PickedUpBy, err = pickupView(ctx, d, dir, cv); err != nil {
		return wire.Conversation{}, err
	}
	if cv.DeletedAt != 0 {
		out.DeletedAt, out.PurgesAt = ptr(cv.DeletedAt), ptr(cv.DeletedAt+conversation.TrashRetention.Milliseconds())
	}
	return out, nil
}

func ptr[T any](v T) *T { return &v }

// pickupView is the pickup state of a conversation and the agent holding it.
func pickupView(ctx context.Context, d pdb.DBTX, dir directory, cv conversation.Conversation) (string, *wire.Person, error) {
	if cv.PickupOpenedAt == 0 {
		return wire.PickupClosed, nil, nil
	}
	a, held, err := conversation.AssignmentOf(ctx, d, cv.ID)
	if err != nil || !held {
		return wire.PickupOpen, nil, err
	}
	who := dir.person(a.Agent)
	return wire.PickupTaken, &who, nil
}

// unreadOf is the main-thread part of design §8.2: messages after the reader's cursor that someone else wrote.
// A conversation the reader has no cursor for counts none.
func unreadOf(ctx context.Context, d pdb.DBTX, reader int64, cv conversation.Conversation, floor int64) (int64, error) {
	cursor, found, err := readstate.Cursor(ctx, d, reader, cv.ID)
	if err != nil || !found {
		return 0, err
	}
	after := max(cursor, floor)
	if cv.LastMainID <= after {
		return 0, nil
	}
	return message.CountUnread(ctx, d, cv.ID, after, reader)
}

// publishWorking sends the live-only "agent.working" frame: an agent started or stopped on a conversation.
// A working frame carries until (unix ms), the end of the agent's claim, and is sent again when a renewal moves it.
// The screen hides "working" at until, so a claim that runs out without a post or an ack clears by itself;
// a stop frame (working false) clears it sooner. The frame goes only to readers who may see the conversation.
// It is a hint, so a failure to build it is dropped.
func (s *Server) publishWorking(ctx context.Context, agentID, conversationID int64, working bool, until int64) {
	who, found, err := identity.ByID(ctx, s.reader(), agentID)
	if err != nil || !found {
		return
	}
	frame := map[string]any{"identity_id": who.ID, "handle": who.Handle, "conversation_id": conversationID, "working": working}
	if working {
		frame["until"] = until
	}
	data, _ := json.Marshal(frame)
	s.Bus.Publish(platform.Frame{Event: "agent.working", Data: data, Conversation: conversationID})
}
