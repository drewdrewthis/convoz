package mcp

import (
	"context"
	"encoding/json"
	"strconv"
	"strings"
)

// The tools that say something about the agent itself: its asks, its status, its handoff notes, its profile.

func init() {
	Register(Tool{Name: "ask", Order: 10, Description: "Ask the humans of a conversation to decide: a question, your recommendation with the reason, and one to four alternatives with their reasons. It may carry an app.",
		InputSchema: object([]string{"conversation", "question", "recommended", "alternatives"}, props{
			"conversation": conv(),
			"question":     props{"type": "string", "minLength": 1, "maxLength": 500, "description": "What you ask."},
			"recommended":  option("The answer you recommend and why."),
			"alternatives": list("The other answers worth choosing, each with its reason.", option("An alternative and why."), 1, 4),
			"urgent":       boolean("The owner sees the ask first."),
			"thread":       integer("Ask in the thread of this main message.", 1, 1<<53-1),
			"app":          appSchema(),
		}),
		Call: func(ctx context.Context, args json.RawMessage) (any, error) {
			var a struct {
				Conversation int64               `json:"conversation"`
				Question     string              `json:"question"`
				Recommended  map[string]string   `json:"recommended"`
				Alternatives []map[string]string `json:"alternatives"`
				Urgent       bool                `json:"urgent"`
				Thread       int64               `json:"thread"`
				App          json.RawMessage     `json:"app"`
			}
			if err := decodeArgs(args, &a); err != nil {
				return nil, err
			}
			return withApp(a.App, func(file string) (Output, error) {
				argv := []string{"--question", a.Question, "--recommend", a.Recommended["label"], "--why", a.Recommended["why"]}
				for _, alt := range a.Alternatives {
					argv = append(argv, "--alt", alt["label"], "--alt-why", alt["why"])
				}
				argv = withFlag(withFlag(withFlag(argv, "urgent", a.Urgent), "thread", a.Thread), "app", file)
				return runnerOf(ctx).run("ask", "", append(argv, strconv.FormatInt(a.Conversation, 10))...)
			})
		}})

	Register(Tool{Name: "status", Order: 11, Description: "Say what you are doing now and next. The owner sees it in Crew.",
		InputSchema: object([]string{"state"}, props{
			"state": oneOf("Where you stand.", "idle", "working", "blocked", "waiting"),
			"doing": props{"type": "string", "maxLength": 200, "description": "What you are doing now."},
			"next":  props{"type": "string", "maxLength": 200, "description": "What you do next."},
		}),
		Call: func(ctx context.Context, args json.RawMessage) (any, error) {
			var a struct{ State, Doing, Next string }
			if err := decodeArgs(args, &a); err != nil {
				return nil, err
			}
			return runnerOf(ctx).run("status", "", withFlag(withFlag(withFlag(nil, "state", a.State), "doing", a.Doing), "next", a.Next)...)
		}})

	Register(Tool{Name: "handoff", Order: 12, Description: "Leave a note for your next session (at most 4096 bytes), or list the notes kept.",
		InputSchema: object(nil, props{
			"note": props{"type": "string", "minLength": 1, "description": "The note, at most 4096 bytes. Leave it out to list the notes."},
			"list": boolean("List the notes kept, newest first."),
		}),
		Call: func(ctx context.Context, args json.RawMessage) (any, error) {
			var a struct {
				Note string `json:"note"`
				List bool   `json:"list"`
			}
			if err := decodeArgs(args, &a); err != nil {
				return nil, err
			}
			if a.List || a.Note == "" {
				return runnerOf(ctx).run("handoff", "", "--list")
			}
			return runnerOf(ctx).run("handoff", a.Note, "-")
		}})

	Register(Tool{Name: "profile", Order: 13, Description: "Show your profile, or change it (once an hour). The handle never changes.",
		InputSchema: object(nil, props{
			"display_name": props{"type": "string", "minLength": 1, "maxLength": 80, "description": "The name people see next to your handle."},
			"description":  props{"type": "string", "maxLength": 80, "description": "What you do, in one line."},
			"capabilities": list("What you can do, one word or phrase each.", props{"type": "string", "minLength": 1, "maxLength": 40}, 0, 20),
		}),
		Call: func(ctx context.Context, args json.RawMessage) (any, error) {
			var a struct {
				DisplayName  *string   `json:"display_name"`
				Description  *string   `json:"description"`
				Capabilities *[]string `json:"capabilities"`
			}
			if err := decodeArgs(args, &a); err != nil {
				return nil, err
			}
			var set []string
			if a.DisplayName != nil {
				set = append(set, "name="+*a.DisplayName)
			}
			if a.Description != nil {
				set = append(set, "description="+*a.Description)
			}
			if a.Capabilities != nil {
				set = append(set, "capabilities="+strings.Join(*a.Capabilities, ","))
			}
			if len(set) == 0 {
				return runnerOf(ctx).run("profile", "")
			}
			return runnerOf(ctx).run("profile", "", append([]string{"--set"}, set...)...)
		}})
}

func option(desc string) props {
	return props{
		"type": "object", "description": desc, "required": []string{"label", "why"}, "additionalProperties": false,
		"properties": props{
			"label": props{"type": "string", "minLength": 1, "maxLength": 120, "description": "The answer, short."},
			"why":   props{"type": "string", "minLength": 1, "maxLength": 280, "description": "The reason for it."},
		},
	}
}
