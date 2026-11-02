package ownerline_test

import (
	"testing"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/ownerline"
)

func TestCheck(t *testing.T) {
	for _, tc := range []struct{ name, text, why string }{
		{"plain order", "Approve the prod deploy of PR 240.", ""},
		{"no final stop", "Pick the color for the button", ""},
		{"question", "Which color do you want for the button?", ""},
		{"e.g.", "Pick a color, e.g. blue or green, for the button.", ""},
		{"i.e. and vs.", "Choose A vs. B for the plan, i.e. the cheap one.", ""},
		{"version number", "Upgrade the agent to v1.2 before Friday.", ""},
		{"link is no word", "Open https://example.com/a/b and sign off", ""},
		{"too short", "Approve it", "has fewer than 3 words"},
		{"words left after PR and #N", "Review PR 240 #12", "has fewer than 3 words"},
		{"empty", "", "has fewer than 3 words"},
		{"line break", "Approve the deploy\nand the tag", "has a line break"},
		{"two sentences", "Approve the deploy. Then tag the release.", "is more than one sentence"},
		{"two sentences with question", "Is this fine? Tell me yes or no.", "is more than one sentence"},
		{"backtick", "Run `make deploy` on the box", "uses markdown"},
		{"bold", "Approve the **prod** deploy now", "uses markdown"},
		{"md link", "Read [the plan](http://x.y) and approve", "uses markdown"},
		{"heading", "# Approve the prod deploy", "uses markdown"},
		{"bullet", "- Approve the prod deploy", "uses markdown"},
		{"star bullet", "* Approve the prod deploy", "uses markdown"},
		{"status waiting", "Waiting for you to approve the deploy", "starts with a status word"},
		{"status FYI", "FYI the deploy is done and fine", "starts with a status word"},
		{"status blocked", "blocked on your approval of deploy", "starts with a status word"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := ownerline.Check(tc.text); got != tc.why {
				t.Fatalf("Check(%q) = %q, want %q", tc.text, got, tc.why)
			}
		})
	}
}
