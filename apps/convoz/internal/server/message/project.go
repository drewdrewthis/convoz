package message

import (
	"fmt"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"
)

// The one plain-text form of a message (docs/messages-apps-spec.md §2.3, E-21). It feeds the rail preview, push bodies, the
// search index, `convoz read` and the screen-reader label of a collapsed card. packages/markdown/src/project.ts is its twin;
// both run packages/contracts/fixtures/projection/*.json (AC-M1), so a change here is a change there.

// Lengths of the two forms.
const (
	ShortRunes = 140
	LongRunes  = 4000
)

// Form picks the short or the long projection.
type Form string

// The two forms.
const (
	Short Form = "short"
	Long  Form = "long"
)

// Person is a name as the projection prints it: "@handle", with the display name before it when that is more than the handle.
type Person struct {
	Handle string `json:"handle"`
	Name   string `json:"name"`
}

// Upload is a file a message carries, for the forms of voice, image and file messages.
type Upload struct {
	Kind       string `json:"kind"` // audio, image or file
	Name       string `json:"name"`
	Size       int64  `json:"size"`
	DurationMS int64  `json:"duration_ms"`
}

// Option is one answer an ask offers.
type Option struct {
	Label string `json:"label"`
	Why   string `json:"why"`
}

// Projectable is everything Project reads. The caller fills what the message has; the variant is derived from it in the
// fixed order of the spec (deleted, system, ask, answer, via_app, app, voice, image, file, text).
type Projectable struct {
	Deleted bool           `json:"deleted"`
	System  *ProjectSystem `json:"system"`
	Ask     *ProjectAsk    `json:"ask"`
	Answer  *ProjectAnswer `json:"answer"`
	ViaApp  *Person        `json:"via_app"`
	App     *ProjectApp    `json:"app"`
	Format  string         `json:"format"` // markdown, markdownv2 or plain
	Body    string         `json:"body"`
	Uploads []Upload       `json:"uploads"`
	// Transcript is the voice note's words; empty while pending or when it failed.
	Transcript string `json:"transcript"`
	Reply      bool   `json:"reply"` // a thread reply, also a broadcast one: the short form starts with an arrow
}

// ProjectSystem is a system line with its names looked up.
type ProjectSystem struct {
	T        string
	Identity Person
	By       Person
	History  string
	Streak   int
	Title    string // conversation.renamed: the title the line quotes
	From     string // member.renamed: the handle before
	To       string // member.renamed: the handle after
	Done     string // plan.changed: the items the line quotes
	Now      string
	Waiting  string
	Liveness string // agent.unresponsive: not_responding or logged_out
}

// ProjectAsk is an ask.
type ProjectAsk struct {
	Question string   `json:"question"`
	Options  []Option `json:"options"` // the first is the recommended one
}

// ProjectAnswer is the answer to an ask: the option's label, or the person's own words.
type ProjectAnswer struct {
	Custom bool   `json:"custom"`
	Text   string `json:"text"`
}

// ProjectApp is the fallback an app message carries.
type ProjectApp struct {
	Title    string `json:"title"`
	Fallback string `json:"fallback"`
}

// Ref prints a person: "@handle", or "Name @handle" when the display name says more than the handle.
func (p Person) Ref() string {
	if p.Name == "" || strings.EqualFold(p.Name, p.Handle) {
		return "@" + p.Handle
	}
	return p.Name + " @" + p.Handle
}

// Project turns a message into its plain text in the given form.
func Project(m Projectable, form Form) string {
	var text string
	switch {
	case m.Deleted:
		text = "Message deleted"
	case m.System != nil:
		text = systemText(*m.System)
	case m.Ask != nil:
		text = askText(*m.Ask, form)
	case m.Answer != nil:
		text = answerText(*m.Answer)
	case m.ViaApp != nil:
		text = trim(textOf(m)) + " (via app by " + m.ViaApp.Ref() + ")"
	case m.App != nil:
		text = appText(m, form)
	case len(m.Uploads) == 1 && m.Uploads[0].Kind == "audio":
		text = voiceText(m, form)
	case len(m.Uploads) > 0 && allKind(m.Uploads, "image"):
		text = uploadsText(m, form, "Image", "image", "images")
	case len(m.Uploads) > 0:
		text = uploadsText(m, form, "File", "file", "files")
	default:
		text = textOf(m)
	}
	if m.Reply && form == Short && !m.Deleted {
		text = "↳ " + text
	}
	return cut(clean(text, form), form)
}

// trim is JavaScript's trim(), so the web twin cuts the same.
func trim(s string) string { return strings.TrimFunc(s, isSpace) }

func allKind(list []Upload, kind string) bool {
	for _, u := range list {
		if u.Kind != kind {
			return false
		}
	}
	return true
}

func systemText(s ProjectSystem) string {
	switch s.T {
	case "member.added":
		if s.History == "full" {
			return "Added " + s.Identity.Ref() + " · full history"
		}
		return "Added " + s.Identity.Ref()
	case "member.requested":
		return s.By.Ref() + " wants to add " + s.Identity.Ref()
	case "member.approved":
		return "Approved · " + s.Identity.Ref() + " added"
	case "member.declined":
		return "Declined · " + s.Identity.Ref() + " not added"
	case "member.removed":
		return s.Identity.Ref() + " was removed"
	case "member.left":
		return s.Identity.Ref() + " left"
	case "member.disabled":
		return s.Identity.Ref() + " was disabled"
	case "member.renamed":
		return "@" + s.From + " is now @" + s.To
	case "conversation.renamed":
		if s.Title != "" {
			return s.By.Ref() + " renamed this to \"" + s.Title + "\""
		}
		return s.By.Ref() + " renamed the conversation"
	case "conversation.paused":
		return fmt.Sprintf("Paused after %d agent messages in a row. Resume to let agents post.", s.Streak)
	case "conversation.resumed":
		return s.By.Ref() + " resumed the conversation"
	case "conversation.restored":
		return s.By.Ref() + " restored this conversation from Trash"
	case "plan.changed":
		text := s.Identity.Ref()
		for _, part := range [][2]string{{"Done: ", s.Done}, {"Now: ", s.Now}, {"Waiting on you: ", s.Waiting}} {
			if part[1] != "" {
				text += " · " + part[0] + part[1]
			}
		}
		return text
	case "agent.unresponsive":
		if s.Liveness == "logged_out" {
			return s.Identity.Ref() + " is logged out"
		}
		return s.Identity.Ref() + " is not responding"
	}
	return ""
}

func askText(a ProjectAsk, form Form) string {
	if form == Short {
		return "Ask: " + a.Question
	}
	lines := []string{"Ask: " + a.Question}
	for i, o := range a.Options {
		mark, label := "-", o.Label
		if i == 0 {
			mark, label = "*", o.Label+" (recommended)"
		}
		lines = append(lines, mark+" "+label+" — "+o.Why)
	}
	return strings.Join(lines, "\n")
}

func answerText(a ProjectAnswer) string {
	if a.Custom {
		return "Replied: " + a.Text
	}
	return "Answered: " + a.Text
}

func appText(m Projectable, form Form) string {
	if form == Short {
		return "App: " + m.App.Title + " — " + m.App.Fallback
	}
	card := "[App: " + m.App.Title + "] " + m.App.Fallback
	if body := trim(textOf(m)); body != "" {
		return body + "\n" + card
	}
	return card
}

func clock(ms int64) string {
	s := ms / 1000
	return fmt.Sprintf("%d:%02d", s/60, s%60)
}

func voiceText(m Projectable, form Form) string {
	t := clock(m.Uploads[0].DurationMS)
	if form == Short {
		return "Voice note · " + t
	}
	if m.Transcript != "" {
		return "Voice note " + t + ": " + m.Transcript
	}
	return "Voice note " + t
}

func uploadsText(m Projectable, form Form, label, one, many string) string {
	if form == Short {
		if len(m.Uploads) == 1 {
			return label + " · " + m.Uploads[0].Name
		}
		return fmt.Sprintf("%d %s", len(m.Uploads), many)
	}
	caption := trim(textOf(m))
	var tag string
	switch {
	case len(m.Uploads) > 1:
		tag = fmt.Sprintf("[%d %s]", len(m.Uploads), many)
	case label == "File":
		tag = "[File: " + m.Uploads[0].Name + ", " + sizeText(m.Uploads[0].Size) + "]"
	default:
		tag = "[Image: " + m.Uploads[0].Name + "]"
	}
	return trim(caption + " " + tag)
}

func sizeText(n int64) string {
	switch {
	case n >= 1<<20:
		return fmt.Sprintf("%d MB", (n+(1<<19))>>20)
	case n >= 1<<10:
		return fmt.Sprintf("%d KB", (n+(1<<9))>>10)
	}
	return fmt.Sprintf("%d B", n)
}

var (
	pImage     = regexp.MustCompile(`!\[[^\[\]\n]*\]\([^() \t\n]+\)`)
	pLink      = regexp.MustCompile(`\[([^\[\]\n]+)\]\(([^() \t\n]+)\)`)
	pCode      = regexp.MustCompile("`([^`\\n]+)`")
	pBold      = regexp.MustCompile(`\*\*([^*\n]+)\*\*`)
	pItalic    = regexp.MustCompile(`\*([^* \t\n](?:[^*\n]*[^* \t\n])?)\*`)
	pStrike    = regexp.MustCompile(`~~([^~\n]+)~~`)
	pSpoiler   = regexp.MustCompile(`\|\|[^|\n]+\|\|`)
	pHeading   = regexp.MustCompile(`^[ \t]{0,3}#{1,6}[ \t]+`)
	pQuote     = regexp.MustCompile(`^[ \t]{0,3}>[ \t]?`)
	pBullet    = regexp.MustCompile(`^[ \t]{0,3}[-*+][ \t]+`)
	pFence     = regexp.MustCompile("^[ \t]{0,3}```")
	pHost      = regexp.MustCompile(`^https?://(?:[^/?#@]*@)?([^/?#:]+)`)
	pBlankRuns = regexp.MustCompile(`\n{3,}`)
)

// textOf is the body of a text message with its markers stripped, by format.
func textOf(m Projectable) string {
	switch m.Format {
	case "plain":
		return m.Body
	case "markdownv2":
		return v2Text(m.Body)
	}
	return mdText(m.Body)
}

func mdText(body string) string {
	lines := strings.Split(strings.ReplaceAll(strings.ReplaceAll(body, "\r\n", "\n"), "\r", "\n"), "\n")
	out := make([]string, 0, len(lines))
	inFence := false
	for _, line := range lines {
		if pFence.MatchString(line) {
			inFence = !inFence
			continue
		}
		if inFence {
			out = append(out, line)
			continue
		}
		line = pHeading.ReplaceAllString(line, "")
		line = pQuote.ReplaceAllString(line, "")
		line = pBullet.ReplaceAllString(line, "- ")
		line = pImage.ReplaceAllString(line, "[image]")
		line = pLink.ReplaceAllStringFunc(line, linkText)
		line = pCode.ReplaceAllString(line, "$1")
		line = pBold.ReplaceAllString(line, "$1")
		line = pItalic.ReplaceAllString(line, "$1")
		line = pStrike.ReplaceAllString(line, "$1")
		line = pSpoiler.ReplaceAllString(line, "[spoiler]")
		out = append(out, line)
	}
	return strings.Join(out, "\n")
}

// linkText is "text (host)" for a web link, and the text alone for any other.
func linkText(m string) string {
	parts := pLink.FindStringSubmatch(m)
	if h := pHost.FindStringSubmatch(parts[2]); h != nil {
		return parts[1] + " (" + strings.ToLower(h[1]) + ")"
	}
	return parts[1]
}

// v2Text strips MarkdownV2 markers: styles, code, escapes and quotes. A link keeps its text and host like markdown's.
func v2Text(body string) string {
	lines := strings.Split(strings.ReplaceAll(strings.ReplaceAll(body, "\r\n", "\n"), "\r", "\n"), "\n")
	out := make([]string, 0, len(lines))
	inFence := false
	for _, line := range lines {
		if pFence.MatchString(line) {
			if !onePre.MatchString(line) {
				inFence = !inFence
				continue
			}
			out = append(out, trim(strings.TrimSuffix(strings.TrimPrefix(trim(line), "```"), "```")))
			continue
		}
		if inFence {
			out = append(out, line)
			continue
		}
		out = append(out, v2Line(pQuote.ReplaceAllString(line, "")))
	}
	return strings.Join(out, "\n")
}

func v2Line(text string) string {
	var buf strings.Builder
	for i := 0; i < len(text); {
		rest := text[i:]
		if rest[0] == '\\' && len(rest) > 1 && isASCIIPunct(rest[1]) {
			buf.WriteByte(rest[1])
			i += 2
			continue
		}
		if n := v2Code.FindString(rest); n != "" {
			buf.WriteString(n[1 : len(n)-1])
			i += len(n)
			continue
		}
		if n := v2Link.FindString(rest); n != "" {
			buf.WriteString(linkText(n))
			i += len(n)
			continue
		}
		matched := false
		for k, re := range v2Styles {
			if m := re.FindStringSubmatch(rest); m != nil {
				if k == 0 {
					buf.WriteString("[spoiler]")
				} else {
					buf.WriteString(unescape(m[1]))
				}
				i += len(m[0])
				matched = true
				break
			}
		}
		if !matched {
			buf.WriteByte(rest[0])
			i++
		}
	}
	return buf.String()
}

// clean drops format characters (bidi controls, zero width) so a body cannot disguise a line, and tidies the lines.
func clean(text string, form Form) string {
	text = strings.Map(func(r rune) rune {
		if unicode.Is(unicode.Cf, r) {
			return -1
		}
		return r
	}, text)
	if form == Short {
		return strings.Join(strings.FieldsFunc(text, isSpace), " ")
	}
	lines := strings.Split(text, "\n")
	for i, l := range lines {
		lines[i] = strings.TrimRight(l, " \t")
	}
	return trim(pBlankRuns.ReplaceAllString(strings.Join(lines, "\n"), "\n\n"))
}

// isSpace is JavaScript's white space without the format characters clean has already removed, so the twin splits alike.
func isSpace(r rune) bool {
	switch {
	case r == '\t', r == '\n', r == '\v', r == '\f', r == '\r', r == ' ', r == 0xa0, r == 0x1680, r >= 0x2000 && r <= 0x200a,
		r == 0x2028, r == 0x2029, r == 0x202f, r == 0x205f, r == 0x3000:
		return true
	}
	return false
}

func cut(text string, form Form) string {
	n := LongRunes
	if form == Short {
		n = ShortRunes
	}
	if utf8.RuneCountInString(text) <= n {
		return text
	}
	return string([]rune(text)[:n])
}
