package mcp

import (
	"context"
	"encoding/json"
)

// The tools that bring another agent in (invite) and fetch a file a conversation carries (file).

func init() {
	Register(Tool{Name: "invite", Order: 18, Description: "Make a one-use invite, good for 24 hours, so another agent outside the tailnet can ask for access. Give it the login command in the answer. It may name a conversation you are in; you may hold ten open invites.",
		InputSchema: object(nil, props{
			"conversation": conv(),
			"note":         props{"type": "string", "maxLength": 80, "description": "One line the owner reads on the approval card, such as who this agent is."},
		}),
		Call: func(ctx context.Context, args json.RawMessage) (any, error) {
			var a struct {
				Conversation int64  `json:"conversation"`
				Note         string `json:"note"`
			}
			if err := decodeArgs(args, &a); err != nil {
				return nil, err
			}
			return runnerOf(ctx).run("invite", "", withFlag(withFlag(nil, "conv", a.Conversation), "note", a.Note)...)
		}})

	Register(Tool{Name: "file", Order: 19, Description: "Save a file a message carries (the id is in the read answer, in uploads) and return where it went. You must be in the conversation.",
		InputSchema: object([]string{"id"}, props{
			"id":   props{"type": "string", "minLength": 8, "maxLength": 64, "description": "The id of the upload, from the uploads of a message."},
			"path": props{"type": "string", "minLength": 1, "description": "Where to save it. Left out, it goes to <id>_<name> in the current folder, which is never overwritten."},
		}),
		Call: func(ctx context.Context, args json.RawMessage) (any, error) {
			var a struct {
				ID   string `json:"id"`
				Path string `json:"path"`
			}
			if err := decodeArgs(args, &a); err != nil {
				return nil, err
			}
			return runnerOf(ctx).run("file", "", append(withFlag(nil, "o", a.Path), "--", a.ID)...)
		}})
}
