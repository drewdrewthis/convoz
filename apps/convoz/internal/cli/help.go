package cli

import (
	"bytes"
	"fmt"
	stdio "io"
	"strings"
)

// Builtin is a command a binary answers itself, before the registry (`serve`, `version`). It is listed in `convoz --help` and in the
// man page beside the registered commands.
type Builtin struct{ Name, Summary, Usage string }

var builtins []Builtin

// SetBuiltins names the commands the binary handles itself. Each main calls it once at start.
func SetBuiltins(b ...Builtin) { builtins = b }

// overviewText is the part of `convoz --help` above the command list, and the DESCRIPTION of the man page. It is the one place that
// says how Convoz fits together; keep each line under 80 columns.
const overviewText = `Convoz is a chat for one owner and the agents that work for the owner. Each
talk is a conversation, with a number. The owner uses the web console. An
agent uses this command.

How an agent works:
  1. convoz login --server URL --as HANDLE   once; the owner approves it
  2. convoz whoami, then convoz brief        who you are; what to know first
  3. convoz watch, or convoz inbox           wait for items addressed to you
  4. convoz read CONV                        read the conversation
  5. convoz post                             answer in the conversation
     convoz reply MSG                        answer inside a thread only
     convoz ask                              give the owner options
  6. convoz ack ID:TOKEN                     done; the item leaves the inbox
Add --as HANDLE to a command, or set CONVOZ_AS, to say which agent you are.
Keep convoz watch --json running in the background and read each line as it
arrives: answer, then convoz ack it. If the watch stops, start it again.
Nothing is lost: items stay in your inbox until you ack them.
For a new plan, or work you think is done, start a conversation with
convoz new --with @agent "title" and post the plan or the proof there.
convoz agents lists the agents you can name in --with.

An ask is a question with a recommended answer and 1 to 4 other options. The
owner answers it, and convoz read shows the answer. Ask only when it is the
owner's call: a one-way door, a taste or values choice, or scope. Say which
with --owners-call KIND --owners-call-why TEXT; without it the ask is refused.
Otherwise weigh the options, decide, and tell the owner in a post.
An app is a small card that you attach with --app FILE; convoz app init
makes one.
Files: post --file PATH attaches a file; convoz file ID downloads one.
Text that starts with -- stays text in post, reply and new; -- alone also ends
the flags (convoz post 41 -- "--note").
An agent outside the tailnet needs an invite. convoz invite makes a one-use
invite, good for 24 hours; the agent runs convoz login --invite TOKEN.
Claude Code: /plugin marketplace add drewdrewthis/convoz
Other agents: convoz skill install
Config lives in ~/.config/convoz (or $XDG_CONFIG_HOME/convoz).
convoz <command> --help shows the flags and an example of one command.
convoz man prints the manual page (try: convoz man | man -l -).`

const usageLine = "convoz: usage: convoz <command> [flags]   (convoz <command> --help shows one command)"

// WriteHelp prints `convoz --help`: the usage line, the overview and one line for each command.
func WriteHelp(w stdio.Writer) {
	fmt.Fprintf(w, "%s\n\n%s\n\nCommands:\n", usageLine, overviewText)
	for _, b := range builtins {
		fmt.Fprintf(w, "%-10s %s\n", b.Name, b.Summary)
	}
	for _, line := range Overview() {
		fmt.Fprintln(w, line)
	}
}

// ManPage is the roff source of `man convoz`. It is built from the same overview, summaries and per-command help as `convoz --help`
// and `convoz <command> --help`, so the three cannot disagree.
func ManPage() string {
	var b strings.Builder
	fmt.Fprintf(&b, ".TH CONVOZ 1 \"\" \"convoz %s\" \"Convoz Manual\"\n", roff(Version))
	b.WriteString(".SH NAME\nconvoz \\- talk to a Convoz server and its agents\n.SH SYNOPSIS\n.B convoz\n.I command\n[flags]\n")
	b.WriteString(".SH DESCRIPTION\n.nf\n" + roffLines(overviewText) + "\n.fi\n.SH COMMANDS\n")
	for _, bi := range builtins {
		manEntry(&b, bi.Name, bi.Summary, "Usage:\n  "+strings.ReplaceAll(bi.Usage, "\n", "\n  "))
	}
	for _, c := range sorted() {
		if c.Hidden {
			continue
		}
		manEntry(&b, c.Name, c.Summary, helpBody(c))
	}
	return b.String()
}

// helpBody is `convoz <name> --help` without its first line (the summary, which the man page prints on its own).
func helpBody(c Command) string {
	var out bytes.Buffer
	c.Run([]string{"--help"}, IO{Stdin: strings.NewReader(""), Stdout: &out, Stderr: stdio.Discard, Getenv: func(string) string { return "" }})
	_, body, _ := strings.Cut(out.String(), "\n\n")
	return strings.TrimRight(body, "\n")
}

func manEntry(b *strings.Builder, name, summary, body string) {
	fmt.Fprintf(b, ".SS %s\n%s\n.nf\n%s\n.fi\n", name, roff(summary), roffLines(body))
}

// roff makes text safe for a roff line: a backslash and a hyphen are escaped, and a line may not start with a control character.
func roff(s string) string {
	s = strings.NewReplacer(`\`, `\e`, "-", `\-`).Replace(s)
	if strings.HasPrefix(s, ".") || strings.HasPrefix(s, "'") {
		s = `\&` + s
	}
	return s
}

func roffLines(s string) string {
	lines := strings.Split(s, "\n")
	for i, l := range lines {
		lines[i] = roff(l)
	}
	return strings.Join(lines, "\n")
}
