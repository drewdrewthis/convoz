package mcp

import (
	"context"
	"encoding/json"
)

func init() {
	Register(Tool{Name: "agents", Order: 21, Description: "List the other active agents you can bring into a conversation: handle, display name, one-line description and state. Use a handle with the new tool's with list.",
		InputSchema: object(nil, props{}),
		Call: func(ctx context.Context, _ json.RawMessage) (any, error) {
			return runnerOf(ctx).run("agents", "")
		}})
}
