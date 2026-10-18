package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strconv"
)

// The tools of the daily work: who am I, what is waiting, read, search, post. Each is one CLI command with its arguments in JSON.

func init() {
	Register(Tool{Name: "whoami", Order: 1, Description: "Show the machine, the identity, this session and its scopes.",
		InputSchema: object(nil, props{}),
		Call: func(ctx context.Context, _ json.RawMessage) (any, error) {
			return runnerOf(ctx).run("whoami", "")
		}})

	Register(Tool{Name: "brief", Order: 2, Description: "Read the brief: who you are, the last handoff note, your asks, your inbox and the conversations with unread messages. It changes nothing.",
		InputSchema: object(nil, props{
			"max_bytes": integer("The size of the brief in bytes, 4096 to 65536. The workspace setting when left out.", 1, 1<<30),
			"page":      integer("The page of the list of conversations with unread messages, ten a page.", 1, 1<<20),
		}),
		Call: func(ctx context.Context, args json.RawMessage) (any, error) {
			var a struct {
				MaxBytes int `json:"max_bytes"`
				Page     int `json:"page"`
			}
			if err := decodeArgs(args, &a); err != nil {
				return nil, err
			}
			argv := withFlag(withFlag(nil, "max-bytes", a.MaxBytes), "page", a.Page)
			out, err := runnerOf(ctx).run("brief", "", argv...)
			if m, ok := out.Data.(map[string]any); ok && err == nil {
				if t, ok := m["text"].(string); ok {
					out.Text = t // the model reads the brief as text; the sections stay in the structured content
				}
			}
			return out, err
		}})

	Register(Tool{Name: "inbox", Order: 3, Description: "Wait for items in your inbox, or peek at them. A claimed item must be acked after you answered it.",
		InputSchema: object(nil, props{
			"wait":       integer("Seconds to wait for an item, 0 to 60.", 0, 60),
			"peek":       boolean("List the items without claiming any."),
			"claim":      integer("Claim at most this many items, 1 to 20.", 1, 20),
			"visibility": text("How long a claim holds before another session may take the item, 30s to 30m."),
			"conv":       integer("Only the items of this conversation.", 1, 1<<53-1),
		}),
		Call: func(ctx context.Context, args json.RawMessage) (any, error) {
			var a struct {
				Wait       int    `json:"wait"`
				Peek       bool   `json:"peek"`
				Claim      int    `json:"claim"`
				Visibility string `json:"visibility"`
				Conv       int64  `json:"conv"`
			}
			if err := decodeArgs(args, &a); err != nil {
				return nil, err
			}
			argv := withFlag(withFlag(withFlag(withFlag(withFlag(nil, "wait", a.Wait), "peek", a.Peek), "claim", a.Claim), "visibility", a.Visibility), "conv", a.Conv)
			return runnerOf(ctx).run("inbox", "", argv...)
		}})

	Register(Tool{Name: "claim", Order: 4, Description: "Claim ready inbox items now, without waiting. Each comes with the claim token that ack needs.",
		InputSchema: object(nil, props{
			"n":          integer("Claim at most this many items, 1 to 20.", 1, 20),
			"conv":       integer("Only the items of this conversation.", 1, 1<<53-1),
			"visibility": text("How long the claims hold, 30s to 30m."),
		}),
		Call: func(ctx context.Context, args json.RawMessage) (any, error) {
			var a struct {
				N          int    `json:"n"`
				Conv       int64  `json:"conv"`
				Visibility string `json:"visibility"`
			}
			if err := decodeArgs(args, &a); err != nil {
				return nil, err
			}
			argv := withFlag(withFlag(nil, "conv", a.Conv), "visibility", a.Visibility)
			if a.N > 0 {
				argv = append(argv, strconv.Itoa(a.N))
			}
			return runnerOf(ctx).run("claim", "", argv...)
		}})

	Register(Tool{Name: "ack", Order: 5, Description: "Ack claimed inbox items after you answered them. A claim that ran out or went to another session is refused.",
		InputSchema: object([]string{"items"}, props{
			"items": list("The items to ack, each as <id>:<claim token> exactly as claim returned it.", text("An item as <id>:<claim token>."), 1, 20),
		}),
		Call: func(ctx context.Context, args json.RawMessage) (any, error) {
			var a struct {
				Items []string `json:"items"`
			}
			if err := decodeArgs(args, &a); err != nil {
				return nil, err
			}
			return runnerOf(ctx).run("ack", "", a.Items...)
		}})

	Register(Tool{Name: "read", Order: 6, Description: "Read the messages of a conversation you are in, oldest first. This moves your read position.",
		InputSchema: object([]string{"conversation"}, props{
			"conversation": conv(),
			"since":        integer("Only messages after this message id.", 1, 1<<53-1),
			"limit":        integer("At most this many messages, 1 to 100.", 1, 100),
			"thread":       integer("Read the thread of this root message instead of the main thread.", 1, 1<<53-1),
		}),
		Call: func(ctx context.Context, args json.RawMessage) (any, error) {
			var a struct {
				Conversation int64 `json:"conversation"`
				Since        int64 `json:"since"`
				Limit        int   `json:"limit"`
				Thread       int64 `json:"thread"`
			}
			if err := decodeArgs(args, &a); err != nil {
				return nil, err
			}
			argv := withFlag(withFlag(withFlag(nil, "since", a.Since), "limit", a.Limit), "thread", a.Thread)
			return runnerOf(ctx).run("read", "", append(argv, strconv.FormatInt(a.Conversation, 10))...)
		}})

	Register(Tool{Name: "typing", Order: 17, Description: "Show the owner you are replying in a conversation, or in a thread, for 30 seconds. A claimed item shows it by itself; use this for work without one. Posting ends it.",
		InputSchema: object([]string{"conversation"}, props{
			"conversation": conv(),
			"thread":       integer("A message of the thread you reply in. Leave it out for the main list.", 1, 1<<53-1),
		}),
		Call: func(ctx context.Context, args json.RawMessage) (any, error) {
			var a struct {
				Conversation int64 `json:"conversation"`
				Thread       int64 `json:"thread"`
			}
			if err := decodeArgs(args, &a); err != nil {
				return nil, err
			}
			return runnerOf(ctx).run("typing", "", append(withFlag(nil, "thread", a.Thread), strconv.FormatInt(a.Conversation, 10))...)
		}})

	Register(Tool{Name: "search", Order: 7, Description: "Search the messages of the conversations you are in, newest first. The text may hold filters such as from:@x or is:ask.",
		InputSchema: object([]string{"query"}, props{
			"query": text("The words to find."),
			"in":    text("Only this conversation: its id or a part of its title."),
			"from":  text("Only messages written by this handle."),
			"limit": integer("At most this many results, 1 to 50.", 1, 50),
		}),
		Call: func(ctx context.Context, args json.RawMessage) (any, error) {
			var a struct {
				Query string `json:"query"`
				In    string `json:"in"`
				From  string `json:"from"`
				Limit int    `json:"limit"`
			}
			if err := decodeArgs(args, &a); err != nil {
				return nil, err
			}
			argv := withFlag(withFlag(withFlag(nil, "in", a.In), "from", a.From), "limit", a.Limit)
			return runnerOf(ctx).run("search", "", append(argv, "--", a.Query)...)
		}})

	Register(Tool{Name: "post", Order: 8, Description: "Post a message to a conversation you are in. It may carry an app.",
		InputSchema: object([]string{"conversation", "text"}, props{
			"conversation": conv(),
			"text":         text("The message text."),
			"format":       oneOf("How the text is written.", "markdown", "markdownv2", "plain"),
			"app":          appSchema(),
		}),
		Call: func(ctx context.Context, args json.RawMessage) (any, error) {
			var a struct {
				Conversation int64           `json:"conversation"`
				Text         string          `json:"text"`
				Format       string          `json:"format"`
				App          json.RawMessage `json:"app"`
			}
			if err := decodeArgs(args, &a); err != nil {
				return nil, err
			}
			return withApp(a.App, func(file string) (Output, error) {
				argv := withFlag(withFlag(nil, "format", a.Format), "app", file)
				return runnerOf(ctx).run("post", a.Text, append(argv, strconv.FormatInt(a.Conversation, 10), "-")...)
			})
		}})

	Register(Tool{Name: "reply", Order: 9, Description: "Reply in the thread of a main message of a conversation you are in. It may carry an app.",
		InputSchema: object([]string{"conversation", "message", "text"}, props{
			"conversation": conv(),
			"message":      integer("The id of the main message that starts the thread.", 1, 1<<53-1),
			"text":         text("The reply text."),
			"broadcast":    boolean("Also show the reply in the main thread."),
			"format":       oneOf("How the text is written.", "markdown", "markdownv2", "plain"),
			"app":          appSchema(),
		}),
		Call: func(ctx context.Context, args json.RawMessage) (any, error) {
			var a struct {
				Conversation int64           `json:"conversation"`
				Message      int64           `json:"message"`
				Text         string          `json:"text"`
				Broadcast    bool            `json:"broadcast"`
				Format       string          `json:"format"`
				App          json.RawMessage `json:"app"`
			}
			if err := decodeArgs(args, &a); err != nil {
				return nil, err
			}
			return withApp(a.App, func(file string) (Output, error) {
				argv := withFlag(withFlag(withFlag(nil, "format", a.Format), "app", file), "broadcast", a.Broadcast)
				return runnerOf(ctx).run("reply", a.Text, append(argv, strconv.FormatInt(a.Message, 10), "-")...)
			})
		}})
}

// withApp gives a command the app as a file, which is how the CLI takes one, and removes the file afterwards. Without an app it
// passes no file.
func withApp(app json.RawMessage, do func(file string) (Output, error)) (Output, error) {
	if len(app) == 0 || string(app) == "null" {
		return do("")
	}
	f, err := os.CreateTemp("", "convoz-app-*.json") // mode 0600
	if err != nil {
		return Output{}, fmt.Errorf("cannot keep the app for a moment: %w", err)
	}
	defer os.Remove(f.Name())
	_, werr := f.Write(app)
	if err := f.Close(); werr != nil || err != nil {
		return Output{}, fmt.Errorf("cannot keep the app for a moment: %w", err)
	}
	return do(f.Name())
}
