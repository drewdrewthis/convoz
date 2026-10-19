package cli

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

// agentRun logs in against handler and returns a runner for `convoz <cmd>` as session "devtool".
func agentRun(t *testing.T, handler http.HandlerFunc) func(cmd func([]string, IO) int, args ...string) (code int, stdout, stderr string) {
	t.Helper()
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	xdg := t.TempDir()
	dir := filepath.Join(xdg, "convoz")
	if err := saveCredentials(dir, brokenKeychain{}, Credentials{Server: srv.URL, Machine: "box-2", Key: testKey}, storeFile); err != nil {
		t.Fatal(err)
	}
	sid, err := saveSession(dir, sessionFile{Lease: "cvz_s_TESTONLYlease", Identity: "devtool", Machine: "box-2", ClientID: "claude-1"})
	if err != nil {
		t.Fatal(err)
	}
	env := func(k string) string {
		if k == "XDG_CONFIG_HOME" {
			return xdg
		}
		return ""
	}
	return func(cmd func([]string, IO) int, args ...string) (int, string, string) {
		var out, errb bytes.Buffer
		code := cmd(append([]string{"--sid", sid}, args...), IO{Stdin: strings.NewReader(""), Stdout: &out, Stderr: &errb, Getenv: env})
		return code, out.String(), errb.String()
	}
}

func inboxItem(id int64, body string) wire.InboxItem {
	return wire.InboxItem{ID: id, ClaimToken: "tok", Reason: "mention", Count: 1, Message: wire.Message{ID: id * 10, Body: body}}
}

// inboxServer answers each inbox poll with the next batch of items; an empty batch is a poll that timed out.
func inboxServer(t *testing.T, batches ...[]wire.InboxItem) (http.HandlerFunc, func() int) {
	var mu sync.Mutex
	polls := 0
	h := func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != wire.RouteInbox {
			http.NotFound(w, r)
			return
		}
		mu.Lock()
		var items []wire.InboxItem
		if polls < len(batches) {
			items = batches[polls]
		}
		polls++
		mu.Unlock()
		_ = json.NewEncoder(w).Encode(wire.InboxResponse{Items: items})
	}
	return h, func() int { mu.Lock(); defer mu.Unlock(); return polls }
}

func TestWatchOncePrintsEveryWaitingItemAndExitsAfterOnePoll(t *testing.T) {
	h, polls := inboxServer(t, []wire.InboxItem{inboxItem(1, "first"), inboxItem(2, "second")})
	run := agentRun(t, h)

	code, stdout, stderr := run(Watch, "--once", "--json")

	if code != ExitOK {
		t.Fatalf("exit %d: %s", code, stderr)
	}
	lines := strings.Split(strings.TrimSpace(stdout), "\n")
	if len(lines) != 2 || !strings.Contains(lines[0], `"body":"first"`) || !strings.Contains(lines[1], `"body":"second"`) {
		t.Errorf("want the two waiting items, one line each, got %q", stdout)
	}
	if polls() != 1 {
		t.Errorf("one poll, then exit; got %d", polls())
	}
}

func TestWatchOnceWaitsThroughEmptyPollsForTheNextItem(t *testing.T) {
	h, polls := inboxServer(t, nil, nil, []wire.InboxItem{inboxItem(3, "late")})
	run := agentRun(t, h)

	code, stdout, stderr := run(Watch, "--once")

	if code != ExitOK || strings.Count(stdout, "\n") != 1 || !strings.Contains(stdout, "(ack: convoz ack 3:tok)") {
		t.Errorf("exit %d, stdout %q, stderr %q", code, stdout, stderr)
	}
	if polls() != 3 {
		t.Errorf("two empty polls then the item; got %d polls", polls())
	}
}

func TestWatchOnceWithATimeoutAndNothingExitsSilentlyWithAReasonOnStderr(t *testing.T) {
	h, _ := inboxServer(t)
	run := agentRun(t, h)

	code, stdout, stderr := run(Watch, "--once", "--timeout", "1s")

	if code != ExitNothing || stdout != "" || !strings.Contains(stderr, "no item arrived") {
		t.Errorf("want exit %d, no output, a reason: got %d %q %q", ExitNothing, code, stdout, stderr)
	}
}

// created is what the fake server saw: the body of POST /api/conversations and of the first message.
type created struct {
	mu     sync.Mutex
	create map[string]any
	post   wire.PostRequest
}

// convServer makes conversation 7 with the given people in it.
func convServer(c *created, people ...wire.Person) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		c.mu.Lock()
		defer c.mu.Unlock()
		switch r.URL.Path {
		case wire.RouteConversations:
			_ = json.NewDecoder(r.Body).Decode(&c.create)
			w.WriteHeader(http.StatusCreated)
			_ = json.NewEncoder(w).Encode(map[string]any{"conversation": map[string]any{"id": 7, "participants": people}})
		case wire.RouteConversations + "/7/messages":
			_ = json.NewDecoder(r.Body).Decode(&c.post)
			w.WriteHeader(http.StatusCreated)
			_, _ = w.Write([]byte(`{"id":70,"conversation_id":7}`))
		default:
			http.NotFound(w, r)
		}
	}
}

var (
	drew    = wire.Person{Handle: "drew", Kind: "human"}
	devtool = wire.Person{Handle: "devtool", Kind: "agent"}
	docs    = wire.Person{Handle: "docs", Kind: "agent"}
)

func TestNewSendsTheTitleAndHandlesThenPostsTheFirstMessage(t *testing.T) {
	var c created
	run := agentRun(t, convServer(&c, devtool, drew, docs))

	code, stdout, stderr := run(New, "--fyi", "--with", "@Drew, @docs,@docs", "Plan: filters", "Step one.")

	if code != ExitOK || stdout != "7\n" || stderr != "" {
		t.Fatalf("exit %d stdout %q stderr %q", code, stdout, stderr)
	}
	if c.create["title"] != "Plan: filters" || strings.Join(toStrings(c.create["participants"]), ",") != "drew,docs" {
		t.Errorf("title and handles (lower case, once each): %v", c.create)
	}
	if c.post.Body != "Step one." || c.post.ClientID == "" {
		t.Errorf("first message: %+v", c.post)
	}
}

func TestNewReportsAnAgentTheServerKeptOutAsPending(t *testing.T) {
	var c created
	run := agentRun(t, convServer(&c, devtool, drew))

	code, stdout, _ := run(New, "--json", "--with", "@release-bot", "Plan: release")

	var got struct {
		ConversationID int64    `json:"conversation_id"`
		Pending        []string `json:"pending"`
	}
	if err := json.Unmarshal([]byte(stdout), &got); code != ExitOK || err != nil || got.ConversationID != 7 || strings.Join(got.Pending, ",") != "release-bot" {
		t.Errorf("exit %d, %q, %v", code, stdout, err)
	}
	if c.post.Body != "" {
		t.Errorf("no first message was given, yet one was posted: %+v", c.post)
	}
}

func TestNewRefusesABadTitleWithoutCallingTheServer(t *testing.T) {
	var c created
	run := agentRun(t, convServer(&c))
	for _, title := range []string{"", "   ", strings.Repeat("é", 81), "two\nlines"} {
		if code, _, _ := run(New, title); code != ExitUsage {
			t.Errorf("title %.12q: exit %d, want %d", title, code, ExitUsage)
		}
	}
	if code, _, _ := run(New, strings.Repeat("é", 80)); code != ExitOK {
		t.Errorf("80 characters, not bytes, is allowed: exit %d", code)
	}
}

func toStrings(v any) []string {
	var out []string
	for _, x := range v.([]any) {
		out = append(out, x.(string))
	}
	return out
}

func TestPostReplyAndNewKeepTextThatStartsWithDashesAsText(t *testing.T) {
	const text = "--once is for agent tools -x"
	for name, args := range map[string][]string{
		"text after the conversation":  {"7", text},
		"text after the end of flags":  {"7", "--", text},
		"a flag before, then the text": {"--format", "plain", "7", text},
	} {
		var c created
		run := agentRun(t, convServer(&c, devtool, drew))
		if code, _, stderr := run(Post, args...); code != ExitOK || c.post.Body != text {
			t.Errorf("post, %s: exit %d body %q stderr %q", name, code, c.post.Body, stderr)
		}
	}
	var after created
	if code, _, stderr := agentRun(t, convServer(&after, devtool, drew))(Post, "7", "hello", "--format", "plain"); code != ExitOK || after.post.Body != "hello" {
		t.Errorf("a flag after plain text still parses: exit %d body %q stderr %q", code, after.post.Body, stderr)
	}
	var c created
	run := agentRun(t, convServer(&c, devtool, drew))
	if code, _, stderr := run(New, "Plan", "--with is a word here"); code != ExitOK || c.post.Body != "--with is a word here" {
		t.Errorf("new: exit %d body %q stderr %q", code, c.post.Body, stderr)
	}
}

// Owner (conv 19 msgs 544, 561): a plain watch line shows the thread and what the message follows, under the line.
func TestPlainWatchShowsTheThreadTopicAndTheMessageBefore(t *testing.T) {
	it := inboxItem(7, "yes")
	it.ThreadTopic = "Can step 1 ship on its own?"
	it.Before = &wire.Before{Author: "drew", Text: "Which tests cover it?"}
	h, _ := inboxServer(t, []wire.InboxItem{it})
	code, stdout, stderr := agentRun(t, h)(Watch, "--once")
	if code != ExitOK {
		t.Fatalf("exit %d: %s", code, stderr)
	}
	lines := strings.Split(strings.TrimRight(stdout, "\n"), "\n")
	if len(lines) != 3 || lines[1] != "  in thread: Can step 1 ship on its own?" || lines[2] != "  after @drew: Which tests cover it?" {
		t.Errorf("got %q", stdout)
	}
}

func TestJSONWatchLineCarriesTheContext(t *testing.T) {
	it := inboxItem(7, "yes")
	it.ThreadTopic = "topic"
	it.Before = &wire.Before{Author: "drew", Text: "q"}
	h, _ := inboxServer(t, []wire.InboxItem{it})
	_, stdout, _ := agentRun(t, h)(Watch, "--once", "--json")
	if !strings.Contains(stdout, `"thread_topic":"topic"`) || !strings.Contains(stdout, `"before":{"author":"drew","text":"q"}`) {
		t.Errorf("got %q", stdout)
	}
}
