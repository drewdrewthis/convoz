package inbox_test

import (
	"fmt"
	"strings"
	"testing"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/inbox"
)

func manyConversations(n int) []inbox.BriefConversation {
	out := make([]inbox.BriefConversation, n)
	for i := range out {
		out[i] = inbox.BriefConversation{ID: int64(n - i), Title: fmt.Sprintf("Topic %d with a rather long title to use the budget %s", n-i, strings.Repeat("x", 80)), Unread: 3, LastBy: "drew", Last: strings.Repeat("word ", 40)}
	}
	return out
}

func TestRender_ListsTenConversationsAndCountsTheRest(t *testing.T) {
	b := inbox.Render(inbox.BriefInput{Handle: "devtool", Conversations: manyConversations(60), MaxBytes: inbox.DefaultBriefBytes, Page: 1})
	conv := b.Sections[5].Text
	if got := strings.Count(conv, "\n- "); got != 10 {
		t.Fatalf("listed %d conversations, want 10:\n%s", got, conv)
	}
	if !strings.HasSuffix(conv, "and 50 more · convoz brief --page 2") {
		t.Fatalf("the section must end with the count of the rest:\n%s", conv)
	}
	if page := inbox.Render(inbox.BriefInput{Handle: "devtool", Conversations: manyConversations(60), MaxBytes: inbox.DefaultBriefBytes, Page: 6}); !strings.Contains(page.Sections[5].Text, "- 10 ") || strings.Contains(page.Sections[5].Text, "more") {
		t.Fatalf("the last page lists the last ten and no count:\n%s", page.Sections[5].Text)
	}
}

func TestRender_HandoffOfFullSizeStaysWholeWithinTheTotal(t *testing.T) {
	note := strings.Repeat("ビルド ", 600)[:4096-2] + "ok" // 4096 bytes, cut on a character boundary
	for len(note) > 4096 {
		note = note[:len(note)-1]
	}
	in := inbox.BriefInput{
		Handle: "devtool", DisplayName: "Devtool", Description: strings.Repeat("d", 80), Capabilities: []string{"go", "ci"}, Session: "claude-code", Machine: "box-2", LiveSessions: 2,
		Handoff:       &inbox.BriefHandoff{Session: "claude-code", Machine: "box-2", Body: note},
		OlderHandoffs: 49,
		Conversations: manyConversations(60),
		MaxBytes:      inbox.DefaultBriefBytes, Page: 1,
	}
	for i := 0; i < 40; i++ {
		in.Answers = append(in.Answers, inbox.BriefAsk{ID: int64(i + 1), Conversation: 1, Title: "T", Question: strings.Repeat("q", 200), Answer: "yes", State: "answered"})
		in.Asks = append(in.Asks, inbox.BriefAsk{ID: int64(i + 100), Conversation: 1, Title: "T", Question: strings.Repeat("q", 200)})
	}
	b := inbox.Render(in)
	if !strings.Contains(b.Text, note) {
		t.Fatal("the handoff note must appear whole")
	}
	if len(b.Text)+1 > inbox.DefaultBriefBytes {
		t.Fatalf("the brief is %d bytes, over %d", len(b.Text)+1, inbox.DefaultBriefBytes)
	}
	if strings.Index(b.Text, "## Last handoff") > strings.Index(b.Text, "## Conversations") || strings.Index(b.Text, "## Open asks") > strings.Index(b.Text, "## Conversations") {
		t.Fatal("the handoff and the asks come before the conversations")
	}
}

func TestRender_SizeIsKeptBetween4And64KB(t *testing.T) {
	if inbox.ClampBriefBytes(10) != inbox.MinBriefBytes || inbox.ClampBriefBytes(200000) != inbox.MaxBriefBytes || inbox.ClampBriefBytes(8000) != 8000 {
		t.Fatal("ClampBriefBytes must bring a size inside 4096 to 65536")
	}
	for _, size := range []int{inbox.MinBriefBytes, 20000, inbox.MaxBriefBytes} {
		b := inbox.Render(inbox.BriefInput{Handle: "devtool", Conversations: manyConversations(60), MaxBytes: size, Page: 1})
		if len(b.Text)+1 > size {
			t.Fatalf("size %d: the brief is %d bytes", size, len(b.Text)+1)
		}
	}
}
