// Package item is a server module. Item owns feed_items and feed_item_events: one row is one step of an agent's work for its whole
// life. A plan is the rows of one (agent, conversation) in seq order; exactly one is now (started or blocking), the rest wait as
// pending, and when the now item leaves, the next pending one is promoted in the same transaction. The agent moves only its own rows;
// the owner accepts, adds info, acknowledges and snoozes.
package item

import (
	"context"
	"database/sql"
	"errors"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/item/db"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// The states of an item.
const (
	Pending  = "pending"
	Started  = "started"
	Blocking = "blocking"
	Done     = "done"
	Fyi      = "fyi"
	Dropped  = "dropped"
)

// Lengths the database holds (generous: no other cap).
const (
	MaxTitle     = 200
	MaxContext   = 2000
	MaxRecommend = 500
)

var (
	// ErrNotFound: no such item, or not this agent's.
	ErrNotFound = errors.New("item: not found")
	// ErrConflict: the item's state does not allow the move; nothing changed.
	ErrConflict = errors.New("item: wrong state for this move")
	// ErrVersion: the owner acted on a version that is no longer current.
	ErrVersion = errors.New("item: the item changed since it was read")
	// ErrNoRecommendation: a blocking item with no recommendation takes info only.
	ErrNoRecommendation = errors.New("item: no recommendation to accept")
	// ErrText: a field is empty, too long, or not plain text.
	ErrText = errors.New("item: invalid text")
)

// Item is one step of work.
type Item struct {
	ID             int64
	Agent          int64
	Conversation   int64
	Plan           string // the plan of the agent this item is in: main, a name, or c<conversation> for an item made before plans
	Key            string
	Seq            int64
	State          string
	OwnerStep      bool
	Title          string
	Context        string
	Recommendation string // "" for none
	DueAt          int64  // epoch ms; 0 for none; display only
	AckedAt        int64
	AckedBy        int64
	AckKind        string
	SnoozedUntil   int64
	Version        int64
	CreatedAt      int64
	UpdatedAt      int64
	ThreadRoot     int64 // the message the item's thread hangs on; 0 for none
}

// Fields are what an agent says about an item.
type Fields struct {
	Title     string
	Context   string
	Recommend string
	DueAt     int64
	// Root is the message the item is, set when the item is made (the server posts it); 0 for none.
	Root int64
	// Plan names the plan on a new item; empty is main. A key that exists keeps its plan: naming another is a conflict.
	Plan string
	// Taken marks the item as a question taken from the owner's message (see Take).
	Taken bool
}

// Event is one line of an item's audit.
type Event struct {
	ID      int64
	Version int64
	Event   string
	ToState string
	By      int64
	Note    string
	At      int64
}

var markup = regexp.MustCompile("https?://|www\\.|\\]\\(|\\*\\*|`|^\\s*#+\\s|^\\s*[-*]\\s")

// plain says whether a text is plain: no markdown, no links.
func plain(s string) bool { return !markup.MatchString(s) }

func checkText(s string, min, max int) (string, error) {
	s = strings.TrimSpace(s)
	if n := utf8.RuneCountInString(s); n < min || n > max || !plain(s) {
		return "", ErrText
	}
	return s, nil
}

// NeedContext checks the fields of a start or a block as the agent's CLI and the API send them: the context is never empty
// (owner, conv 179 msg 12448: "I always want context").
func NeedContext(f Fields) (Fields, error) {
	f, err := f.check()
	if err == nil && f.Context == "" {
		err = ErrText
	}
	return f, err
}

// validPlan says whether a plan key is 1 to 64 characters of letters, digits, dot, dash and underscore.
func validPlan(p string) bool {
	if len(p) < 1 || len(p) > 64 {
		return false
	}
	for _, r := range p {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '.' || r == '-' || r == '_') {
			return false
		}
	}
	return true
}

func (f Fields) check() (Fields, error) {
	var err error
	if f.Title, err = checkText(f.Title, 1, MaxTitle); err != nil {
		return f, err
	}
	if f.Context, err = checkText(f.Context, 0, MaxContext); err != nil {
		return f, err
	}
	if f.Recommend, err = checkText(f.Recommend, 0, MaxRecommend); err != nil {
		return f, err
	}
	if f.Plan != "" && !validPlan(f.Plan) {
		return f, ErrText
	}
	return f, nil
}

func nstr(s string) sql.NullString { return sql.NullString{String: s, Valid: s != ""} }
func nint(n int64) sql.NullInt64   { return sql.NullInt64{Int64: n, Valid: n != 0} }

func fromRow(r db.FeedItem) Item {
	return Item{ID: r.ID, Agent: r.AgentID, Conversation: r.ConversationID, Plan: r.PlanKey, Key: r.WorkKey, Seq: r.Seq, State: r.State, OwnerStep: r.OwnerStep == 1,
		Title: r.Title, Context: r.Context, Recommendation: r.Recommendation.String, DueAt: r.DueAt.Int64, AckedAt: r.AckedAt.Int64, AckedBy: r.AckedBy.Int64,
		AckKind: r.AckKind.String, SnoozedUntil: r.SnoozedUntil.Int64, Version: r.Version, CreatedAt: r.CreatedAt, UpdatedAt: r.UpdatedAt, ThreadRoot: r.ThreadRootID.Int64}
}

// save writes the item as it now is and one audit line; bump raises the version first (every change the owner may need to see).
func save(ctx context.Context, d pdb.DBTX, it *Item, now time.Time, bump bool, event string, by int64, note string) error {
	if bump {
		it.Version++
	}
	it.UpdatedAt = now.UnixMilli()
	owner := int64(0)
	if it.OwnerStep {
		owner = 1
	}
	q := db.New(d)
	if err := q.SaveItem(ctx, db.SaveItemParams{State: it.State, OwnerStep: owner, Title: it.Title, Context: it.Context, Recommendation: nstr(it.Recommendation),
		DueAt: nint(it.DueAt), AckedAt: nint(it.AckedAt), AckedBy: nint(it.AckedBy), AckKind: nstr(it.AckKind), SnoozedUntil: nint(it.SnoozedUntil),
		Version: it.Version, UpdatedAt: it.UpdatedAt, ID: it.ID}); err != nil {
		return err
	}
	return q.InsertEvent(ctx, db.InsertEventParams{ItemID: it.ID, Version: it.Version, Event: event, ToState: it.State, ByIdentity: nint(by), Note: note, At: it.UpdatedAt})
}

// promote makes the lowest pending item of the plan the new now, in the caller's transaction. A step of the owner's becomes blocking.
func promote(ctx context.Context, d pdb.DBTX, now time.Time, agent int64, plan string) error {
	row, err := db.New(d).FirstPending(ctx, db.FirstPendingParams{AgentID: agent, PlanKey: plan})
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	next := fromRow(row)
	next.State = Started // an ack stays: the owner has seen this item, the plan only moved on to it
	if next.OwnerStep {
		next.State = Blocking
	}
	return save(ctx, d, &next, now, true, "promote", 0, "")
}

// ByKey finds the item an agent keeps under a work key.
func ByKey(ctx context.Context, d pdb.DBTX, agent, conv int64, key string) (Item, error) {
	r, err := db.New(d).ItemByKey(ctx, db.ItemByKeyParams{AgentID: agent, ConversationID: conv, WorkKey: key})
	if errors.Is(err, sql.ErrNoRows) {
		return Item{}, ErrNotFound
	}
	return fromRow(r), err
}

// ByID finds an item by its id.
func ByID(ctx context.Context, d pdb.DBTX, id int64) (Item, error) {
	r, err := db.New(d).ItemByID(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		return Item{}, ErrNotFound
	}
	return fromRow(r), err
}

// Events is the audit of one item, oldest first.
func Events(ctx context.Context, d pdb.DBTX, id int64) ([]Event, error) {
	rows, err := db.New(d).EventsOf(ctx, id)
	out := make([]Event, 0, len(rows))
	for _, r := range rows {
		out = append(out, Event{ID: r.ID, Version: r.Version, Event: r.Event, ToState: r.ToState, By: r.ByIdentity.Int64, Note: r.Note, At: r.At})
	}
	return out, err
}
