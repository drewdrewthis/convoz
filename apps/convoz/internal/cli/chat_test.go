package cli

import (
	"bytes"
	"slices"
	"strings"
	"testing"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

func quietIO() (IO, *bytes.Buffer) {
	var stderr bytes.Buffer
	return IO{Stdin: strings.NewReader(""), Stdout: &bytes.Buffer{}, Stderr: &stderr, Getenv: func(string) string { return "" }}, &stderr
}

func TestFlagsMayComeBeforeBetweenAndAfterPositionals(t *testing.T) {
	io, _ := quietIO()
	for _, args := range [][]string{
		{"--format", "plain", "41", "hello"},
		{"41", "--format", "plain", "hello"},
		{"41", "hello", "--format", "plain"},
		{"41", "hello", "--format=plain"},
	} {
		f := newChatFlags("post", io)
		format := f.fs.String("format", "", "")
		pos, ok := f.parse(args, io)
		if !ok || !slices.Equal(pos, []string{"41", "hello"}) || *format != "plain" {
			t.Errorf("%v: pos=%v ok=%v format=%q", args, pos, ok, *format)
		}
	}
}

func TestDoubleDashEndsTheFlagsSoAMessageMayStartWithADash(t *testing.T) {
	io, _ := quietIO()
	f := newChatFlags("post", io)
	pos, ok := f.parse([]string{"--json", "41", "--", "-not-a-flag", "--format"}, io)
	if !ok || !slices.Equal(pos, []string{"41", "-not-a-flag", "--format"}) || !*f.asJSON {
		t.Errorf("pos=%v ok=%v json=%v", pos, ok, *f.asJSON)
	}
}

func TestABadFlagIsAUsageErrorWithTheConvozPrefix(t *testing.T) {
	io, stderr := quietIO()
	f := newChatFlags("read", io)
	if _, ok := f.parse([]string{"41", "--nope"}, io); ok {
		t.Fatal("an unknown flag is refused")
	}
	if got := stderr.String(); !strings.HasPrefix(got, "convoz: ") || strings.Count(got, "\n") != 1 {
		t.Errorf("one line that starts with the program name: %q", got)
	}
}

func TestPlainTextDropsControlCharactersButKeepsNewlineAndTab(t *testing.T) {
	in := "ok\x1b[31mred\x1b]0;title\x07 tab\there\nnext\x00\x7f\u0085\u009b end\r"
	want := "ok[31mred]0;title tab\there\nnext end"
	if got := plain(in); got != want {
		t.Errorf("plain(%q) = %q, want %q", in, got, want)
	}
	if got := plain("héllo wörld ✓"); got != "héllo wörld ✓" {
		t.Errorf("text with accents and symbols is untouched: %q", got)
	}
}

func TestPlainTextDropsUnicodeFormatCharacters(t *testing.T) {
	in := "a\u202eb\u200bc\u200fd\u2066e\u2069f\u200dg"
	if got := plain(in); got != "abcdefg" {
		t.Errorf("plain(%q) = %q, want the format characters gone", in, got)
	}
}

func TestAnInboxLineShowsNoControlCharacters(t *testing.T) {
	title := "t"
	it := wire.InboxItem{ID: 3, ClaimToken: "ab", Reason: "activity", Count: 1, Conversation: wire.InboxConversation{ID: 4, Title: &title},
		Message: wire.Message{ID: 9, Author: wire.Person{Handle: "drew"}, Body: "hi\x1b[2J there\nsecond line"}}
	got := itemLine(it)
	if strings.ContainsAny(got, "\x1b\n") || !strings.HasSuffix(got, "@drew: hi[2J there") {
		t.Errorf("one clean line: %q", got)
	}
}
