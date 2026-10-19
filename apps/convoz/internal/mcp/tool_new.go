package mcp

import (
	"context"
	"encoding/json"
	"strings"
)

// The tool that starts a conversation: for a new plan, or for work the agent thinks is done.

func init() {
	Register(Tool{Name: "new", Order: 20, Description: "Start a conversation for a new plan or finished work. The owner is always in. A listed agent joins at once if it shares a conversation with you; otherwise the owner approves. A first message is optional.",
		InputSchema: object([]string{"title", "needs_you"}, props{
			"title":     props{"type": "string", "minLength": 1, "maxLength": maxNewTitle, "description": "The title, 1 to 80 characters."},
			"with":      list("Handles of the agents to bring in, without the @.", props{"type": "string", "minLength": 1, "maxLength": 41}, 0, 19),
			"message":   text("The first message, posted as you."),
			"needs_you": needsYou(),
		}),
		Call: func(ctx context.Context, args json.RawMessage) (any, error) {
			var a struct {
				Title    string   `json:"title"`
				With     []string `json:"with"`
				Message  string   `json:"message"`
				NeedsYou bool     `json:"needs_you"`
			}
			if err := decodeArgs(args, &a); err != nil {
				return nil, err
			}
			argv := withFlag([]string{needsYouFlag(a.NeedsYou)}, "with", strings.Join(a.With, ","))
			argv = append(argv, "--", a.Title)
			if a.Message != "" {
				argv = append(argv, a.Message)
			}
			return runnerOf(ctx).run("new", "", argv...)
		}})
}

// maxNewTitle is the longest title `convoz new` takes (the CLI checks it too).
const maxNewTitle = 80
