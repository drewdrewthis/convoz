package search

import (
	"regexp"
	"strings"
	"unicode"
)

// Query is a search box text split into the words to find and the filters that narrow them (design §13): from:@handle,
// in:"conversation title" (or in:<id>), is:ask, is:pinned, is:starred, is:app, has:file, has:link. A bare @handle is
// from:@handle, as in the prototype.
type Query struct {
	// Terms are the words, as the user typed them: each is a word, or a quoted phrase.
	Terms                                 []string
	From                                  []string // handles, lower case, no @; a handle matches by prefix
	In                                    []string // conversation titles (matched as a part of the title) or ids
	Ask, Pinned, Starred, App, File, Link bool
	// Chips are the filters in the order typed, for the "Active filters" row. Token is the text to take out of the query to
	// remove the filter.
	Chips []Chip
}

// Chip is one active filter.
type Chip struct {
	Token string `json:"token"`
	Label string `json:"label"`
}

// MaxQuery is the longest query text accepted.
const MaxQuery = 200

var (
	tokenRE   = regexp.MustCompile(`(?i)(?:in|from):"[^"]*"|"[^"]*"|\S+`)
	fromRE    = regexp.MustCompile(`^@([a-z0-9-]+)$`)
	fromKeyRE = regexp.MustCompile(`(?i)^from:@?"?([a-z0-9-]*)"?$`)
	inRE      = regexp.MustCompile(`(?i)^in:"?([^"]*)"?$`)
)

// Parse splits the text of the search box. It never fails: what it does not know as a filter is a word.
func Parse(text string) Query {
	var q Query
	for _, tok := range tokenRE.FindAllString(text, -1) {
		low := strings.ToLower(tok)
		switch {
		case fromRE.MatchString(low):
			q.addFrom(tok, fromRE.FindStringSubmatch(low)[1])
		case fromKeyRE.MatchString(tok):
			if h := fromKeyRE.FindStringSubmatch(low)[1]; h != "" { // "from:" alone is still being typed
				q.addFrom(tok, h)
			}
		case strings.HasPrefix(low, "in:"):
			// "in:" alone is still being typed; so is in:"" .
			if m := inRE.FindStringSubmatch(tok); m != nil && strings.TrimSpace(m[1]) != "" {
				v := strings.TrimSpace(m[1])
				q.In = append(q.In, v)
				q.Chips = append(q.Chips, Chip{tok, "in conversation " + v})
			}
		case low == "is:ask":
			q.Ask = true
			q.Chips = append(q.Chips, Chip{tok, "is ask"})
		case low == "is:pinned":
			q.Pinned = true
			q.Chips = append(q.Chips, Chip{tok, "is pinned"})
		case low == "is:starred":
			q.Starred = true
			q.Chips = append(q.Chips, Chip{tok, "is starred"})
		case low == "is:app":
			q.App = true
			q.Chips = append(q.Chips, Chip{tok, "is app"})
		case low == "has:file":
			q.File = true
			q.Chips = append(q.Chips, Chip{tok, "has file"})
		case low == "has:link":
			q.Link = true
			q.Chips = append(q.Chips, Chip{tok, "has link"})
		default:
			q.Terms = append(q.Terms, strings.Trim(tok, `"`))
		}
	}
	return q
}

func (q *Query) addFrom(tok, handle string) {
	q.From = append(q.From, handle)
	q.Chips = append(q.Chips, Chip{tok, "from @" + handle})
}

// Empty reports whether the query asks for nothing: no word and no filter.
func (q Query) Empty() bool { return len(q.words()) == 0 && len(q.Chips) == 0 }

// words are the searchable words of every term: what the tokenizer of the index would see.
func (q Query) words() []string {
	var out []string
	for _, t := range q.Terms {
		out = append(out, wordsOf(t)...)
	}
	return out
}

// wordsOf splits text where the index tokenizer does: at everything that is not a letter or a digit, case folded.
func wordsOf(s string) []string {
	return strings.FieldsFunc(strings.ToLower(s), func(r rune) bool { return !unicode.IsLetter(r) && !unicode.IsDigit(r) })
}

// match is the FTS5 query of the terms, or "" when there is no word to match. Every term is a quoted phrase of its words with
// a prefix star on the last (a search box finds as you type: "ro" finds rollback and router), and the terms must all match.
// Quoting keeps FTS5 syntax typed by the user (AND, NEAR, a colon) from being read as syntax.
func (q Query) match() string {
	var parts []string
	for _, t := range q.Terms {
		if w := wordsOf(t); len(w) > 0 {
			parts = append(parts, `"`+strings.Join(w, " ")+`"*`)
		}
	}
	return strings.Join(parts, " ")
}
