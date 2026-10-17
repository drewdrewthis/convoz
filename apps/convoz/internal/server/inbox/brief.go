package inbox

import (
	"fmt"
	"strings"
	"time"
	"unicode/utf8"
)

// Brief sizes in bytes (design §3.8, M7). The sections share the default; a larger or smaller --max-bytes scales every budget.
const (
	DefaultBriefBytes = 12288
	MinBriefBytes     = 4096
	MaxBriefBytes     = 65536
	// BriefPageSize is how many conversations one page of section 6 lists.
	BriefPageSize = 10
	// briefTopItems is how many inbox items section 5 lists.
	briefTopItems = 5
)

// budgets are the default budgets of sections 1 to 8, in the order the brief prints them.
var budgets = [8]int{512, 4096, 1536, 1024, 1024, 2560, 1024, 512}

// ClampBriefBytes keeps a requested size inside what a brief may be.
func ClampBriefBytes(n int) int { return min(max(n, MinBriefBytes), MaxBriefBytes) }

// BriefHandoff is the last handoff note and where it came from.
type BriefHandoff struct {
	At      int64
	Session string
	Machine string
	Body    string
}

// BriefAsk is one ask in section 3, 4 or 7.
type BriefAsk struct {
	ID           int64
	Conversation int64
	Title        string
	Question     string
	Answer       string
	State        string
	Urgent       bool
	At           int64 // when it was answered (sections 3 and 7)
	SnoozedUntil int64
}

// BriefItem is one waiting inbox item in section 5.
type BriefItem struct {
	ID           int64
	Reason       string
	Conversation int64
	Title        string
	Count        int64
}

// BriefConversation is one conversation with unread messages for the identity.
type BriefConversation struct {
	ID     int64
	Title  string
	Unread int64
	LastBy string
	Last   string
	Capped bool // the unread count stopped at its cap
}

// BriefExpired is the items of one conversation that expired unread.
type BriefExpired struct {
	Conversation int64
	Title        string
	Count        int64
	Since        int64
}

// BriefInput is everything a brief says. The composition root fills it from the modules, each answer already limited to what
// the identity may see (I-6); Render only lays it out.
type BriefInput struct {
	Handle, DisplayName, Description string
	Capabilities                     []string
	Session, Machine                 string
	LiveSessions                     int64
	Handoff                          *BriefHandoff
	OlderHandoffs                    int64
	Answers, Asks, Decisions         []BriefAsk
	InboxByReason                    map[string]int64
	InboxTotal                       int64
	InboxTop                         []BriefItem
	// Conversations are the ones with unread messages, newest activity first.
	Conversations []BriefConversation
	Expired       []BriefExpired
	MaxBytes      int
	Page          int
}

// BriefSection is one titled part of the brief; Text includes the title line.
type BriefSection struct {
	Key   string `json:"key"`
	Title string `json:"title"`
	Text  string `json:"text"`
}

// Brief is the rendered brief: the sections and the text they make together.
type Brief struct {
	Sections []BriefSection
	Text     string
}

var reasonOrder = []string{"mention", "thread", "activity", "ask_resolved", "membership", "app_result"}

// ReasonRank orders the reasons of inbox items for section 5: the lower, the sooner it is listed.
func ReasonRank(reason string) int {
	for i, r := range reasonOrder {
		if r == reason {
			return i
		}
	}
	return len(reasonOrder)
}

// Render lays the brief out within MaxBytes. The handoff and the asks come first and are not cut by the conversations; the
// conversation section takes what the others left (then the decisions), and lists ten conversations a page.
func Render(in BriefInput) Brief {
	total := ClampBriefBytes(in.MaxBytes)
	budget := func(i int) int { return budgets[i] * total / DefaultBriefBytes }
	page := max(in.Page, 1)

	secs := make([]BriefSection, 8)
	secs[0] = BriefSection{"identity", "Who you are", identitySection(in, budget(0))}
	secs[1] = BriefSection{"handoff", "Last handoff", handoffSection(in)}
	secs[2] = BriefSection{"answers", "Answers waiting", askSection("## Answers waiting (not acked yet)", "No answers waiting.", in.Answers, budget(2), true)}
	secs[3] = BriefSection{"asks", "Open asks", askSection("## Open asks", "No open asks.", in.Asks, budget(3), false)}
	secs[4] = BriefSection{"inbox", "Inbox", inboxSection(in, budget(4))}
	secs[7] = BriefSection{"expired", "Expired", expiredSection(in.Expired, budget(7))}

	spare := 0 // what the sections before the conversations did not use
	for _, i := range []int{0, 1, 2, 3, 4, 7} {
		spare += budget(i) - len(secs[i].Text) - 1
	}
	secs[5] = BriefSection{"conversations", "Conversations with unread messages", convSection(in.Conversations, page, budget(5)+spare)}
	spare += budget(5) - len(secs[5].Text) - 1
	secs[6] = BriefSection{"decisions", "Recent decisions", askSection("## Recent decisions (last 7 days)", "No recent decisions.", in.Decisions, budget(6)+max(spare, 0), true)}

	for i := range secs {
		secs[i].Title = titleOf(secs[i].Text)
	}
	text := strings.Join(sectionTexts(secs), "\n")
	if len(text)+1 > total { // only a handoff of the full 4096 bytes at the smallest size gets here
		text = cutBytes(text, total-1)
	}
	return Brief{Sections: secs, Text: text}
}

func sectionTexts(secs []BriefSection) []string {
	out := make([]string, len(secs))
	for i, s := range secs {
		out[i] = s.Text
	}
	return out
}

func titleOf(text string) string {
	first, _, _ := strings.Cut(text, "\n")
	return strings.TrimSpace(strings.TrimLeft(first, "# "))
}

func identitySection(in BriefInput, budget int) string {
	name := "@" + in.Handle
	if in.DisplayName != "" {
		name = fmt.Sprintf("%s (@%s)", oneLine(in.DisplayName), in.Handle)
	}
	lines := []string{"## Who you are", "You are " + name + "."}
	if in.Description != "" {
		lines = append(lines, oneLine(in.Description))
	}
	if len(in.Capabilities) > 0 {
		lines = append(lines, "Capabilities: "+oneLine(strings.Join(in.Capabilities, ", ")))
	}
	lines = append(lines, fmt.Sprintf("This session: %s on machine %s. Live sessions of you: %d.", oneLine(in.Session), oneLine(in.Machine), in.LiveSessions))
	return clip(strings.Join(lines, "\n"), budget-1)
}

// handoffSection is never cut: a note is at most 4096 bytes, so it fits the section whole (M7).
func handoffSection(in BriefInput) string {
	if in.Handoff == nil {
		return "## Last handoff\nNo handoff note yet. Leave one with: convoz handoff \"<note>\""
	}
	h := in.Handoff
	head := fmt.Sprintf("## Last handoff (%s, session %s on %s)", stamp(h.At), oneLine(h.Session), oneLine(h.Machine))
	out := head + "\n" + h.Body
	if in.OlderHandoffs > 0 {
		noun := "notes"
		if in.OlderHandoffs == 1 {
			noun = "note"
		}
		out += fmt.Sprintf("\n(%d older %s: convoz handoff --list)", in.OlderHandoffs, noun)
	}
	return out
}

func askLine(a BriefAsk, withAnswer bool) string {
	var b strings.Builder
	fmt.Fprintf(&b, "- ask #%d in %s (%d): %s", a.ID, quoted(a.Title, 60), a.Conversation, clip(oneLine(a.Question), 120))
	switch {
	case withAnswer && a.State == "dismissed":
		b.WriteString(" -> dismissed")
	case withAnswer && a.Answer != "":
		b.WriteString(" -> " + clip(oneLine(a.Answer), 100))
	}
	if a.Urgent {
		b.WriteString(" [urgent]")
	}
	if a.SnoozedUntil > 0 {
		b.WriteString(" [snoozed until " + stamp(a.SnoozedUntil) + "]")
	}
	return clip(b.String(), 300)
}

func askSection(title, none string, asks []BriefAsk, budget int, withAnswer bool) string {
	if len(asks) == 0 {
		return title + "\n" + none
	}
	lines := make([]string, len(asks))
	for i, a := range asks {
		lines[i] = askLine(a, withAnswer)
	}
	return fit(title, lines, budget-1, len(lines), func(k int) string { return fmt.Sprintf("and %d more", k) })
}

func inboxSection(in BriefInput, budget int) string {
	const title = "## Inbox"
	if in.InboxTotal == 0 {
		return title + "\nNothing waiting."
	}
	var parts []string
	for _, r := range reasonOrder {
		if n := in.InboxByReason[r]; n > 0 {
			parts = append(parts, fmt.Sprintf("%s %d", r, n))
		}
	}
	lines := []string{fmt.Sprintf("%d items waiting: %s", in.InboxTotal, strings.Join(parts, ", "))}
	for _, it := range in.InboxTop[:min(len(in.InboxTop), briefTopItems)] {
		line := fmt.Sprintf("- %s x%d", it.Reason, it.Count)
		if it.Conversation != 0 {
			line = fmt.Sprintf("- conversation %d %s: %s x%d", it.Conversation, quoted(it.Title, 60), it.Reason, it.Count)
		}
		lines = append(lines, clip(line, 160))
	}
	if rest := int(in.InboxTotal) - min(len(in.InboxTop), briefTopItems); rest > 0 {
		lines = append(lines, fmt.Sprintf("and %d more", rest))
	}
	return clip(title+"\n"+strings.Join(lines, "\n"), budget-1)
}

// convSection lists one page of conversations with unread messages. The brief moves no marker, so a conversation that was
// not shown (or not read) is listed again by the next brief until the agent reads it with convoz read.
func convSection(all []BriefConversation, page, budget int) string {
	title := fmt.Sprintf("## Conversations with unread messages (page %d)", page)
	if len(all) == 0 {
		return title + "\nNo unread messages."
	}
	start := (page - 1) * BriefPageSize
	if start >= len(all) {
		return title + fmt.Sprintf("\nNo more conversations. There are %d in all.", len(all))
	}
	end := min(start+BriefPageSize, len(all))
	lines := make([]string, 0, end-start)
	for _, c := range all[start:end] {
		unread := fmt.Sprint(c.Unread)
		if c.Capped {
			unread += "+"
		}
		line := fmt.Sprintf("- %d %s: %s unread", c.ID, quoted(c.Title, 60), unread)
		if c.Last != "" {
			line += fmt.Sprintf("; last @%s: %s", c.LastBy, clip(oneLine(c.Last), 100))
		}
		lines = append(lines, clip(line, 250))
	}
	return fit(title, lines, budget-1, len(all)-start, func(k int) string { return fmt.Sprintf("and %d more · convoz brief --page %d", k, page+1) })
}

func expiredSection(groups []BriefExpired, budget int) string {
	const title = "## Expired unread"
	if len(groups) == 0 {
		return title + "\nNothing expired."
	}
	var count, since int64
	for _, g := range groups {
		count += g.Count
		if since == 0 || g.Since < since {
			since = g.Since
		}
	}
	noun := "items"
	if count == 1 {
		noun = "item"
	}
	lines := []string{fmt.Sprintf("%d %s expired unread since %s", count, noun, time.UnixMilli(since).UTC().Format("2006-01-02"))}
	for _, g := range groups {
		lines = append(lines, clip(fmt.Sprintf("- conversation %d %s: %d", g.Conversation, quoted(g.Title, 60), g.Count), 160))
	}
	return fit(title, lines, budget-1, len(lines), func(k int) string { return fmt.Sprintf("and %d more conversations", k) })
}

// fit prints the title and as many lines as the budget allows, always leaving room for the "and K more" line when lines are
// left out. remaining is how many items exist from the first line on; more says how many are not shown.
func fit(title string, lines []string, budget, remaining int, more func(int) string) string {
	out := []string{title}
	used := len(title)
	shown := 0
	for i, l := range lines {
		reserve := 0
		if left := remaining - (i + 1); left > 0 {
			reserve = len(more(left)) + 1
		}
		if used+1+len(l)+reserve > budget {
			break
		}
		out = append(out, l)
		used += 1 + len(l)
		shown++
	}
	if left := remaining - shown; left > 0 {
		out = append(out, more(left))
	}
	return strings.Join(out, "\n")
}

func stamp(ms int64) string { return time.UnixMilli(ms).UTC().Format("2006-01-02 15:04 UTC") }

func quoted(title string, max int) string {
	if title == "" {
		return "(no title)"
	}
	return `"` + clip(oneLine(title), max) + `"`
}

// oneLine puts a text on one line: any run of white space becomes one space.
func oneLine(s string) string { return strings.Join(strings.Fields(s), " ") }

// clip cuts s to at most n bytes at a character boundary and marks the cut.
func clip(s string, n int) string {
	if len(s) <= n || n < 4 {
		return cutBytes(s, max(n, 0))
	}
	return cutBytes(s, n-len("…")) + "…"
}

func cutBytes(s string, n int) string {
	if len(s) <= n {
		return s
	}
	for n > 0 && !utf8.RuneStart(s[n]) {
		n--
	}
	return s[:n]
}
