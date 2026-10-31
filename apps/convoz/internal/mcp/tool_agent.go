package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"strings"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

// The tools that say something about the agent itself: its asks, its status, its handoff notes, its profile.

func init() {
	Register(Tool{Name: "ask", Order: 10, Description: "Ask permission for one action you are confident in: action, risk, undo or one_way, 1-3 considered ways (why worse), confidence (self-reported; under 80 is refused). Owner answers Go, or Not this with a reason. Owner's-name text: give draft.",
		InputSchema: object([]string{}, props{
			"conversation": conv(),
			// Not in "required": a permission ask needs no question (it shows the action) and no owners_call.
			"action":     props{"type": "string", "minLength": 1, "maxLength": wire.MaxAction, "description": "What you will do, naming the object: \"Merge PR 415 into main\"."},
			"risk":       props{"type": "string", "minLength": 1, "maxLength": wire.MaxRisk, "description": "With action: what can go wrong."},
			"undo":       props{"type": "string", "minLength": 1, "maxLength": wire.MaxUndo, "description": "With action: how to undo it. Leave it out and give one_way when it cannot be undone."},
			"one_way":    boolean("With action: it cannot be undone."),
			"considered": list("With action: the other ways you considered, each with why it is worse.", props{"type": "string", "minLength": 1, "maxLength": wire.MaxConsideredLine}, 1, wire.MaxConsidered),
			// No minimum of 80 in the schema: a lower one must reach the tool, which answers with the get-confident text.
			"confidence": integer("With action: how sure you are that this is the right action, 0 to 100. Under 80 is refused.", 0, 100),
			"question":   props{"type": "string", "minLength": 1, "maxLength": 500, "description": "What you ask: one plain sentence that tells the owner what to decide (3 or more words, no markdown, no status word first); a permission ask shows its action when left out."},
			// Not in "required": a draft ask has neither (draft is given instead), and a choice ask without them is refused by the tool.
			"recommended":  option("The answer you recommend and why."),
			"alternatives": list("The other answers worth choosing, each with its reason.", option("An alternative and why."), 1, 4),
			"draft":        draftSchema(),
			// Not in "required" on purpose: a missing one must reach the tool, which answers with the decide-yourself text.
			"owners_call": ownersCall(),
			"urgent":      boolean("The owner sees the ask first."),
			"thread":      integer("Ask in the thread of this main message.", 1, 1<<53-1),
			"update":      integer("Update this open ask of yours in place instead of asking a new one, after the owner's questions in its thread. Give what changed (question, recommended and alternatives together, owners_call.reason) and answers.", 1, 1<<53-1),
			"answers":     props{"type": "string", "maxLength": 1000, "description": "With update: a short summary of your answers to the owner's questions. Required once the owner replied in the ask's thread."},
			"app":         appSchema(),
		}),
		Call: func(ctx context.Context, args json.RawMessage) (any, error) {
			var a struct {
				Conversation int64               `json:"conversation"`
				Question     string              `json:"question"`
				Draft        *wire.AskDraft      `json:"draft"`
				Recommended  map[string]string   `json:"recommended"`
				Alternatives []map[string]string `json:"alternatives"`
				OwnersCall   wire.OwnersCall     `json:"owners_call"`
				Urgent       bool                `json:"urgent"`
				Thread       int64               `json:"thread"`
				Update       int64               `json:"update"`
				Answers      string              `json:"answers"`
				App          json.RawMessage     `json:"app"`
				Action       string              `json:"action"`
				Risk         string              `json:"risk"`
				Undo         string              `json:"undo"`
				OneWay       bool                `json:"one_way"`
				Considered   []string            `json:"considered"`
				Confidence   int                 `json:"confidence"`
			}
			if err := decodeArgs(args, &a); err != nil {
				return nil, err
			}
			if a.Update > 0 {
				argv := withFlag(withFlag(withFlag([]string{}, "update", a.Update), "question", a.Question), "answers", a.Answers)
				if r := a.Recommended; r != nil {
					argv = append(argv, "--recommend", r["label"], "--why", r["why"])
					for _, alt := range a.Alternatives {
						argv = append(argv, "--alt", alt["label"], "--alt-why", alt["why"])
					}
				}
				argv = withFlag(argv, "owners-call-why", a.OwnersCall.Reason)
				if a.Action != "" {
					argv = permissionFlags(argv, a.Action, a.Risk, a.Undo, a.OneWay, a.Considered)
				}
				return runnerOf(ctx).run("ask", "", argv...)
			}
			if a.Action != "" {
				if a.Confidence < wire.MinConfidence {
					return nil, Failed{wire.GetConfidentFirst}
				}
				if a.Conversation == 0 {
					return nil, Failed{"An ask needs conversation; to change an ask you already sent, give update."}
				}
			} else if a.Conversation == 0 || a.Question == "" {
				return nil, Failed{"An ask needs conversation and action (or the legacy question); to change an ask you already sent, give update."}
			}
			if a.Draft == nil && a.Action == "" {
				if problem := a.OwnersCall.Problem(); problem != "" {
					return nil, Failed{problem}
				}
			}
			return withApp(a.App, func(file string) (Output, error) {
				argv := withFlag(nil, "question", a.Question)
				if a.Action != "" {
					argv = withFlag(permissionFlags(argv, a.Action, a.Risk, a.Undo, a.OneWay, a.Considered), "confidence", a.Confidence)
				} else if d := a.Draft; d != nil {
					argv = append(argv, "--draft", d.Text)
					argv = withFlag(withFlag(argv, "original", d.Original), "original-from", d.OriginalFrom)
				} else {
					argv = append(argv, "--recommend", a.Recommended["label"], "--why", a.Recommended["why"], "--owners-call", a.OwnersCall.Kind, "--owners-call-why", a.OwnersCall.Reason)
					for _, alt := range a.Alternatives {
						argv = append(argv, "--alt", alt["label"], "--alt-why", alt["why"])
					}
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
			"doing": props{"description": "What you do now: a list of up to 3 items when you work in parallel, each {text, eta?, step?}. A single text (with step and eta below) also works.",
				"oneOf": []props{
					{"type": "string", "maxLength": 200},
					list("", props{"type": "object", "required": []string{"text"}, "additionalProperties": false, "properties": props{
						"text": props{"type": "string", "minLength": 1, "maxLength": 200},
						"step": props{"type": "string", "pattern": "^[1-9][0-9]?/[1-9][0-9]?$", "description": "The step of this item, as N/M."},
						"eta":  props{"type": "string", "maxLength": 20, "description": "When this item should be done: a duration (30m, 1h30m) or HH:MM on this machine's clock."},
					}}, 1, 3),
				}},
			"step":    props{"type": "string", "pattern": "^[1-9][0-9]?/[1-9][0-9]?$", "description": "The step of a single doing text, as N/M."},
			"eta":     props{"type": "string", "maxLength": 20, "description": "When a single doing text should be done: a duration (30m, 1h30m) or HH:MM on this machine's clock."},
			"blocked": props{"type": "string", "maxLength": 200, "description": "What blocks you here (not the owner: use waiting)."},
			"next":    list("What you do next, in order.", props{"type": "string", "minLength": 1, "maxLength": 200}, 0, 5),
			"waiting": list("What only the owner must do, as one plain sentence that tells the owner what to do, like \"Approve the prod deploy of PR 240.\" (3 or more words, no markdown, no status word first, no name prefix); something new pushes the owner.", props{"type": "string", "minLength": 1, "maxLength": 200}, 0, 5),
			"done":    list("Items you finished since your last plan. A done text equal to a deliver text ships that delivery.", props{"type": "string", "minLength": 1, "maxLength": 200}, 0, 5),
			"deliver": list("What you promise to deliver and by when; kept across plans, a new due moves it.", props{"type": "object", "required": []string{"what", "due"}, "additionalProperties": false, "properties": props{
				"what": props{"type": "string", "minLength": 1, "maxLength": 200},
				"due":  props{"type": "string", "maxLength": 20, "description": "A duration (2d, 3h) or HH:MM on this machine's clock."},
			}}, 0, 5),
		}),
		Call: func(ctx context.Context, args json.RawMessage) (any, error) {
			var a struct {
				Conversation        int64
				Doing               json.RawMessage
				Step, ETA, Blocked  string
				Next, Waiting, Done []string
				Deliver             []struct{ What, Due string }
			}
			if err := decodeArgs(args, &a); err != nil {
				return nil, err
			}
			// a list is each item's --doing, --step, --eta in turn (the CLI reads a --step or --eta as the --doing before it)
			var items []struct{ Text, Step, ETA string }
			var one string
			if json.Unmarshal(a.Doing, &items) != nil {
				if err := json.Unmarshal(a.Doing, &one); err != nil && len(a.Doing) > 0 && string(a.Doing) != "null" {
					return nil, errors.New("doing is a text or a list of up to 3 items, each {text, eta, step}")
				}
				items = []struct{ Text, Step, ETA string }{{one, a.Step, a.ETA}}
			}
			var argv []string
			for _, it := range items {
				argv = withFlag(withFlag(withFlag(argv, "doing", it.Text), "step", it.Step), "eta", it.ETA)
			}
			for _, dv := range a.Deliver {
				argv = withFlag(withFlag(argv, "deliver", dv.What), "due", dv.Due)
			}
			argv = withFlag(argv, "blocked", a.Blocked)
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

	Register(Tool{Name: "profile", Order: 13, Description: "Show your profile, or change it (once an hour). A new handle applies at once, with no approval; your old handle keeps working for 30 days. Your avatar changes at any time.",
		InputSchema: object(nil, props{
			"display_name": props{"type": "string", "minLength": 1, "maxLength": 80, "description": "The name people see next to your handle."},
			"description":  props{"type": "string", "maxLength": 80, "description": "What you do, in one line."},
			"capabilities": list("What you can do, one word or phrase each.", props{"type": "string", "minLength": 1, "maxLength": 40}, 0, 20),
			"handle":       props{"type": "string", "minLength": 2, "maxLength": 41, "description": "Your new handle, at once (3 changes a day at most)."},
			"avatar":       props{"type": "string", "minLength": 1, "description": "Path to a simple SVG file (up to 4 KB) for your picture; changes at any time."},
		}),
		Call: func(ctx context.Context, args json.RawMessage) (any, error) {
			var a struct {
				DisplayName  *string   `json:"display_name"`
				Description  *string   `json:"description"`
				Capabilities *[]string `json:"capabilities"`
				Handle       *string   `json:"handle"`
				Avatar       *string   `json:"avatar"`
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
			if a.Avatar != nil {
				set = append(set, "avatar="+*a.Avatar)
			}
			if len(set) == 0 {
				return runnerOf(ctx).run("profile", "")
			}
			return runnerOf(ctx).run("profile", "", append([]string{"--set"}, set...)...)
		}})
}

// permissionFlags adds the parts of a permission ask to argv as the CLI's flags; the confidence is added by the caller, as an update leaves it out.
func permissionFlags(argv []string, action, risk, undo string, oneWay bool, considered []string) []string {
	argv = withFlag(withFlag(withFlag(withFlag(argv, "action", action), "risk", risk), "undo", undo), "one-way", oneWay)
	for _, c := range considered {
		argv = append(argv, "--considered", c)
	}
	return argv
}

// draftSchema is the draft of a draft ask: a message the agent wants to send in the owner's name.
func draftSchema() props {
	return props{
		"type": "object", "description": "A message you want to send in the owner's name. The owner reads it, edits it and taps Send or Don't send. Give this instead of recommended, alternatives and owners_call.", "required": []string{"text"}, "additionalProperties": false,
		"properties": props{
			"text":          props{"type": "string", "minLength": 1, "maxLength": wire.MaxDraft, "description": "The draft, as you would send it."},
			"original":      props{"type": "string", "maxLength": wire.MaxOriginal, "description": "The message you answer; cut with … when longer than 2000 characters."},
			"original_from": props{"type": "string", "maxLength": wire.MaxOriginalFrom, "description": "Who sent the original and where, like \"Alex · Slack DM\"."},
		},
	}
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
