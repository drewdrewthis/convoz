package mcp

import (
	"context"
	"encoding/json"
	"strconv"
)

func init() {
	Register(Tool{Name: "rename", Order: 16, Description: "Give a conversation you are in a new title. Refused when the owner chose the title; at most 3 renames an hour.",
		InputSchema: object([]string{"conversation", "title"}, props{
			"conversation": conv(),
			"title":        props{"type": "string", "minLength": 1, "maxLength": 120, "description": "The new title, 1 to 120 characters on one line."},
		}),
		Call: func(ctx context.Context, args json.RawMessage) (any, error) {
			var a struct {
				Conversation int64  `json:"conversation"`
				Title        string `json:"title"`
			}
			if err := decodeArgs(args, &a); err != nil {
				return nil, err
			}
			// The title goes on standard input, so a title that starts with "-" is never read as a flag.
			return runnerOf(ctx).run("rename", a.Title, strconv.FormatInt(a.Conversation, 10), "-")
		}})
}
