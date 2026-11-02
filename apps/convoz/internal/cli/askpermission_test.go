package cli

import (
	"encoding/json"
	"net/http"
	"reflect"
	"strings"
	"sync"
	"testing"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

// askServer records each POST /api/asks and answers it with ask 7.
type askServer struct {
	mu   sync.Mutex
	made []wire.AskRequest
}

func (s *askServer) handle(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var in wire.AskRequest
	_ = json.NewDecoder(r.Body).Decode(&in)
	s.made = append(s.made, in)
	w.WriteHeader(http.StatusCreated)
	_ = json.NewEncoder(w).Encode(wire.OneAsk{Ask: wire.AskView{ID: 7, ConversationID: in.ConversationID, State: "open"}})
}

func permissionFlags(extra ...string) []string { return permissionFlagsAt("90", extra...) }

// permissionFlagsAt is a permission ask at this confidence, plus extra flags.
func permissionFlagsAt(confidence string, extra ...string) []string {
	base := []string{"--action", "Merge PR 415", "--risk", "Checkout breaks", "--considered", "Hold: costs a day", "--considered", "Squash: loses history", "--confidence", confidence, "41"}
	return append(extra, base...)
}

func TestAskPermissionFlagsSendAPermissionRequest(t *testing.T) {
	var s askServer
	run := agentRunStdin(t, s.handle)

	code, stdout, stderr := run("", Ask, permissionFlags("--undo", "Revert the merge")...)
	if code != ExitOK || strings.TrimSpace(stdout) != "7" || stderr != "" {
		t.Fatalf("exit %d stdout %q stderr %q, want the id on stdout and nothing on stderr", code, stdout, stderr)
	}
	code, _, _ = run("", Ask, permissionFlags("--one-way", "--question", "Merge it?")...)
	if code != ExitOK || len(s.made) != 2 {
		t.Fatalf("one-way: exit %d, %d requests", code, len(s.made))
	}
	want := &wire.AskPermission{Action: "Merge PR 415", Risk: "Checkout breaks", Undo: "Revert the merge", Considered: []string{"Hold: costs a day", "Squash: loses history"}, Confidence: 90}
	if !reflect.DeepEqual(s.made[0].Permission, want) || s.made[0].ConversationID != 41 {
		t.Errorf("request permission = %+v, want %+v in conversation 41", s.made[0].Permission, want)
	}
	if p := s.made[1].Permission; p == nil || !p.OneWay || p.Undo != "" || s.made[1].Question != "Merge it?" {
		t.Errorf("one-way request = %+v question %q, want one_way, no undo and the question", p, s.made[1].Question)
	}
}

func TestAskPermissionConfidenceBelow80IsRefusedOnBothStreamsWithExit2(t *testing.T) {
	for _, level := range []string{"79", "0"} {
		var s askServer
		run := agentRunStdin(t, s.handle)
		code, stdout, stderr := run("", Ask, permissionFlagsAt(level, "--undo", "Revert")...)
		if code != ExitUsage {
			t.Errorf("confidence %s: exit %d, want %d", level, code, ExitUsage)
		}
		for stream, got := range map[string]string{"stdout": stdout, "stderr": stderr} {
			if !strings.Contains(got, wire.GetConfidentFirst) {
				t.Errorf("confidence %s: %s = %q, want the get-confident text", level, stream, got)
			}
		}
		if len(s.made) != 0 {
			t.Errorf("confidence %s: %d asks reached the server, want none", level, len(s.made))
		}
	}
}

func TestAskPermissionConfidence80IsAccepted(t *testing.T) {
	var s askServer
	run := agentRunStdin(t, s.handle)
	if code, _, stderr := run("", Ask, permissionFlagsAt("80", "--undo", "Revert")...); code != ExitOK {
		t.Errorf("exit %d stderr %q, want 0", code, stderr)
	}
}

func TestAskOldFlagsStillMakeADecisionAskAndHintAtTheNewOnes(t *testing.T) {
	var s askServer
	run := agentRunStdin(t, s.handle)
	code, stdout, stderr := run("", Ask, "--question", "Ship it?", "--recommend", "Yes", "--why", "Green", "--alt", "No", "--alt-why", "Wait", "--owners-call", "taste", "--owners-call-why", "Your voice", "41")
	if code != ExitOK || strings.TrimSpace(stdout) != "7" {
		t.Fatalf("exit %d stdout %q", code, stdout)
	}
	if strings.TrimSpace(stderr) != "hint: use --action ... for a permission ask" {
		t.Errorf("stderr = %q, want the one hint line", stderr)
	}
	if len(s.made) != 1 || s.made[0].Permission != nil || s.made[0].Recommended.Label != "Yes" {
		t.Errorf("request = %+v, want a decision ask without a permission", s.made)
	}
}

func TestAskMixingOldOptionFlagsWithActionIsAUsageError(t *testing.T) {
	for _, old := range [][]string{{"--recommend", "Yes"}, {"--why", "Green"}, {"--alt", "No"}, {"--alt-why", "Wait"}, {"--owners-call", "taste"}, {"--owners-call-why", "Your voice"}} {
		var s askServer
		run := agentRunStdin(t, s.handle)
		code, _, _ := run("", Ask, permissionFlags(append([]string{"--undo", "Revert"}, old...)...)...)
		if code != ExitUsage || len(s.made) != 0 {
			t.Errorf("%v: exit %d with %d asks sent, want exit %d and none", old, code, len(s.made), ExitUsage)
		}
	}
}
