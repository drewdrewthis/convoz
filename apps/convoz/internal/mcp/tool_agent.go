package mcp

import (
	"context"
	"encoding/json"
	"strconv"
	"strings"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

// The tools that say something about the agent itself: its asks, its status, its handoff notes, its profile.

func init() {
	Register(Tool{Name: "ask", Order: 10, Description: "Ask the owner to decide: a question, your recommendation and 1 to 4 alternatives, each with a reason, and owners_call (why only the owner can decide). Without owners_call the ask is refused: decide it yourself.",
		InputSchema: object([]string{"conversation", "question", "recommended", "alternatives"}, props{
			"conversation": conv(),
			"question":     props{"type": "string", "minLength": 1, "maxLength": 500, "description": "What you ask."},
			"recommended":  option("The answer you recommend and why."),
			"alternatives": list("The other answers worth choosing, each with its reason.", option("An alternative and why."), 1, 4),
			// Not in "required" on purpose: a missing one must reach the tool, which answers with the decide-yourself text.
			"owners_call": ownersCall(),
			"urgent":      boolean("The owner sees the ask first."),
			"thread":      integer("Ask in the thread of this main message.", 1, 1<<53-1),
			"app":         appSchema(),
		}),
		Call: func(ctx context.Context, args json.RawMessage) (any, error) {
			var a struct {
				Conversation int64               `json:"conversation"`
				Question     string              `json:"question"`
				Recommended  map[string]string   `json:"recommended"`
				Alternatives []map[string]string `json:"alternatives"`
				OwnersCall   wire.OwnersCall     `json:"owners_call"`
				Urgent       bool                `json:"urgent"`
				Thread       int64               `json:"thread"`
				App          json.RawMessage     `json:"app"`
			}
			if err := decodeArgs(args, &a); err != nil {
				return nil, err
			}
			if problem := a.OwnersCall.Problem(); problem != "" {
				return nil, Failed{problem}
			}
			return withApp(a.App, func(file string) (Output, error) {
				argv := []string{"--question", a.Question, "--recommend", a.Recommended["label"], "--why", a.Recommended["why"]}
				argv = append(argv, "--owners-call", a.OwnersCall.Kind, "--owners-call-why", a.OwnersCall.Reason)
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

	Register(Tool{Name: "plan", Order: 11, Description: "Replace your plan in one conversation: what you do now, next, what waits on the owner, what you finished.",
		InputSchema: object([]string{"conversation"}, props{
			"conversation": conv(),
			"doing":        props{"type": "string", "maxLength": 200, "description": "What you do now (one item)."},
			"step":         props{"type": "string", "pattern": "^[1-9][0-9]?/[1-9][0-9]?$", "description": "The step of the doing item, as N/M."},
			"eta":          props{"type": "string", "maxLength": 20, "description": "When the doing item should be done: a duration (30m, 1h30m) or HH:MM on this machine's clock."},
			"blocked":      props{"type": "string", "maxLength": 200, "description": "What blocks you here (not the owner: use waiting)."},
			"next":         list("What you do next, in order.", props{"type": "string", "minLength": 1, "maxLength": 200}, 0, 5),
			"waiting":      list("What waits on the owner; something new pushes the owner.", props{"type": "string", "minLength": 1, "maxLength": 200}, 0, 5),
			"done":         list("Items you finished since your last plan.", props{"type": "string", "minLength": 1, "maxLength": 200}, 0, 5),
		}),
		Call: func(ctx context.Context, args json.RawMessage) (any, error) {
			var a struct {
				Conversation              int64
				Doing, Step, ETA, Blocked string
				Next, Waiting, Done       []string
			}
			if err := decodeArgs(args, &a); err != nil {
				return nil, err
			}
			argv := withFlag(withFlag(withFlag(withFlag(nil, "doing", a.Doing), "step", a.Step), "eta", a.ETA), "blocked", a.Blocked)
			for _, kind := range []struct {
				name  string
				items []string
			}{{"next", a.Next}, {"waiting", a.Waiting}, {"done", a.Done}} {
				for _, it := range kind.items {
					argv = append(argv, "--"+kind.name, it)
				}
			}
			return runnerOf(ctx).run("plan", "", append(argv, strconv.FormatInt(a.Conversation, 10))...)
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

	Register(Tool{Name: "profile", Order: 13, Description: "Show your profile, or change it (once an hour). A new handle applies at once, with no approval; your old handle keeps working for 30 days.",
		InputSchema: object(nil, props{
			"display_name": props{"type": "string", "minLength": 1, "maxLength": 80, "description": "The name people see next to your handle."},
			"description":  props{"type": "string", "maxLength": 80, "description": "What you do, in one line."},
			"capabilities": list("What you can do, one word or phrase each.", props{"type": "string", "minLength": 1, "maxLength": 40}, 0, 20),
			"handle":       props{"type": "string", "minLength": 2, "maxLength": 41, "description": "Your new handle, at once (3 changes a day at most)."},
		}),
		Call: func(ctx context.Context, args json.RawMessage) (any, error) {
			var a struct {
				DisplayName  *string   `json:"display_name"`
				Description  *string   `json:"description"`
				Capabilities *[]string `json:"capabilities"`
				Handle       *string   `json:"handle"`
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
			if a.Handle != nil {
				set = append(set, "handle="+*a.Handle)
			}
			if len(set) == 0 {
				return runnerOf(ctx).run("profile", "")
			}
			return runnerOf(ctx).run("profile", "", append([]string{"--set"}, set...)...)
		}})
}

// ownersCall is why only the owner can decide the ask.
func ownersCall() props {
	return props{
		"type": "object", "description": "Why only the owner can decide this. Without it the ask is refused: decide it yourself.", "required": []string{"kind", "reason"}, "additionalProperties": false,
		"properties": props{
			"kind":   oneOf("A one-way door, a taste choice, a values choice, or scope the owner must own.", wire.OwnersCallKinds...),
			"reason": props{"type": "string", "minLength": 1, "maxLength": wire.MaxOwnersCallReason, "description": "Why it is the owner's call, in one line the ask card shows."},
		},
	}
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
