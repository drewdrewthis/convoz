package httpapi

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/notify"
)

// Owner (Drew, msg 144): "This is when I clicked on the notification" - an ask push opened /now, which the server answers 404.
// A tapped push must land on a page the server serves, for every reason a push is sent for.
func TestEveryPushOpensAPageTheServerServes(t *testing.T) {
	pages := http.NewServeMux()
	for _, r := range Routes {
		if r.Page && r.Method == http.MethodGet {
			pages.HandleFunc("GET "+muxPattern(r.Pattern), func(http.ResponseWriter, *http.Request) {})
		}
	}
	reasons := []string{
		notify.ReasonAsk, notify.ReasonAskUrgent, notify.ReasonSnoozeWake, notify.ReasonAgentAdd, notify.ReasonMention,
		notify.ReasonThreadReply, notify.ReasonPaused, notify.ReasonMachineRequest, notify.ReasonSecurity, notify.ReasonTest,
	}
	for _, reason := range reasons {
		for _, conversation := range []int64{0, 41} {
			url := notify.URLFor(reason, conversation, 7)
			if !strings.HasPrefix(url, "/") {
				t.Errorf("%s (conversation %d): %q is not a path", reason, conversation, url)
				continue
			}
			req := httptest.NewRequest(http.MethodGet, url, nil)
			if _, pattern := pages.Handler(req); pattern == "" {
				t.Errorf("%s (conversation %d): push URL %q is not a page route", reason, conversation, url)
			}
		}
	}
}
