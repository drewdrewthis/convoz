package httpapi

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/item"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/message"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/plan"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

// itemRefused answers an item error; false means it was none of those.
func (s *Server) itemRefused(w http.ResponseWriter, r *http.Request, err error) bool {
	switch {
	case err == nil:
		return false
	case errors.Is(err, item.ErrNotFound):
		writeErr(w, http.StatusNotFound, "not_found", "No such item.")
	case errors.Is(err, item.ErrVersion):
		writeErr(w, http.StatusConflict, "conflict", "The item changed since you read it. Read it again.")
	case errors.Is(err, item.ErrConflict):
		writeErr(w, http.StatusConflict, "conflict", "The item is in a state that does not allow this.")
	case errors.Is(err, item.ErrNoRecommendation):
		writeErr(w, http.StatusConflict, "no_recommendation", "This item has no recommendation to accept. Add info instead.")
	case errors.Is(err, item.ErrText):
		writeErr(w, http.StatusBadRequest, "invalid_request", "Text must be plain (no markdown, no links) and within its length: title 1-200, context 2000, recommendation 500, key 1-64.")
	default:
		s.internalError(w, r, err)
	}
	return true
}

// postItem is POST /api/conversations/:id/items/:key/:event. The agent comes from the lease, never the body, so it reaches only its own rows.
func (s *Server) postItem(w http.ResponseWriter, r *http.Request, c *call) {
	conv, ok := pathID(w, r)
	if !ok {
		return
	}
	var in wire.ItemRequest
	if !decode(w, r, &in) {
		return
	}
	if _, visible, err := canSee(r.Context(), s.reader(), c.p, conv); err != nil {
		s.internalError(w, r, err)
		return
	} else if !visible {
		notVisible(w, c)
		return
	}
	key, event, agent := r.PathValue("key"), r.PathValue("event"), c.p.Identity()
	f := item.Fields{Title: in.Title, Context: in.Context, Recommend: in.Recommend}
	if in.Due != "" {
		due, ok := plan.ParseDue(in.Due, in.UTCOffset, s.Clock.Now())
		if !ok {
			writeFieldErr(w, http.StatusBadRequest, "invalid_request", "due", "due is a duration (2d, 1d4h, 30m), a time HH:MM or a date YYYY-MM-DD HH:MM, ahead of now")
			return
		}
		f.DueAt = due
	}
	moves := map[string]func(ctx context.Context, d pdb.DBTX, now time.Time) (item.Item, error){
		"start": func(ctx context.Context, d pdb.DBTX, now time.Time) (item.Item, error) {
			return item.Start(ctx, d, now, agent, conv, key, f)
		},
		"block": func(ctx context.Context, d pdb.DBTX, now time.Time) (item.Item, error) {
			return item.Block(ctx, d, now, agent, conv, key, f)
		},
		"done": func(ctx context.Context, d pdb.DBTX, now time.Time) (item.Item, error) {
			return item.MarkDone(ctx, d, now, agent, conv, key, in.Outcome)
		},
		"fyi": func(ctx context.Context, d pdb.DBTX, now time.Time) (item.Item, error) {
			return item.MarkFyi(ctx, d, now, agent, conv, key, in.Outcome)
		},
		"drop": func(ctx context.Context, d pdb.DBTX, now time.Time) (item.Item, error) {
			return item.Drop(ctx, d, now, agent, conv, key)
		},
		"say": func(ctx context.Context, d pdb.DBTX, now time.Time) (item.Item, error) {
			return item.Say(ctx, d, now, agent, conv, key, in.Outcome)
		},
	}
	move, known := moves[event]
	if !known {
		writeErr(w, http.StatusNotFound, "not_found", "No such item event.")
		return
	}
	var wake []int64
	if event == "start" || event == "block" {
		move = s.withThreadRoot(c, conv, key, move, &wake)
	}
	s.itemChangeWake(w, r, c, move, &wake)
}

// withThreadRoot makes the one message an item's thread hangs on: when the move creates the item, the agent posts its title in the
// item's conversation and the message id is kept as the item's thread root (the same transaction). Later moves, and an item that
// already exists, post nothing. The owner reads and writes the thread in Now (owner, 179 msgs 12145-12146).
func (s *Server) withThreadRoot(c *call, conv int64, key string, move func(ctx context.Context, d pdb.DBTX, now time.Time) (item.Item, error), wake *[]int64) func(ctx context.Context, d pdb.DBTX, now time.Time) (item.Item, error) {
	return func(ctx context.Context, d pdb.DBTX, now time.Time) (item.Item, error) {
		_, err := item.ByKey(ctx, d, c.p.Identity(), conv, key)
		isNew := errors.Is(err, item.ErrNotFound)
		it, err := move(ctx, d, now)
		if err != nil || !isNew {
			return it, err
		}
		posted, err := message.Post(ctx, d, messagePorts(c.p), now, message.Draft{
			Conversation: conv, Author: c.p.Identity(), Session: c.p.SessionID, Device: c.dev.ID, Origin: message.Origin{Label: c.lease.Label, Machine: c.lease.Machine},
			ClientID: fmt.Sprintf("item-%d-thread", it.ID), Body: it.Title, Format: "plain",
		})
		if err != nil {
			return item.Item{}, err
		}
		*wake = append(*wake, posted.Wake...)
		it.ThreadRoot = posted.Message.ID
		return it, item.SetThreadRoot(ctx, d, it.ID, it.ThreadRoot)
	}
}

// itemChange runs one move in one transaction and writes the item.
func (s *Server) itemChange(w http.ResponseWriter, r *http.Request, c *call, move func(ctx context.Context, d pdb.DBTX, now time.Time) (item.Item, error)) {
	s.itemChangeWake(w, r, c, move, nil)
}

// itemChangeWake is itemChange that also wakes the agents a posted message went to, after the commit.
func (s *Server) itemChangeWake(w http.ResponseWriter, r *http.Request, c *call, move func(ctx context.Context, d pdb.DBTX, now time.Time) (item.Item, error), wake *[]int64) {
	var it item.Item
	now := s.Clock.Now()
	err := s.Store.Writer.Tx(r.Context(), func(ctx context.Context, tx *pdb.Tx) (err error) {
		it, err = move(ctx, tx.DBTX(), now)
		return err
	})
	if s.itemRefused(w, r, err) {
		return
	}
	if wake != nil {
		s.Bus.Notify(*wake...)
	} else {
		s.Bus.Notify()
	}
	dir, err := loadDirectory(r.Context(), s.reader())
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, feedItemView(dir, it))
}

func feedItemView(dir directory, it item.Item) wire.FeedItem {
	return wire.FeedItem{ID: it.ID, ConversationID: it.Conversation, AgentID: it.Agent, Handle: dir[it.Agent].Handle, Key: it.Key, Seq: it.Seq, State: it.State,
		Title: it.Title, Context: it.Context, Recommendation: it.Recommendation, CanAccept: it.State == item.Blocking && it.Recommendation != "",
		ThreadRootID: it.ThreadRoot, DueAt: it.DueAt, AckedAt: it.AckedAt, AckKind: it.AckKind, SnoozedUntil: it.SnoozedUntil, Version: it.Version, UpdatedAt: it.UpdatedAt}
}

// getFeed is GET /api/feed: open items in plan order, the finished ones last. Owner only.
func (s *Server) getFeed(w http.ResponseWriter, r *http.Request, c *call) {
	f, err := item.List(r.Context(), s.reader(), 20)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	dir, err := loadDirectory(r.Context(), s.reader())
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	out := wire.FeedResponse{Items: []wire.FeedItem{}, Done: []wire.FeedItem{}}
	for _, it := range f.Open {
		out.Items = append(out.Items, feedItemView(dir, it))
	}
	for _, it := range f.Done {
		out.Done = append(out.Done, feedItemView(dir, it))
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) feedAccept(w http.ResponseWriter, r *http.Request, c *call) {
	id, ok := pathID(w, r)
	var in wire.FeedAcceptRequest
	if !ok || !decode(w, r, &in) {
		return
	}
	s.itemChange(w, r, c, func(ctx context.Context, d pdb.DBTX, now time.Time) (item.Item, error) {
		return item.Accept(ctx, d, now, c.p.HumanID, id, in.IfVersion)
	})
}

func (s *Server) feedAnswer(w http.ResponseWriter, r *http.Request, c *call) {
	id, ok := pathID(w, r)
	var in wire.FeedAnswerRequest
	if !ok || !decode(w, r, &in) {
		return
	}
	s.itemChange(w, r, c, func(ctx context.Context, d pdb.DBTX, now time.Time) (item.Item, error) {
		return item.Answer(ctx, d, now, c.p.HumanID, id, in.Text, in.Resolves)
	})
}

func (s *Server) feedAck(w http.ResponseWriter, r *http.Request, c *call) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	s.itemChange(w, r, c, func(ctx context.Context, d pdb.DBTX, now time.Time) (item.Item, error) {
		return item.GotIt(ctx, d, now, c.p.HumanID, id)
	})
}

func (s *Server) feedSnooze(w http.ResponseWriter, r *http.Request, c *call) {
	id, ok := pathID(w, r)
	var in wire.FeedSnoozeRequest
	if !ok || !decode(w, r, &in) {
		return
	}
	s.itemChange(w, r, c, func(ctx context.Context, d pdb.DBTX, now time.Time) (item.Item, error) {
		return item.Snooze(ctx, d, now, c.p.HumanID, id, in.Until)
	})
}

func (s *Server) feedUnsnooze(w http.ResponseWriter, r *http.Request, c *call) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	s.itemChange(w, r, c, func(ctx context.Context, d pdb.DBTX, now time.Time) (item.Item, error) {
		return item.Unsnooze(ctx, d, now, c.p.HumanID, id)
	})
}
