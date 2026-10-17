package mcp

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/cli"
)

// runner runs the CLI commands a tool stands for, in this process. A tool is the command with its arguments in JSON, so the
// retries, the exit codes and the lease rules are the ones of the CLI, and a Bash call of the same Claude session finds the
// same session file.
type runner struct {
	as     string
	getenv func(string) string
}

type runnerKey struct{}

func withRunner(ctx context.Context, r runner) context.Context {
	return context.WithValue(ctx, runnerKey{}, r)
}

func runnerOf(ctx context.Context) runner {
	r, _ := ctx.Value(runnerKey{}).(runner)
	return r
}

// Output is a tool's answer: Text is what the model reads, Data the same as structured content (a JSON object).
type Output struct {
	Text string
	Data any
}

// Failed is a tool's answer when the command did not succeed: the model reads Text and can correct itself.
type Failed struct{ Text string }

func (f Failed) Error() string { return f.Text }

// run runs `convoz <name> --as H --json <args...>` with stdin and returns its JSON answer.
func (r runner) run(name string, stdin string, args ...string) (Output, error) {
	return r.runSub(name, nil, stdin, args...)
}

// runSub is run for a command with a subcommand (`convoz app validate`): the subcommand words come before the flags.
func (r runner) runSub(name string, sub []string, stdin string, args ...string) (Output, error) {
	cmd, ok := cli.Lookup(name)
	if !ok {
		return Output{}, Failed{fmt.Sprintf("convoz %s is not part of this build yet", name)}
	}
	var stdout, stderr bytes.Buffer
	io := cli.IO{Stdin: strings.NewReader(stdin), Stdout: &stdout, Stderr: &stderr, Getenv: r.getenv}
	argv := append(append(append([]string{}, sub...), "--as", r.as, "--json"), args...)
	if code := cmd.Run(argv, io); code != 0 {
		msg := strings.TrimSpace(stderr.String())
		if out := strings.TrimSpace(stdout.String()); out != "" {
			msg += "\n" + out
		}
		return Output{}, Failed{fmt.Sprintf("%s (exit %d)", strings.TrimSpace(msg), code)}
	}
	out := strings.TrimSpace(stdout.String())
	var data any
	if json.Unmarshal([]byte(out), &data) != nil {
		return Output{Text: out}, nil
	}
	if _, isObject := data.(map[string]any); !isObject {
		data = nil
	}
	return Output{Text: out, Data: data}, nil
}

func decodeArgs(args json.RawMessage, into any) error {
	if len(args) == 0 {
		return nil
	}
	return json.Unmarshal(args, into)
}

// withFlag appends --name value when the value is set.
func withFlag(argv []string, name string, v any) []string {
	switch x := v.(type) {
	case int:
		if x != 0 {
			return append(argv, "--"+name, fmt.Sprint(x))
		}
	case int64:
		if x != 0 {
			return append(argv, "--"+name, fmt.Sprint(x))
		}
	case string:
		if x != "" {
			return append(argv, "--"+name, x)
		}
	case bool:
		if x {
			return append(argv, "--"+name)
		}
	}
	return argv
}
