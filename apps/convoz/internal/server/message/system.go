package message

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"slices"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/message/db"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// SystemLine is one system line: ids and enums only (schemas/system.json, system.v1). Names are looked up when the line is
// shown, so a rename or a scrub never leaves stale text (AC-M15). The one text is the title in conversation.renamed: it is
// what the line quotes, and a later rename must not change what an earlier line said. Which fields a subtype takes is below.
type SystemLine struct {
	T        string // the subtype
	Identity int64  // the subject
	By       int64  // who did it
	Via      string // member.added: mention, add, create or triage; member.removed: triage (a triage agent did it, so the line names it)
	History  string // member.added: since_now or full
	Streak   int    // conversation.paused: LoopLimit
	Title    string // conversation.renamed: the new title, quoted by the line (optional; at most MaxTitleRunes, no control characters)
	// member.renamed: the handles before and after (I-51). Handles, not words: an agent's handles are never scrubbed, and a
	// retired one is never reused, so the line stays true.
	From, To string
	// plan.changed: the plan items the line quotes, as the agent wrote them (each optional, at least Done or Waiting). Like a title,
	// what the line said must not change when the plan changes later.
	Done, Now, Next, Waiting string
	// agent.unresponsive: not_responding or logged_out (msg 281).
	Liveness string
	// page.shared: the host of the shared tab (shop.test, localhost:8080), never its path or query: the line must not leak what the
	// address holds.
	Host string
}

// handleRE is a handle as the identities table allows it.
var handleRE = regexp.MustCompile(`^[a-z][a-z0-9-]{1,39}$`)

// hostRE is a URL host: a name or an address, and a port.
var hostRE = regexp.MustCompile(`^[A-Za-z0-9.\-\[\]:]{1,260}$`)

// ErrSystemLine means a system line that does not match system.v1.
var ErrSystemLine = errors.New("not a system.v1 line")

var (
	byOnly = []string{"conversation.renamed", "conversation.resumed", "conversation.restored"}
	// page.read and page.shot: the subject read or took a screenshot of the tab the owner shares (page-share.feature). The line
	// names the act only: the page's words never become a message.
	subjectOnly = []string{"member.left", "member.disabled", "page.read", "page.shot", "page.stopped"}
	// The shared tab's share ended on its own: the tab was closed or left (page.left), the panel was closed (page.closed), the
	// browser stopped polling (page.timeout). No one did it, so the line names no one.
	pageEnded = []string{"page.left", "page.closed", "page.timeout"}
	subjectBy = []string{"member.requested", "member.removed", "member.approved", "member.declined"}
)

// Valid checks the line against system.v1.
func (l SystemLine) Valid() error {
	bad := func() error { return fmt.Errorf("%w: %+v", ErrSystemLine, l) }
	switch {
	case slices.Contains(byOnly, l.T):
		if l.By <= 0 || l.Title != "" && (l.T != "conversation.renamed" || !quotableTitle(l.Title)) {
			return bad()
		}
	case slices.Contains(subjectOnly, l.T):
		if l.Identity <= 0 {
			return bad()
		}
	case slices.Contains(subjectBy, l.T):
		if l.Identity <= 0 || l.By <= 0 || l.Via != "" && (l.Via != "triage" || l.T != "member.removed") {
			return bad()
		}
	case l.T == "member.added":
		if l.Identity <= 0 || l.By <= 0 || !slices.Contains([]string{"mention", "add", "create", "triage"}, l.Via) ||
			l.History != "" && l.History != "since_now" && l.History != "full" {
			return bad()
		}
	case l.T == "conversation.paused":
		if l.Streak != LoopLimit {
			return bad()
		}
	case l.T == "member.renamed":
		if l.Identity <= 0 || !handleRE.MatchString(l.From) || !handleRE.MatchString(l.To) || l.From == l.To {
			return bad()
		}
	case l.T == "plan.changed":
		if l.Identity <= 0 || l.Done == "" && l.Waiting == "" || !quotableItem(l.Done) || !quotableItem(l.Now) || !quotableItem(l.Next) || !quotableItem(l.Waiting) {
			return bad()
		}
	case l.T == "agent.unresponsive":
		if l.Identity <= 0 || l.Liveness != "not_responding" && l.Liveness != "logged_out" {
			return bad()
		}
	case l.T == "page.shared":
		if l.Identity <= 0 || !hostRE.MatchString(l.Host) {
			return bad()
		}
	case slices.Contains(pageEnded, l.T):
	default:
		return bad()
	}
	return nil
}

// quotableTitle reports whether t can be quoted by a rename line: 1 to 120 characters and no control characters (the
// conversation module cleans a title before it gets here; a message module may not import it).
func quotableTitle(t string) bool {
	n := utf8.RuneCountInString(t)
	return n >= 1 && n <= 120 && !strings.ContainsFunc(t, unicode.IsControl)
}

// MaxItemRunes is the longest plan item a plan.changed line quotes.
const MaxItemRunes = 200

// quotableItem reports whether t can be quoted by a plan.changed line: empty, or at most MaxItemRunes characters and no control characters.
func quotableItem(t string) bool {
	return utf8.RuneCountInString(t) <= MaxItemRunes && !strings.ContainsFunc(t, unicode.IsControl)
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
		Streak   int    `json:"streak,omitempty"`
		Title    string `json:"title,omitempty"`
		From     string `json:"from,omitempty"`
		To       string `json:"to,omitempty"`
		Done     string `json:"done,omitempty"`
		Now      string `json:"now,omitempty"`
		Next     string `json:"next,omitempty"`
		Waiting  string `json:"waiting,omitempty"`
		Liveness string `json:"liveness,omitempty"`
		Host     string `json:"host,omitempty"`
	}{1, l.T, l.Identity, l.By, l.Via, l.History, l.Streak, l.Title, l.From, l.To, l.Done, l.Now, l.Next, l.Waiting, l.Liveness, l.Host}
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
		Streak   int    `json:"streak"`
		Title    string `json:"title"`
		From     string `json:"from"`
		To       string `json:"to"`
		Done     string `json:"done"`
		Now      string `json:"now"`
		Next     string `json:"next"`
		Waiting  string `json:"waiting"`
		Liveness string `json:"liveness"`
		Host     string `json:"host"`
	}
	if json.Unmarshal([]byte(raw), &doc) != nil || doc.T == "" {
		return SystemLine{}, false
	}
	return SystemLine{T: doc.T, Identity: doc.Identity, By: doc.By, Via: doc.Via, History: doc.History, Streak: doc.Streak, Title: doc.Title, From: doc.From, To: doc.To,
		Done: doc.Done, Now: doc.Now, Next: doc.Next, Waiting: doc.Waiting, Liveness: doc.Liveness, Host: doc.Host}, true
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
