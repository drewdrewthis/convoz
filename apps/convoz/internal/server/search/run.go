package search

import (
	"context"
	"strconv"
	"strings"

	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
)

// Visible is a conversation the viewer may search. Floor is the highest message id the viewer may NOT see (I-7); 0 sees all.
type Visible struct {
	ID    int64
	Title string
	Floor int64
}

// Person is an identity a from: filter can name.
type Person struct {
	ID     int64
	Handle string
}

// Scope is what the other modules say about the viewer, built by the composition root before a query. Visible already holds
// no conversation in the trash and none the viewer is not in (I-6). The three functions are called only when the query
// uses the filter that needs them.
type Scope struct {
	Visible []Visible
	People  []Person
	Pinned  func() ([]int64, error) // message ids the viewer pinned
	Starred func() ([]int64, error) // conversation ids the viewer starred
	Files   func() ([]int64, error) // message ids that carry a file
}

// Hit is one found message. Message text, author and title are for the caller to read from their owners.
type Hit struct {
	MessageID, ConversationID, CreatedAt int64
}

// MaxLimit is the most hits one query returns.
const MaxLimit = 50

// Run finds the messages of q the viewer of scope may see, newest first, at most limit of them.
func Run(ctx context.Context, d pdb.DBTX, q Query, sc Scope, limit int) ([]Hit, error) {
	limit = min(max(limit, 1), MaxLimit)
	where, ok, err := q.conditions(sc)
	if err != nil || !ok {
		return nil, err
	}
	var args []any
	var sql strings.Builder
	if m := q.match(); m != "" {
		// MATCH needs the table name, and the order is the table's own rowid order (messages.id: newest first).
		sql.WriteString(`SELECT e.message_id, e.conversation_id, e.created_at FROM messages_fts JOIN search_entries e ON e.message_id = messages_fts.rowid WHERE messages_fts MATCH ?`)
		args = append(args, m)
		for _, w := range where {
			sql.WriteString(" AND " + w)
		}
		sql.WriteString(` ORDER BY messages_fts.rowid DESC LIMIT ?`)
	} else {
		sql.WriteString(`SELECT e.message_id, e.conversation_id, e.created_at FROM search_entries e WHERE 1`)
		for _, w := range where {
			sql.WriteString(" AND " + w)
		}
		sql.WriteString(` ORDER BY e.message_id DESC LIMIT ?`)
	}
	args = append(args, limit)
	rows, err := d.QueryContext(ctx, sql.String(), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var hits []Hit
	for rows.Next() {
		var h Hit
		if err := rows.Scan(&h.MessageID, &h.ConversationID, &h.CreatedAt); err != nil {
			return nil, err
		}
		hits = append(hits, h)
	}
	return hits, rows.Err()
}

// conditions turns the filters and the viewer's scope into WHERE terms over search_entries (alias e). ok is false when a
// filter can match nothing, so the statement need not run. Only integers are written into the text; every string is a
// bound argument.
func (q Query) conditions(sc Scope) (where []string, ok bool, err error) {
	convs := q.conversations(sc)
	if len(convs) == 0 {
		return nil, false, nil
	}
	where = append(where, visibleSQL(convs))
	if len(q.From) > 0 {
		ids := q.authors(sc.People)
		if len(ids) == 0 {
			return nil, false, nil
		}
		where = append(where, "e.author_id IN ("+intList(ids)+")")
	}
	if q.Ask {
		where = append(where, "e.kind = 'ask'")
	}
	if q.App {
		where = append(where, "e.is_app = 1")
	}
	if q.Link {
		where = append(where, "e.has_link = 1")
	}
	for _, f := range []struct {
		on   bool
		load func() ([]int64, error)
	}{{q.Pinned, sc.Pinned}, {q.File, sc.Files}} {
		if !f.on {
			continue
		}
		var ids []int64
		if f.load != nil {
			if ids, err = f.load(); err != nil {
				return nil, false, err
			}
		}
		if len(ids) == 0 {
			return nil, false, nil
		}
		where = append(where, "e.message_id IN ("+intList(ids)+")")
	}
	return where, true, nil
}

// conversations are the visible conversations the in: and is:starred filters leave.
func (q Query) conversations(sc Scope) []Visible {
	starred := map[int64]bool{}
	if q.Starred && sc.Starred != nil {
		if ids, err := sc.Starred(); err == nil {
			for _, id := range ids {
				starred[id] = true
			}
		}
	}
	var out []Visible
	for _, v := range sc.Visible {
		if q.Starred && !starred[v.ID] {
			continue
		}
		if len(q.In) > 0 && !q.inAny(v) {
			continue
		}
		out = append(out, v)
	}
	return out
}

// inAny reports whether the conversation is one of the in: values: a number is its id, anything else a part of its title
// (case folded, as the words are).
func (q Query) inAny(v Visible) bool {
	title := strings.Join(wordsOf(v.Title), " ")
	for _, in := range q.In {
		if id, err := strconv.ParseInt(in, 10, 64); err == nil && id == v.ID {
			return true
		}
		if w := strings.Join(wordsOf(in), " "); w != "" && strings.Contains(title, w) {
			return true
		}
	}
	return false
}

// authors are the ids of the people a from: filter names: a handle matches by its start, so "from:@dev" finds devtool.
func (q Query) authors(people []Person) []int64 {
	var ids []int64
	for _, p := range people {
		for _, h := range q.From {
			if strings.HasPrefix(strings.ToLower(p.Handle), h) {
				ids = append(ids, p.ID)
				break
			}
		}
	}
	return ids
}

// visibleSQL is the condition that a message is in one of the conversations, above that conversation's floor.
func visibleSQL(convs []Visible) string {
	var open, parts []string
	for _, v := range convs {
		if v.Floor == 0 {
			open = append(open, strconv.FormatInt(v.ID, 10))
			continue
		}
		parts = append(parts, "(e.conversation_id = "+strconv.FormatInt(v.ID, 10)+" AND e.message_id > "+strconv.FormatInt(v.Floor, 10)+")")
	}
	if len(open) > 0 {
		parts = append(parts, "e.conversation_id IN ("+strings.Join(open, ",")+")")
	}
	return "(" + strings.Join(parts, " OR ") + ")"
}

func intList(ids []int64) string {
	s := make([]string, len(ids))
	for i, id := range ids {
		s[i] = strconv.FormatInt(id, 10)
	}
	return strings.Join(s, ",")
}

// Titles are the visible conversations whose title the query names, in the order of scope.Visible (latest activity first):
// every word of the query starts a word of the title, and the in: and is:starred filters hold. A filter that is about
// messages (is:ask, is:pinned, is:app, has:file, has:link, from:) leaves none, and a query of no word and no conversation
// filter names none.
func Titles(q Query, sc Scope) []Visible {
	if q.Ask || q.Pinned || q.App || q.File || q.Link || len(q.From) > 0 {
		return nil
	}
	words := q.words()
	if len(words) == 0 && len(q.In) == 0 && !q.Starred {
		return nil
	}
	var out []Visible
	for _, v := range q.conversations(sc) {
		if startsWords(wordsOf(v.Title), words) {
			out = append(out, v)
		}
	}
	return out
}

// startsWords reports whether every wanted word starts one of the title's words.
func startsWords(title, wanted []string) bool {
	for _, w := range wanted {
		found := false
		for _, t := range title {
			if strings.HasPrefix(t, w) {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}
