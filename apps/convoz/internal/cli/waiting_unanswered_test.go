package cli

import (
	"net/http"
	"strings"
	"testing"
)

func TestWaitingNamesAnUntitledChatByItsMembersAndEndsWithItsLink(t *testing.T) {
	var host string
	run := agentRun(t, func(w http.ResponseWriter, r *http.Request) {
		host = r.Host
		_, _ = w.Write([]byte(`{"now":1,"asks":[],"plans":[],"unread":[],"unanswered":[` +
			`{"conversation":{"id":5,"title":null},"message_id":9,"excerpt":"any news","created_at":1,"age_ms":660000,"members":["alpha","docs"]},` +
			`{"conversation":{"id":6,"title":"Launch"},"message_id":12,"excerpt":"ship it","created_at":1,"age_ms":660000,"members":["alpha"]}]}`))
	})
	code, stdout, stderr := run(Waiting)
	if code != ExitOK {
		t.Fatalf("exit %d stderr %q", code, stderr)
	}
	lines := strings.Split(strings.TrimSpace(stdout), "\n")
	if len(lines) != 2 {
		t.Fatalf("stdout %q, want two lines", stdout)
	}
	if !strings.Contains(lines[0], "@alpha @docs (5)") || !strings.HasSuffix(lines[0], "http://"+host+"/chats/5#m9") {
		t.Errorf("untitled chat line %q, want its handles and a link", lines[0])
	}
	if !strings.Contains(lines[1], "Launch (6)") || !strings.HasSuffix(lines[1], "http://"+host+"/chats/6#m12") {
		t.Errorf("titled chat line %q, want its title and a link", lines[1])
	}
}
