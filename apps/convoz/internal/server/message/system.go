package message

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/message/db"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// SystemLine is one system line: ids and enums only (schemas/system.json, system.v1). Names and titles are looked up when
// the line is shown, so a rename or a scrub never leaves stale text (AC-M15). Which fields a subtype takes is below.
type SystemLine struct {
	T        string // the subtype
	Identity int64  // the subject
	By       int64  // who did it
	Via      string // member.added: mention, add or create
	History  string // member.added: since_now or full
	Reason   string // pickup.released: removed, key_revoked, disabled or lease_expired
	Streak   int    // conversation.paused: LoopLimit
}

// ErrSystemLine means a system line that does not match system.v1.
var ErrSystemLine = errors.New("not a system.v1 line")

var (
	byOnly      = []string{"conversation.renamed", "conversation.resumed", "conversation.restored", "pickup.opened"}
	subjectOnly = []string{"member.left", "member.disabled", "pickup.taken"}
	subjectBy   = []string{"member.requested", "member.removed"}
)

// Valid checks the line against system.v1.
func (l SystemLine) Valid() error {
	bad := func() error { return fmt.Errorf("%w: %+v", ErrSystemLine, l) }
	switch {
	case slices.Contains(byOnly, l.T):
		if l.By <= 0 {
			return bad()
		}
	case slices.Contains(subjectOnly, l.T):
		if l.Identity <= 0 {
			return bad()
		}
	case slices.Contains(subjectBy, l.T):
		if l.Identity <= 0 || l.By <= 0 {
			return bad()
		}
	case l.T == "member.added":
		if l.Identity <= 0 || l.By <= 0 || !slices.Contains([]string{"mention", "add", "create"}, l.Via) ||
			l.History != "" && l.History != "since_now" && l.History != "full" {
			return bad()
		}
	case l.T == "conversation.paused":
		if l.Streak != LoopLimit {
			return bad()
		}
	case l.T == "pickup.released":
		if l.Identity <= 0 || !slices.Contains([]string{"removed", "key_revoked", "disabled", "lease_expired"}, l.Reason) {
			return bad()
		}
	default:
		return bad()
	}
	return nil
}

// JSON is the stored form, {"v":1,"t":...} with only the fields the subtype takes.
func (l SystemLine) JSON() (string, error) {
	if err := l.Valid(); err != nil {
		return "", err
	}
	doc := struct {
		V        int    `json:"v"`
		T        string `json:"t"`
		Identity int64  `json:"identity,omitempty"`
		By       int64  `json:"by,omitempty"`
		Via      string `json:"via,omitempty"`
		History  string `json:"history,omitempty"`
		Reason   string `json:"reason,omitempty"`
		Streak   int    `json:"streak,omitempty"`
	}{1, l.T, l.Identity, l.By, l.Via, l.History, l.Reason, l.Streak}
	raw, err := json.Marshal(doc)
	return string(raw), err
}

// ParseSystem reads a stored system_json back.
func ParseSystem(raw string) (SystemLine, bool) {
	var doc struct {
		T        string `json:"t"`
		Identity int64  `json:"identity"`
		By       int64  `json:"by"`
		Via      string `json:"via"`
		History  string `json:"history"`
		Reason   string `json:"reason"`
		Streak   int    `json:"streak"`
	}
	if json.Unmarshal([]byte(raw), &doc) != nil || doc.T == "" {
		return SystemLine{}, false
	}
	return SystemLine{T: doc.T, Identity: doc.Identity, By: doc.By, Via: doc.Via, History: doc.History, Reason: doc.Reason, Streak: doc.Streak}, true
}

// WriteSystem writes a system line in the transaction of the action that caused it (M-4). It is not a post: it moves no
// counter, no read cursor and no inbox. Other modules call it through a port of their own.
func WriteSystem(ctx context.Context, d pdb.DBTX, p Ports, now time.Time, conv int64, l SystemLine) (Message, error) {
	raw, err := l.JSON()
	if err != nil {
		return Message{}, err
	}
	id, err := db.New(d).InsertSystem(ctx, db.InsertSystemParams{ConversationID: conv, SystemJson: nullStr(raw), CreatedAt: now.UnixMilli()})
	if err != nil {
		return Message{}, err
	}
	m := Message{ID: id, ConversationID: conv, Kind: "system", Format: "plain", CreatedAt: now.UnixMilli(), System: raw}
	if p.Events != nil {
		err = p.Events.SystemWritten(ctx, d, now, conv, id)
	}
	return m, err
}

// Thread lists the replies to one root that the reader may see (ids above floor), oldest first; a deleted one is a tombstone.
func Thread(ctx context.Context, d pdb.DBTX, conv, root, floor int64, limit int) ([]Message, error) {
	rows, err := db.New(d).ThreadReplies(ctx, db.ThreadRepliesParams{ConversationID: conv, RootID: nullInt(root), Floor: floor, MaxRows: int64(ClampLimit(limit))})
	return fromRows(rows, false), err
}
