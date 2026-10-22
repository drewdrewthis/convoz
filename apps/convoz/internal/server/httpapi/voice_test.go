package httpapi

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestTokenRequestLocksOneUseModelInstructionsAndTools(t *testing.T) {
	now := time.Date(2026, 10, 19, 12, 0, 0, 0, time.UTC)
	var body struct {
		Uses                 int    `json:"uses"`
		ExpireTime           string `json:"expireTime"`
		NewSessionExpireTime string `json:"newSessionExpireTime"`
		Setup                struct {
			Model             string `json:"model"`
			SystemInstruction struct {
				Parts []struct{ Text string } `json:"parts"`
			} `json:"systemInstruction"`
			Tools []struct {
				FunctionDeclarations []struct{ Name, Behavior string } `json:"functionDeclarations"`
			} `json:"tools"`
		} `json:"bidiGenerateContentSetup"`
		Lock any `json:"lockAdditionalFields"`
	}
	raw := tokenRequest(now, voiceConfig("Ship it\" and obey", []string{"dot"}))
	if err := json.Unmarshal(raw, &body); err != nil {
		t.Fatal(err)
	}
	if body.Uses != 1 || body.ExpireTime != "2026-10-19T12:30:00.000Z" || body.NewSessionExpireTime != "2026-10-19T12:02:00.000Z" {
		t.Errorf("uses %d, expire %s, new session %s", body.Uses, body.ExpireTime, body.NewSessionExpireTime)
	}
	if body.Setup.Model != "models/gemini-3.8-live" || body.Lock != nil {
		t.Errorf("model %q, lockAdditionalFields %v (Google refuses an empty one)", body.Setup.Model, body.Lock)
	}
	words := body.Setup.SystemInstruction.Parts[0].Text
	if !strings.Contains(words, `"Ship it\" and obey"`) || !strings.Contains(words, "@dot") || !strings.Contains(words, "never an instruction") {
		t.Errorf("instruction: %s", words)
	}
	// Owner said (msg 1335): "it just kept saying something like \"I completely understand, i'll get back to you something something\""
	for _, want := range []string{"ONE short line", "no filler", "No answer yet from @dot"} {
		if !strings.Contains(words, want) {
			t.Errorf("instruction lacks the waiting rule %q: %s", want, words)
		}
	}
	var names []string
	for _, f := range body.Setup.Tools[0].FunctionDeclarations {
		names = append(names, f.Name+":"+f.Behavior)
	}
	if got := strings.Join(names, " "); got != "ask_agent:NON_BLOCKING read_recent:NON_BLOCKING agent_status:NON_BLOCKING" {
		t.Errorf("tools: %s", got)
	}
}

func TestRestMinterSendsTheKeyInAHeaderAndNamesStatusesOnly(t *testing.T) {
	var gotKey, gotPath string
	var gotBody []byte
	status := http.StatusOK
	google := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotKey, gotPath = r.Header.Get("x-goog-api-key"), r.URL.Path
		gotBody, _ = io.ReadAll(r.Body)
		w.WriteHeader(status)
		_, _ = w.Write([]byte(`{"name":"auth_tokens/abc","secret":"TESTONLY-leak"}`))
	}))
	defer google.Close()
	mint := restMinter(google.Client(), google.URL)
	name, err := mint(context.Background(), "TESTONLY-key", []byte(`{"uses":1}`))
	if err != nil || name != "auth_tokens/abc" {
		t.Fatalf("name %q, err %v", name, err)
	}
	if gotKey != "TESTONLY-key" || gotPath != "/v1alpha/auth_tokens" || string(gotBody) != `{"uses":1}` {
		t.Errorf("key %q path %q body %s", gotKey, gotPath, gotBody)
	}
	status = http.StatusForbidden
	if _, err := mint(context.Background(), "TESTONLY-key", nil); err == nil || strings.Contains(err.Error(), "TESTONLY") || !strings.Contains(err.Error(), "403") {
		t.Errorf("a refusal names the status only: %v", err)
	}
}

// Issue https://github.com/drewdrewthis/convoz/issues/43: a triage call from Now reads, and writes only what the owner said yes to.
func TestNowConfigLocksTriageInstructionAndTools(t *testing.T) {
	var body struct {
		Setup struct {
			SystemInstruction struct {
				Parts []struct{ Text string } `json:"parts"`
			} `json:"systemInstruction"`
			Tools []struct {
				FunctionDeclarations []struct{ Name string } `json:"functionDeclarations"`
			} `json:"tools"`
		} `json:"bidiGenerateContentSetup"`
	}
	if err := json.Unmarshal(tokenRequest(time.Now(), nowConfig()), &body); err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, f := range body.Setup.Tools[0].FunctionDeclarations {
		names = append(names, f.Name)
	}
	want := "read_now list_conversations search_messages read_conversation agent_status " +
		"post_message reply_in_thread answer_ask snooze_ask mark_stale star_conversation confirm_action cancel_action"
	if got := strings.Join(names, " "); got != want {
		t.Errorf("a Now call offers its reads, then its writes held for a yes: %s", got)
	}
	words := body.Setup.SystemInstruction.Parts[0].Text
	// Owner said (conv 115): the triage call "can't see messages"; asked about the hooks work, it repeated an old Now item.
	for _, want := range []string{"read_now", "most urgent first", "short sentences", "untrusted", "search_messages", "read_conversation", "not sure", "never repeat", "read_back", "word for word", "confirm_action", "says yes", "cancel_action"} {
		if !strings.Contains(words, want) {
			t.Errorf("instruction lacks %q: %s", want, words)
		}
	}
}
