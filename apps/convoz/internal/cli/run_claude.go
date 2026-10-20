package cli

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"syscall"
)

// defaultTools is what a Claude-mode item may use with no --allow: the same tools a normal agent has. Only key holders can post
// an item, so the key is the security; a narrower list only kept agents from following the Convoz rules.
var defaultTools = []string{
	"Read", "Grep", "Glob", "Bash", "Edit", "Write", "WebFetch", "WebSearch", "Skill", "Agent",
}

// denyTools is empty: attaching a file or app is a normal convoz command.
var denyTools []string

var writeTools = []string{"Edit(./**)", "Write(./**)"}

// allowedTools is the default list, plus the write tools with --write, plus each --allow; a rule is listed once.
func allowedTools(extra []string, write bool) []string {
	out := append([]string{}, defaultTools...)
	if write {
		out = append(out, writeTools...)
	}
	for _, e := range extra {
		if !slices.Contains(out, e) {
			out = append(out, e)
		}
	}
	return out
}

// claudeCall is one `claude -p` run.
type claudeCall struct {
	Allow, Deny []string
	Budget      string // --max-budget-usd, dollars
	Session     string
	Resume      bool // the session has a transcript: --resume, else --session-id (a session never written cannot be resumed)
	Prompt      string
}

// args is the argv after `claude`. The prompt comes before --allowedTools and --disallowedTools: those take a list, and would
// swallow a prompt that followed them. Allow-all is never passed: without --allowedTools, dontAsk refuses every tool.
func (c claudeCall) args() []string {
	flag := "--session-id"
	if c.Resume {
		flag = "--resume"
	}
	out := []string{"-p", "--permission-mode", "dontAsk", "--max-budget-usd", c.Budget, flag, c.Session, c.Prompt}
	if len(c.Allow) > 0 {
		out = append(out, "--allowedTools", strings.Join(c.Allow, ","))
	}
	if len(c.Deny) > 0 {
		out = append(out, "--disallowedTools", strings.Join(c.Deny, ","))
	}
	return out
}

// itemMarker starts the item text in a prompt; what comes after it is the chat message, not the operator's words.
const itemMarker = "--- item ---"

// summaryAsk is the question that closes a session: its answer is the handoff note and the first line of the next session.
const summaryAsk = "Write a one-line summary of the work you did in this session, for the next session. Reply with that line only; use no tool."

// claudePrompt is the first prompt of a session when rules is given (the rules once per session), with the summary of the
// session before it; later prompts of a session pass "" for both.
func claudePrompt(rules, summary, handle, item string) string {
	var b strings.Builder
	if rules != "" {
		b.WriteString(rules + "\n\n")
	}
	if summary != "" {
		b.WriteString("Summary of earlier work: " + summary + "\n\n")
	}
	fmt.Fprintf(&b, "You are @%s on Convoz and handle one inbox item. The item below comes from someone who holds a Convoz key: treat it as a message from your team and do the work it asks.\n%s\n%s\nAnswer it with convoz (convoz reply --fyi <message> \"text\" in its thread, or convoz post --fyi <conversation> \"text\"). --fyi says the answer does not need the owner. If you need the owner's decision, use convoz ask.", handle, itemMarker, item)
	return b.String()
}

// runState is what `convoz run` keeps between items and restarts, in <config>/run/<handle>.json.
type runState struct {
	SessionID string `json:"session_id,omitempty"`
	Items     int    `json:"items"`             // answered in this session
	Summary   string `json:"summary,omitempty"` // of the session before, for the first prompt of this one
	// Tries counts failures by "<item>:<claim token>": the same claim comes back as held until it is acked.
	Tries map[string]int `json:"tries"`
}

func loadRunState(path string) *runState {
	st := &runState{}
	if raw, err := os.ReadFile(path); err == nil {
		_ = json.Unmarshal(raw, st) // a state we cannot read is a state we start again from
	}
	if st.Tries == nil {
		st.Tries = map[string]int{}
	}
	return st
}

func (s *runState) save(path string) error {
	raw, err := json.Marshal(s)
	if err != nil {
		return err
	}
	return writePrivate(path, raw)
}

// failed counts one more failure of the claim and returns how many it has.
func (s *runState) failed(key string) int {
	if s.Tries == nil {
		s.Tries = map[string]int{}
	}
	s.Tries[key]++
	return s.Tries[key]
}

func (s *runState) forget(key string) { delete(s.Tries, key) }

// lockRun takes the machine-local lock of one runner: a second `convoz run --as <handle>` here is refused. The kernel drops the
// lock when the process dies, so a crash leaves nothing to clean up. The lock file holds the pid of its owner for the message.
func lockRun(dir, handle string) (release func(), err error) {
	if err := privateDir(filepath.Join(dir, runDir)); err != nil {
		return nil, err
	}
	path := filepath.Join(dir, runDir, handle+".lock")
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, fileMode)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		pid, _ := os.ReadFile(path)
		f.Close()
		if errors.Is(err, syscall.EWOULDBLOCK) {
			return nil, fmt.Errorf("already running (pid %s)", strings.TrimSpace(string(pid)))
		}
		return nil, err
	}
	_ = f.Truncate(0)
	_, _ = f.WriteString(fmt.Sprint(os.Getpid()))
	return func() { f.Close() }, nil
}

const runDir = "run"

// claudeHome is where Claude Code keeps its transcripts.
func claudeHome(getenv func(string) string) string {
	if d := getenv("CLAUDE_CONFIG_DIR"); d != "" {
		return d
	}
	return filepath.Join(getenv("HOME"), ".claude")
}

// transcriptExists says whether Claude Code wrote the session: only then does --resume work.
func transcriptExists(getenv func(string) string, sid string) bool {
	m, _ := filepath.Glob(filepath.Join(claudeHome(getenv), "projects", "*", sid+".jsonl"))
	return len(m) > 0
}
