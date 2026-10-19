package mcp

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/cli"
)

func init() {
	cli.Register(cli.Command{Name: "mcp", Order: 91, Summary: "Run the MCP server, so a Claude session can use Convoz as tools.", Example: "convoz mcp --as code-review", Run: Run, Usage: "convoz mcp --as HANDLE"})
}

const instructions = "You speak on Convoz as one agent. Call brief first: it says who you are, what the last session handed off, and what waits for you. Then start waiting on your inbox at once: call inbox to wait for items (or claim to take ready ones), answer each, and ack it. Keep doing this for as long as the session lasts."

// Run is `convoz mcp --as HANDLE`: the MCP server of one Claude session on standard input and output (design §13.2). It holds
// the session lease of that Claude session, the same one the CLI uses from Bash (they share the client id in
// CLAUDE_CODE_SESSION_ID). It ends the lease when its input closes. If it is killed instead, the lease stays, and the next
// server in that Claude session finds it and the claims it holds.
func Run(args []string, term cli.IO) int {
	fs := flag.NewFlagSet("mcp", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	as := fs.String("as", term.Getenv("CONVOZ_AS"), "the agent handle this server speaks as")
	if err := fs.Parse(args); err != nil || fs.NArg() != 0 || *as == "" {
		fmt.Fprintln(term.Stderr, "convoz: usage: convoz mcp --as HANDLE")
		return cli.ExitUsage
	}
	getenv := term.Getenv
	if getenv("CLAUDE_CODE_SESSION_ID") == "" {
		// Without the id of a Claude session, this server is its own session: one client id for every call it makes.
		b := make([]byte, 8)
		_, _ = rand.Read(b)
		own := "convoz-mcp-" + hex.EncodeToString(b)
		getenv = func(k string) string {
			if k == "CLAUDE_CODE_SESSION_ID" {
				return own
			}
			return term.Getenv(k)
		}
	}
	tools := cli.IO{Stderr: term.Stderr, Getenv: getenv, Stdin: nil, Stdout: io.Discard}
	if err := cli.OpenAgentSession(tools, *as); err != nil {
		return cli.Fail(term, err)
	}
	srv := sdk.NewServer(&sdk.Implementation{Name: "convoz", Version: cli.Version}, &sdk.ServerOptions{Instructions: instructions})
	r := runner{as: *as, getenv: getenv}
	for _, t := range Tools() {
		v, err := newValidator(t.InputSchema)
		if err != nil {
			fmt.Fprintf(term.Stderr, "convoz: the schema of tool %s is not valid: %v\n", t.Name, err)
			return cli.ExitFailure
		}
		srv.AddTool(&sdk.Tool{Name: t.Name, Description: t.Description, InputSchema: t.InputSchema}, handler(t, v, r))
	}
	err := srv.Run(context.Background(), &sdk.IOTransport{Reader: io.NopCloser(term.Stdin), Writer: nopCloser{term.Stdout}})
	cli.CloseAgentSession(tools, *as)
	if err != nil && !errors.Is(err, io.EOF) && !errors.Is(err, context.Canceled) {
		fmt.Fprintf(term.Stderr, "convoz: %v\n", err)
		return cli.ExitFailure
	}
	return cli.ExitOK
}

type nopCloser struct{ io.Writer }

func (nopCloser) Close() error { return nil }

// handler checks the arguments against the schema, runs the tool and turns its answer into a tool result. A failure of the
// command is a result with IsError, which the model can read, not a protocol error.
func handler(t Tool, v validator, r runner) sdk.ToolHandler {
	return func(ctx context.Context, req *sdk.CallToolRequest) (*sdk.CallToolResult, error) {
		if err := v.check(req.Params.Arguments); err != nil {
			return failure("The arguments of " + t.Name + " are not valid: " + err.Error()), nil
		}
		out, err := t.Call(withRunner(ctx, r), req.Params.Arguments)
		var failed Failed
		switch {
		case errors.As(err, &failed):
			return failure(failed.Text), nil
		case err != nil:
			return nil, err
		}
		var o Output
		switch x := out.(type) {
		case Output:
			o = x
		default:
			raw, _ := json.Marshal(x)
			o = Output{Text: string(raw), Data: x}
		}
		return &sdk.CallToolResult{Content: []sdk.Content{&sdk.TextContent{Text: o.Text}}, StructuredContent: o.Data}, nil
	}
}

func failure(text string) *sdk.CallToolResult {
	return &sdk.CallToolResult{Content: []sdk.Content{&sdk.TextContent{Text: text}}, IsError: true}
}
